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


-- Postarix: remembers who incoming mail was addressed to, by Message-ID, for
-- two days. A vacation reply is checked against it (POSTARIX_CYRUS_SENT).
local RCPT_KEY = 'POSTARIX_RCPT:'
local RCPT_TTL = 172800

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
    local args = { RCPT_KEY .. id }
    for i, rcpt in ipairs(task:get_recipients('smtp') or {}) do
      if i > 50 then
        break
      end
      if rcpt.user and rcpt.domain then
        table.insert(args, string.lower(rcpt.user:gsub('%+.*$', '') .. '@' .. rcpt.domain))
      end
    end
    if #args < 2 then
      return
    end
    local key = args[1]
    lua_redis.redis_make_request(task, redis_params, key, true, function(err)
      if not err then
        lua_redis.redis_make_request(task, redis_params, key, true, function() end, 'EXPIRE', { key, tostring(RCPT_TTL) })
      end
    end, 'SADD', args)
  end,
})

-- Postarix: what Cyrus may send, and what may be DKIM/ARC-signed.
--  * Redirects (X-Sieve-Action: redirect; Postfix gives them an envelope sender
--    on the server's name) are never signed: the original sender's
--    own signature, if any, still verifies.
--  * Vacation replies (null envelope sender) are signed with the From domain,
--    but only when every hosted recipient of the message being answered was on
--    that domain. A user cannot make the server sign as an address of a domain
--    that is not their own (Sieve lets them choose the From address).
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
    local action = tostring(task:get_header('X-Sieve-Action') or '')
    local envelope = task:get_from('smtp')
    local envelope_addr = envelope and envelope[1] and envelope[1].addr or ''

    if action == 'redirect' and envelope_addr ~= '' then
      task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'redirect')
      return
    end
    if action ~= 'vacation' or envelope_addr ~= '' then
      return cyrus_reject(task, 'Cyrus may only send vacation replies and redirects')
    end

    local from = task:get_from('mime')
    if not from or #from ~= 1 or not from[1].domain or from[1].domain == '' then
      return cyrus_reject(task, 'a vacation reply needs exactly one From address')
    end
    local from_domain = string.lower(from[1].domain)
    local id = message_id(task:get_header('In-Reply-To'))
    if not id or not redis_params then
      return cyrus_reject(task, 'the message being answered is unknown')
    end
    lua_redis.redis_make_request(task, redis_params, RCPT_KEY .. id, false, function(err, data)
      if err or type(data) ~= 'table' or #data == 0 then
        return cyrus_reject(task, 'the message being answered is unknown')
      end
      local domains, seen = {}, {}
      for _, rcpt in ipairs(data) do
        local domain = tostring(rcpt):match('@(.+)$')
        if domain and not seen[domain] then
          seen[domain] = true
          table.insert(domains, domain)
        end
      end
      if #domains == 0 then
        return cyrus_reject(task, 'the message being answered is unknown')
      end
      -- Hosted domains are the ones with a DKIM selector (published by the API).
      local args = { 'DKIM_SELECTORS' }
      for _, d in ipairs(domains) do
        table.insert(args, d)
      end
      lua_redis.redis_make_request(task, redis_params, 'DKIM_SELECTORS', false, function(err2, selectors)
        if err2 or type(selectors) ~= 'table' then
          return cyrus_reject(task, 'the message being answered is unknown')
        end
        local hosted = 0
        for i, d in ipairs(domains) do
          local selector = selectors[i]
          if selector ~= nil and type(selector) ~= 'userdata' and tostring(selector) ~= '' then
            hosted = hosted + 1
            if d ~= from_domain then
              return cyrus_reject(task, 'the From address is not on the domain the message was sent to')
            end
          end
        end
        if hosted == 0 then
          return cyrus_reject(task, 'the From address is not on the domain the message was sent to')
        end
        task:get_mempool():set_variable('postarix_cyrus_sign', '1')
        task:insert_result('POSTARIX_CYRUS_SENT', 1.0, 'vacation')
      end, 'HMGET', args)
    end, 'SMEMBERS', { RCPT_KEY .. id })
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
