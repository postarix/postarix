-- Read-only views consumed by Postfix (and any other mail component).
-- They live in their own schema so the mail database role can be granted
-- SELECT on exactly these views and nothing else (no password hashes, no sessions).
-- Views run with their owner's privileges, so that role needs no access to the tables.
CREATE SCHEMA IF NOT EXISTS mail;
--> statement-breakpoint
-- Domains that accept mail: verified (active) only.
CREATE OR REPLACE VIEW mail.domains AS
  SELECT d.name
  FROM public.domains d
  WHERE d.status = 'active';
--> statement-breakpoint
-- Mailboxes that accept mail: enabled, on an active domain.
CREATE OR REPLACE VIEW mail.mailboxes AS
  SELECT m.address
  FROM public.mailboxes m
  JOIN public.domains d ON d.id = m.domain_id
  WHERE m.status = 'active' AND d.status = 'active';
--> statement-breakpoint
-- One row per alias destination.
CREATE OR REPLACE VIEW mail.aliases AS
  SELECT a.address, unnest(a.destinations) AS destination
  FROM public.aliases a
  JOIN public.domains d ON d.id = a.domain_id
  WHERE a.enabled AND d.status = 'active';
--> statement-breakpoint
-- Which authenticated login may use which envelope sender: a mailbox may send
-- as itself, and as any alias that delivers to it.
CREATE OR REPLACE VIEW mail.sender_logins AS
  SELECT mb.address AS sender, mb.address AS login
  FROM mail.mailboxes mb
  UNION
  SELECT al.address AS sender, mb.address AS login
  FROM mail.aliases al
  JOIN mail.mailboxes mb ON mb.address = al.destination;
