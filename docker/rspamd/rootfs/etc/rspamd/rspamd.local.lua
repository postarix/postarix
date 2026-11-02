local lua_redis = require 'lua_redis'
local redis_params = lua_redis.parse_redis_server('postarix')

-- Mail Cyrus sends by itself (Sieve redirect and vacation replies) comes in on
-- Postfix's port 10588, whose milter daemon name (MTA-Name to Rspamd) is CYRUS
-- (only Cyrus can log in there).
local function is_cyrus(task)
  local tag = task:get_request_header('MTA-Name')
  return tag ~= nil and tostring(tag) == 'CYRUS'
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

local function header_count(task, name)
  return #(task:get_header_full(name) or {})
end

-- Postarix: remembers which hosted addresses a message was sent to, by
-- Message-ID, for two days. A vacation reply is checked against it
-- (POSTARIX_CYRUS_SENT). A message with more recipients than are worth
-- remembering is marked, and no vacation reply to it is sent.
local RCPT_KEY = 'POSTARIX_RCPT:'
local RCPT_TTL = 172800
local MAX_RCPT = 100
local TOO_MANY = '!too-many'

rspamd_config:register_symbol({
  name = 'POSTARIX_REMEMBER_RCPT',
  type = 'postfilter',
  priority = 1,
  callback = function(task)
    if not redis_params or not task:get_helo() or is_cyrus(task) then
      return
    end
    if task:get_metric_action('default') == 'reject' then
      return
    end
    local id = message_id(task:get_header('Message-ID'))
    if not id then
      return
    end
    local key = RCPT_KEY .. id
    local function store(members)
      local args = { key }
      for _, m in ipairs(members) do
        table.insert(args, m)
      end
      lua_redis.redis_make_request(task, redis_params, key, true, function(err)
        if not err then
          lua_redis.redis_make_request(task, redis_params, key, true, function() end, 'EXPIRE', { key, tostring(RCPT_TTL) })
        end
      end, 'SADD', args)
    end
    local recipients = task:get_recipients('smtp') or {}
    if #recipients > MAX_RCPT then
      return store({ TOO_MANY })
    end
    local addresses, domains = {}, { HOSTED_SET }
    for _, rcpt in ipairs(recipients) do
      if rcpt.user and rcpt.domain and rcpt.domain ~= '' then
        table.insert(addresses, base_address(rcpt.user, rcpt.domain))
        table.insert(domains, string.lower(rcpt.domain))
      end
    end
    if #addresses == 0 then
      return
    end
    lua_redis.redis_make_request(task, redis_params, HOSTED_SET, false, function(err, flags)
      if err or type(flags) ~= 'table' then
        return
      end
      local hosted = {}
      for i, address in ipairs(addresses) do
        if tonumber(flags[i]) == 1 then
          table.insert(hosted, address)
        end
      end
      if #hosted > 0 then
        store(hosted)
      end
    end, 'SMISMEMBER', domains)
  end,
})

-- Postarix: what Cyrus may send, and what may be DKIM/ARC-signed. Every Cyrus
-- send uses one login, so Rspamd cannot tell whose Sieve script produced it;
-- the rules below bound what any script can do.
--  * Redirects (exactly one X-Sieve-Action: redirect, non-null envelope;
--    Postfix gives them an envelope sender on the server's name) are never
--    signed. A redirect of spam is refused, and so is one whose From is on a
--    hosted domain without a valid DKIM signature of that domain (it would
--    otherwise carry a forged hosted sender past the inbound checks).
--  * Vacation replies (exactly one X-Sieve-Action: vacation, Auto-Submitted:
--    auto-replied, null envelope) are sent and signed only when the message
--    being answered had exactly one hosted recipient and the reply's From is
--    that very address. Sieve lets a user choose the From address; this keeps
--    it to an address the answered message was really sent to.
--  * Anything else is refused.
local function cyrus_reject(task, reason)
  task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'refused: ' .. reason)
  task:set_pre_result('reject', 'Not sent: ' .. reason, 'postarix')
end

rspamd_config:register_symbol({
  name = 'POSTARIX_CYRUS_SENT',
  type = 'prefilter',
  priority = 10,
  callback = function(task)
    if not is_cyrus(task) then
      return
    end
    task:get_mempool():set_variable('postarix_cyrus', '1')
    if header_count(task, 'X-Sieve-Action') ~= 1 then
      return cyrus_reject(task, 'Cyrus may only send vacation replies and redirects')
    end
    local action = tostring(task:get_header('X-Sieve-Action') or '')
    local envelope = task:get_from('smtp')
    local envelope_addr = envelope and envelope[1] and envelope[1].addr or ''

    if action == 'redirect' and envelope_addr ~= '' then
      task:get_mempool():set_variable('postarix_cyrus_redirect', '1')
      task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'redirect')
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
    local from_addr = base_address(from[1].user, from[1].domain)
    local id = message_id(task:get_header('In-Reply-To'))
    if not id or not redis_params then
      return cyrus_reject(task, 'the message being answered is unknown')
    end
    lua_redis.redis_make_request(task, redis_params, RCPT_KEY .. id, false, function(err, data)
      if err or type(data) ~= 'table' or #data == 0 then
        return cyrus_reject(task, 'the message being answered is unknown')
      end
      if #data ~= 1 then
        return cyrus_reject(task, 'the message being answered had several hosted recipients')
      end
      if tostring(data[1]) ~= from_addr then
        return cyrus_reject(task, 'the From address is not the one the message was sent to')
      end
      task:get_mempool():set_variable('postarix_cyrus_sign', '1')
      task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'vacation')
    end, 'SMEMBERS', { RCPT_KEY .. id })
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
    lua_redis.redis_make_request(task, redis_params, HOSTED_SET, false, function(err, hosted)
      if err then
        return cyrus_reject(task, 'cannot check the sender')
      end
      if tonumber(hosted) == 1 then
        return cyrus_reject(task, 'the hosted sender of this message is not authenticated by DKIM')
      end
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
