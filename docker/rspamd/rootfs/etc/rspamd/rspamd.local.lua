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
