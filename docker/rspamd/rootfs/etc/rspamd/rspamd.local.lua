local lua_redis = require 'lua_redis'
local redis_params = lua_redis.parse_redis_server('postarix')

-- Mail Cyrus sends by itself (Sieve redirect and vacation replies) comes in on
-- Postfix's port 10588, whose milter daemon name (MTA-Name to Rspamd) is CYRUS
-- (only Cyrus can log in there).
local function is_cyrus(task)
  local tag = task:get_request_header('MTA-Name')
  return tag ~= nil and tostring(tag) == 'CYRUS'
end


-- Postarix: authenticated (submission) mail must carry exactly one From
-- address, equal to the envelope sender. Postfix already checks that the
-- envelope sender belongs to the logged-in user (reject_sender_login_mismatch),
-- so this extends the same ownership check to the visible From header, and
-- DKIM/ARC signing (use_domain = "header") can only ever sign a domain the
-- user is allowed to send for.

local function reject(task, reason)
  task:insert_result('POSTARIX_FROM_NOT_OWNED', 1.0, reason)
  task:set_pre_result('reject', 'From header must match your sending address (' .. reason .. ')', 'postarix')
end

rspamd_config:register_symbol({
  name = 'POSTARIX_FROM_NOT_OWNED',
  type = 'prefilter',
  priority = 10,
  callback = function(task)
    if not task:get_user() or is_cyrus(task) then
      return
    end

    local envelope = task:get_from('smtp')
    local envelope_addr = envelope and envelope[1] and envelope[1].addr or ''
    if envelope_addr == '' then
      return reject(task, 'empty envelope sender')
    end

    local headers = task:get_header_full('From') or {}
    if #headers ~= 1 then
      return reject(task, 'expected exactly one From header')
    end

    local from = task:get_from('mime')
    if not from or #from ~= 1 or not from[1].addr or from[1].addr == '' then
      return reject(task, 'expected exactly one From address')
    end

    if string.lower(from[1].addr) ~= string.lower(envelope_addr) then
      return reject(task, 'From differs from envelope sender')
    end
  end,
})

-- Postarix: incoming mail the filter marks as spam (but does not reject) is
-- filed in the recipient's Junk folder. Each recipient becomes user+Junk@domain;
-- Postfix keeps the extension on the way to Cyrus, which delivers "+Junk" into
-- that folder (falling back to the inbox if it cannot).
local SPAM_ACTIONS = { ['add header'] = true, ['rewrite subject'] = true }

rspamd_config:register_symbol({
  name = 'POSTARIX_FILE_AS_JUNK',
  type = 'postfilter',
  priority = 5,
  -- Also when an earlier rule decided the action outright (e.g. GTUBE).
  flags = 'ignore_passthrough',
  callback = function(task)
    -- Only mail received over SMTP without logging in: Postfix accepts that
    -- for hosted domains only (it never relays it). Mail Postfix produced
    -- itself (bounces, local submissions) arrives without a HELO and may be
    -- addressed anywhere, so it is left alone.
    if task:get_user() or not task:get_helo() then
      return
    end
    local action = task:get_metric_action('default')
    if not SPAM_ACTIONS[action] then
      return
    end
    local recipients = task:get_recipients('smtp') or {}
    local remove, add = {}, {}
    for _, rcpt in ipairs(recipients) do
      local user, domain = rcpt.user or '', rcpt.domain or ''
      -- A bounce to a forwarding (SRS) address is relayed to the original
      -- sender elsewhere: spam there is refused, never filed or passed on.
      if user:lower():match('^srs[01][=+-]') then
        task:set_pre_result('reject', 'Spam is not accepted for forwarding addresses', 'postarix')
        task:insert_result('POSTARIX_FILE_AS_JUNK', 1.0, 'srs refused')
        return
      end
      if user ~= '' and domain ~= '' then
        local base = user:gsub('%+.*$', '')
        table.insert(remove, rcpt.addr)
        table.insert(add, base .. '+Junk@' .. domain)
      end
    end
    if #add > 0 then
      task:set_milter_reply({ del_rcpt = remove, add_rcpt = add })
      task:insert_result('POSTARIX_FILE_AS_JUNK', 1.0)
    end
  end,
})

rspamd_config:set_metric_symbol({ name = 'POSTARIX_FILE_AS_JUNK', score = 0.0, description = 'Spam filed in the Junk folder' })


-- Hosted (active) domains, published by the API in this Valkey set.
local HOSTED_SET = 'POSTARIX_DOMAINS'

local function base_address(user, domain)
  return string.lower((user or ''):gsub('%+.*$', '') .. '@' .. (domain or ''))
end

local function message_id(value)
  if not value then
    return nil
  end
  local id = tostring(value):match('<([^>]+)>') or tostring(value)
  id = string.lower(id:gsub('%s', ''))
  if id == '' or #id > 250 then
    return nil
  end
  return id
end

-- Mail our own users send (logged in, on 587/465 or from the webmail),
-- remembered by Message-ID with its From address for two days: a Sieve
-- redirect of it is known to carry a genuine hosted sender.
local LOCAL_KEY = 'POSTARIX_LOCAL:'

rspamd_config:register_symbol({
  name = 'POSTARIX_REMEMBER_LOCAL',
  type = 'postfilter',
  priority = 1,
  callback = function(task)
    if not redis_params or not task:get_user() or is_cyrus(task) then
      return
    end
    if task:get_metric_action('default') == 'reject' then
      return
    end
    local id = message_id(task:get_header('Message-ID'))
    local from = task:get_from('mime')
    if not id or not from or #from ~= 1 or not from[1].addr then
      return
    end
    lua_redis.redis_make_request(task, redis_params, LOCAL_KEY .. id, true, function() end,
      'SET', { LOCAL_KEY .. id, string.lower(from[1].addr), 'EX', '172800' })
  end,
})

local function header_count(task, name)
  return #(task:get_header_full(name) or {})
end

-- Postarix: what Cyrus may send, and what may be DKIM/ARC-signed. Cyrus logs
-- in with one account for every mailbox; Postfix names the mailbox whose
-- Sieve script is sending in X-Postarix-Sieve-Owner, the topmost header
-- (from the MAIL FROM AUTH= parameter Cyrus sets; see postarix-sieve-owner).
-- It is removed before the message leaves.
--  * Vacation replies (exactly one X-Sieve-Action: vacation, Auto-Submitted:
--    auto-replied, null envelope) must come from the owner's own address, and
--    are then signed with its domain.
--  * Redirects (exactly one X-Sieve-Action: redirect, non-null envelope;
--    Postfix gives them an SRS envelope sender on the server's name) are never
--    signed, are limited per mailbox, and are refused for spam or for a hosted
--    From that is neither DKIM-signed by that domain nor known to have been
--    sent by our users (POSTARIX_CYRUS_REDIRECT).
--  * Anything else is refused.
local OWNER_HEADER = 'X-Postarix-Sieve-Owner'
local REDIRECT_KEY = 'POSTARIX_REDIRECTS:'
local REDIRECTS_PER_HOUR = 100
-- Vacation replies go to whoever wrote, so forged senders could turn a
-- mailbox into a backscatter source: they are capped per mailbox too.
local VACATION_KEY = 'POSTARIX_VACATIONS:'
local VACATIONS_PER_HOUR = 200

-- Counts one message for a mailbox in an hourly window; calls done(true)
-- while under the limit, done(false) over it, done(nil) when Valkey fails.
local function count_hourly(task, key, limit, done)
  lua_redis.redis_make_request(task, redis_params, key, true, function(err, count)
    if err or not tonumber(count) then
      return done(nil)
    end
    if tonumber(count) == 1 then
      lua_redis.redis_make_request(task, redis_params, key, true, function() end, 'EXPIRE', { key, '3600' })
    end
    done(tonumber(count) <= limit)
  end, 'INCR', { key })
end

local function cyrus_reject(task, reason)
  task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'refused: ' .. reason)
  task:set_pre_result('reject', 'Not sent: ' .. reason, 'postarix')
end

local function sieve_owner(task)
  local headers = task:get_header_full(OWNER_HEADER) or {}
  if #headers ~= 1 or headers[1].order ~= 0 then
    return nil
  end
  local owner = string.lower(tostring(headers[1].value or ''):gsub('^%s+', ''):gsub('%s+$', ''))
  if not owner:match('^[^%s<>@"]+@[%w.-]+$') then
    return nil
  end
  return owner
end

rspamd_config:register_symbol({
  name = 'POSTARIX_CYRUS_SENT',
  type = 'prefilter',
  priority = 10,
  callback = function(task)
    if not is_cyrus(task) then
      return
    end
    local pool = task:get_mempool()
    pool:set_variable('postarix_cyrus', '1')
    task:set_milter_reply({ remove_headers = { [OWNER_HEADER] = 0 } })
    local owner = sieve_owner(task)
    if not owner then
      return cyrus_reject(task, 'the sending mailbox is unknown')
    end
    if header_count(task, 'X-Sieve-Action') ~= 1 then
      return cyrus_reject(task, 'Cyrus may only send vacation replies and redirects')
    end
    local action = tostring(task:get_header('X-Sieve-Action') or '')
    local envelope = task:get_from('smtp')
    local envelope_addr = envelope and envelope[1] and envelope[1].addr or ''

    if action == 'redirect' and envelope_addr ~= '' then
      if not redis_params then
        return cyrus_reject(task, 'cannot count forwarded messages')
      end
      count_hourly(task, REDIRECT_KEY .. owner, REDIRECTS_PER_HOUR, function(ok)
        if ok == nil then
          return cyrus_reject(task, 'cannot count forwarded messages')
        end
        if not ok then
          return cyrus_reject(task, 'too many forwarded messages from this mailbox; try again later')
        end
        pool:set_variable('postarix_cyrus_redirect', '1')
        task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'redirect')
      end)
      return
    end
    if action ~= 'vacation' or envelope_addr ~= '' then
      return cyrus_reject(task, 'Cyrus may only send vacation replies and redirects')
    end
    if not tostring(task:get_header('Auto-Submitted') or ''):lower():match('^%s*auto%-replied') then
      return cyrus_reject(task, 'a vacation reply must be marked Auto-Submitted')
    end
    local from = task:get_from('mime')
    if not from or #from ~= 1 or not from[1].domain or from[1].domain == '' or header_count(task, 'From') ~= 1 then
      return cyrus_reject(task, 'a vacation reply needs exactly one From address')
    end
    if base_address(from[1].user, from[1].domain) ~= owner then
      return cyrus_reject(task, 'a vacation reply must come from your own address')
    end
    if not redis_params then
      return cyrus_reject(task, 'cannot count vacation replies')
    end
    count_hourly(task, VACATION_KEY .. owner, VACATIONS_PER_HOUR, function(ok)
      if ok == nil then
        return cyrus_reject(task, 'cannot count vacation replies')
      end
      if not ok then
        return cyrus_reject(task, 'too many vacation replies from this mailbox; try again later')
      end
      pool:set_variable('postarix_cyrus_sign', '1')
      task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'vacation')
    end)
  end,
})

-- Redirects, once the message has been scored and its signatures checked.
rspamd_config:register_symbol({
  name = 'POSTARIX_CYRUS_REDIRECT',
  type = 'postfilter',
  priority = 9,
  flags = 'ignore_passthrough',
  callback = function(task)
    if task:get_mempool():get_variable('postarix_cyrus_redirect') ~= '1' then
      return
    end
    local action = task:get_metric_action('default')
    if SPAM_ACTIONS[action] or action == 'reject' then
      return cyrus_reject(task, 'spam is not forwarded')
    end
    local from = task:get_from('mime')
    if not from or #from ~= 1 or not from[1].domain or from[1].domain == '' then
      return cyrus_reject(task, 'a forwarded message needs exactly one From address')
    end
    local from_domain = string.lower(from[1].domain)
    local signed = false
    local dkim = task:get_symbol('R_DKIM_ALLOW')
    if dkim and dkim[1] and dkim[1].options then
      for _, option in ipairs(dkim[1].options) do
        if string.lower(tostring(option)):match('^([^:]+)') == from_domain then
          signed = true
        end
      end
    end
    if signed or not redis_params then
      if not redis_params then
        return cyrus_reject(task, 'cannot check the sender')
      end
      return
    end
    local from_addr = string.lower(from[1].addr or '')
    local id = message_id(task:get_header('Message-ID'))
    lua_redis.redis_make_request(task, redis_params, HOSTED_SET, false, function(err, hosted)
      if err then
        return cyrus_reject(task, 'cannot check the sender')
      end
      if tonumber(hosted) ~= 1 then
        return
      end
      -- A hosted sender: genuine if one of our users sent this very message.
      if not id then
        return cyrus_reject(task, 'the hosted sender of this message is not authenticated')
      end
      lua_redis.redis_make_request(task, redis_params, LOCAL_KEY .. id, false, function(err2, sent_by)
        if err2 or sent_by == nil or type(sent_by) == 'userdata' or tostring(sent_by) ~= from_addr then
          return cyrus_reject(task, 'the hosted sender of this message is not authenticated')
        end
      end, 'GET', { LOCAL_KEY .. id })
    end, 'SISMEMBER', { HOSTED_SET, from_domain })
  end,
})

rspamd_config:set_metric_symbol({ name = 'POSTARIX_CYRUS_SENT', score = 0.0, description = 'Sent by Cyrus (Sieve)' })

local function may_sign(task)
  local pool = task:get_mempool()
  if pool:get_variable('postarix_cyrus') then
    return pool:get_variable('postarix_cyrus_sign') == '1'
  end
  return true
end
rspamd_config:add_condition('DKIM_SIGNED', may_sign)
rspamd_config:add_condition('ARC_SIGNED', may_sign)

-- Postarix: sending rate limits set by organizations (per mailbox, else per
-- domain for each of its mailboxes), published by the API in this hash as
-- "<messages>:<seconds>". Each message a mailbox sends from a mail app counts
-- once, in Valkey counters shared with the API (which applies the same limits
-- to the webmail, so its own submissions are skipped here). Over the limit,
-- the message is refused with a temporary error: the app tries again later.
local RATE_LIMITS_HASH = 'POSTARIX_RATELIMITS'

local function rate_limited(task, reason)
  task:insert_result('POSTARIX_RATELIMIT', 1.0, reason)
  task:set_pre_result('soft reject', 'Sending limit reached (' .. reason .. '); try again later', 'postarix')
end

rspamd_config:register_symbol({
  name = 'POSTARIX_RATELIMIT',
  type = 'prefilter',
  priority = 9,
  callback = function(task)
    local user = task:get_user()
    if not user or not redis_params or is_cyrus(task) then
      return
    end
    user = string.lower(user)
    if user:match('^postarix%-api') then
      return
    end
    local domain = user:match('@([^@]+)$')
    if not domain then
      return
    end
    lua_redis.redis_make_request(task, redis_params, RATE_LIMITS_HASH, false, function(err, data)
      if err or type(data) ~= 'table' then
        return
      end
      local rule = nil
      if type(data[1]) == 'string' then
        rule = data[1]
      elseif type(data[2]) == 'string' then
        rule = data[2]
      end
      if not rule then
        return
      end
      local messages, seconds = rule:match('^(%d+):(%d+)$')
      messages, seconds = tonumber(messages), tonumber(seconds)
      if not messages or not seconds or seconds < 1 then
        return
      end
      local key = string.format('postarix:ratelimit:%s:%d:%d', user, seconds, math.floor(os.time() / seconds))
      lua_redis.redis_make_request(task, redis_params, key, true, function(err2, count)
        if err2 or not tonumber(count) then
          return
        end
        if tonumber(count) == 1 then
          lua_redis.redis_make_request(task, redis_params, key, true, function() end, 'EXPIRE', { key, tostring(seconds) })
        end
        if tonumber(count) > messages then
          rate_limited(task, messages .. ' messages per ' .. seconds .. 's')
        end
      end, 'INCR', { key })
    end, 'HMGET', { RATE_LIMITS_HASH, user, '@' .. domain })
  end,
})

rspamd_config:set_metric_symbol({ name = 'POSTARIX_RATELIMIT', score = 0.0, description = 'Over the sending rate limit' })

-- Postarix: spam thresholds and allow/block lists set per mailbox, per domain
-- and for the whole server, published by the API in Valkey:
--   POSTARIX_SPAM_SCORES: "address" or "@domain" -> "junk:reject" (either may be empty)
--   POSTARIX_SPAM_LISTS:  "address", "@domain" or "*" -> "a:pattern,b:pattern…"
--     (a = allow, b = block; a pattern is an address, "@domain" or "@.domain")
-- A message is scanned once for all its recipients: the first recipient's
-- settings apply (most mail has one).
local SPAM_SCORES_HASH = 'POSTARIX_SPAM_SCORES'
local SPAM_LISTS_HASH = 'POSTARIX_SPAM_LISTS'

local function first_recipient(task)
  local rcpts = task:get_recipients('smtp')
  local rcpt = rcpts and rcpts[1]
  if not rcpt or not rcpt.domain or rcpt.domain == '' then
    return nil
  end
  return base_address(rcpt.user, rcpt.domain), string.lower(rcpt.domain)
end

rspamd_config:register_symbol({
  name = 'POSTARIX_SPAM_SCORES',
  type = 'prefilter',
  priority = 8,
  callback = function(task)
    if task:get_user() or is_cyrus(task) or not redis_params then
      return
    end
    local address, domain = first_recipient(task)
    if not address then
      return
    end
    lua_redis.redis_make_request(task, redis_params, SPAM_SCORES_HASH, false, function(err, data)
      if err or type(data) ~= 'table' then
        return
      end
      local value = type(data[1]) == 'string' and data[1] or (type(data[2]) == 'string' and data[2] or nil)
      if not value then
        return
      end
      local junk, reject = value:match('^([%d.]*):([%d.]*)$')
      junk, reject = tonumber(junk), tonumber(reject)
      if not junk and not reject then
        return
      end
      -- Rspamd applies the action with the highest threshold below the score:
      -- lower thresholds must stay below the reject threshold.
      local defaults = rspamd_config:get_all_actions() or {}
      local reject_at = reject or tonumber(defaults['reject'])
      local junk_at = junk or tonumber(defaults['add header'])
      local actions = {}
      if reject then
        actions['reject'] = reject
      end
      if junk_at and reject_at and junk_at >= reject_at then
        junk_at = reject_at - 0.01
      end
      if junk or junk_at ~= tonumber(defaults['add header']) then
        actions['add header'] = junk_at
        actions['rewrite subject'] = junk_at
      end
      local greylist_at = tonumber(defaults['greylist'])
      if greylist_at and junk_at and greylist_at >= junk_at then
        actions['greylist'] = junk_at - 0.01
      end
      task:set_settings({ actions = actions })
      task:insert_result('POSTARIX_SPAM_SCORES', 1.0, value)
    end, 'HMGET', { SPAM_SCORES_HASH, address, '@' .. domain })
  end,
})

local function pattern_matches(pattern, sender)
  if not sender or sender == '' then
    return false
  end
  local sender_domain = sender:match('@([^@]+)$') or ''
  if pattern:sub(1, 2) == '@.' then
    local parent = pattern:sub(3)
    return sender_domain:sub(-(#parent + 1)) == '.' .. parent
  elseif pattern:sub(1, 1) == '@' then
    return sender_domain == pattern:sub(2)
  end
  return sender == pattern
end

local spam_list_id = rspamd_config:register_symbol({
  name = 'POSTARIX_SPAM_LIST',
  type = 'callback',
  callback = function(task)
    if task:get_user() or is_cyrus(task) or not redis_params then
      return
    end
    local address, domain = first_recipient(task)
    if not address then
      return
    end
    local envelope = task:get_from('smtp')
    local envelope_addr = envelope and envelope[1] and string.lower(envelope[1].addr or '') or ''
    local mime = task:get_from('mime')
    local from_addr = mime and #mime == 1 and string.lower(mime[1].addr or '') or ''
    -- Allowing needs proof the sender is genuine (anyone can write any From):
    -- an envelope sender passing SPF, or a From passing DMARC.
    local spf_ok = task:has_symbol('R_SPF_ALLOW')
    local dmarc_ok = task:has_symbol('DMARC_POLICY_ALLOW')
    lua_redis.redis_make_request(task, redis_params, SPAM_LISTS_HASH, false, function(err, data)
      if err or type(data) ~= 'table' then
        return
      end
      local allowed, blocked = nil, nil
      for i = 1, 3 do
        if type(data[i]) == 'string' then
          for kind, pattern in data[i]:gmatch('([ab]):([^,]+)') do
            local by_envelope = pattern_matches(pattern, envelope_addr)
            local by_from = pattern_matches(pattern, from_addr)
            if kind == 'a' and not allowed and ((by_envelope and spf_ok) or (by_from and dmarc_ok)) then
              allowed = pattern
            elseif kind == 'b' and not blocked and (by_envelope or by_from) then
              blocked = pattern
            end
          end
        end
      end
      if allowed then
        task:insert_result('POSTARIX_ALLOWLIST', 1.0, allowed)
      elseif blocked then
        task:insert_result('POSTARIX_BLOCKLIST', 1.0, blocked)
      end
    end, 'HMGET', { SPAM_LISTS_HASH, address, '@' .. domain, '*' })
  end,
})
rspamd_config:register_symbol({ name = 'POSTARIX_ALLOWLIST', type = 'virtual', parent = spam_list_id })
rspamd_config:register_symbol({ name = 'POSTARIX_BLOCKLIST', type = 'virtual', parent = spam_list_id })
rspamd_config:register_dependency('POSTARIX_SPAM_LIST', 'DMARC_CHECK')
rspamd_config:register_dependency('POSTARIX_SPAM_LIST', 'SPF_CHECK')

rspamd_config:set_metric_symbol({ name = 'POSTARIX_SPAM_SCORES', score = 0.0, description = 'Spam thresholds of the recipient' })
rspamd_config:set_metric_symbol({ name = 'POSTARIX_SPAM_LIST', score = 0.0, description = 'Allow and block lists checked' })
rspamd_config:set_metric_symbol({ name = 'POSTARIX_ALLOWLIST', score = -100.0, description = 'Sender allowed by the recipient' })
rspamd_config:set_metric_symbol({ name = 'POSTARIX_BLOCKLIST', score = 100.0, description = 'Sender blocked by the recipient' })
