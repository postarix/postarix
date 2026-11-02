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
    if not task:get_user() then
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
