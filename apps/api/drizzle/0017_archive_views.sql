-- Archiving (journaling): for each address of an organization that archives
-- (its mailboxes and aliases), the archive mailbox that gets a copy of what
-- it receives or sends. Postfix reads it as recipient_bcc_maps and
-- sender_bcc_maps. The archive itself is left out (no copies of copies).
CREATE OR REPLACE VIEW mail.archive_copies AS
  SELECT m.address, a.address AS archive
  FROM public.organization_archiving oa
  JOIN public.mailboxes a ON a.id = oa.archive_mailbox_id AND a.status = 'active'
  JOIN public.mailboxes m ON m.organization_id = oa.organization_id AND m.id <> a.id
  UNION ALL
  SELECT al.address, a.address AS archive
  FROM public.organization_archiving oa
  JOIN public.mailboxes a ON a.id = oa.archive_mailbox_id AND a.status = 'active'
  JOIN public.aliases al ON al.organization_id = oa.organization_id;
