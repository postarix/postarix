ALTER TABLE "mailboxes" ADD COLUMN "allowed_protocols" text[] DEFAULT ARRAY['imap','pop3','smtp','sieve','dav']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "tls_required_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "tls_required_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Mailboxes that accept mail: enabled (sign-in allowed or not), on an active domain.
CREATE OR REPLACE VIEW mail.mailboxes AS
  SELECT m.address
  FROM public.mailboxes m
  JOIN public.domains d ON d.id = m.domain_id
  WHERE m.status IN ('active', 'no_login') AND d.status = 'active';
--> statement-breakpoint
-- Recipients that only accept mail over TLS (Postfix: check_recipient_access).
CREATE OR REPLACE VIEW mail.tls_required_in AS
  SELECT m.address
  FROM public.mailboxes m
  JOIN public.domains d ON d.id = m.domain_id
  WHERE m.tls_required_in AND m.status IN ('active', 'no_login') AND d.status = 'active';
--> statement-breakpoint
-- Envelope senders whose mail leaves only over TLS (Postfix:
-- sender_dependent_default_transport_maps): the mailbox and the addresses it
-- sends as, but not whole domains ("@domain" would cover its colleagues too).
CREATE OR REPLACE VIEW mail.tls_required_out AS
  SELECT sl.sender AS address
  FROM mail.sender_logins sl
  JOIN public.mailboxes m ON m.address = sl.login
  WHERE m.tls_required_out AND sl.sender NOT LIKE '@%';
