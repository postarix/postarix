ALTER TABLE "aliases" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "aliases" ADD COLUMN "owner_mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "aliases" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_owner_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("owner_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Temporary addresses stop working when they expire (they are deleted soon after).
-- Aliases for Postfix' virtual_alias_maps (see 0020), and each of them again on
-- the target domain's alias domains: x@alias goes where x@target goes.
CREATE OR REPLACE VIEW mail.aliases AS
  WITH base AS (
    SELECT a.address, unnest(a.destinations) AS destination
    FROM public.aliases a
    JOIN public.domains d ON d.id = a.domain_id
    WHERE a.enabled AND NOT a.discard AND d.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now())
    UNION ALL
    SELECT a.address, 'discard@discard.postarix.invalid' AS destination
    FROM public.aliases a
    JOIN public.domains d ON d.id = a.domain_id
    WHERE a.enabled AND a.discard AND d.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now())
    UNION ALL
    SELECT mb.address, mb.address AS destination
    FROM mail.mailboxes mb
  )
  SELECT address, destination FROM base
  UNION ALL
  SELECT split_part(b.address, '@', 1) || '@' || ad.alias AS address, b.destination
  FROM base b
  JOIN mail.alias_domains ad ON ad.target = split_part(b.address, '@', 2);
--> statement-breakpoint
-- Envelope senders per login (see 0020), and the same addresses on the alias
-- domains of their domain.
CREATE OR REPLACE VIEW mail.sender_logins AS
  WITH base AS (
    SELECT mb.address AS sender, mb.address AS login
    FROM mail.mailboxes mb
    UNION
    SELECT a.address AS sender, m.address AS login
    FROM public.aliases a
    JOIN public.domains ad ON ad.id = a.domain_id
    JOIN public.mailboxes m ON m.address = ANY (a.destinations) AND m.organization_id = a.organization_id
    JOIN public.domains md ON md.id = m.domain_id
    WHERE a.enabled AND NOT a.discard AND a.local_part <> '' AND (a.expires_at IS NULL OR a.expires_at > now())
      AND ad.status = 'active' AND m.status = 'active' AND md.status = 'active'
    UNION
    SELECT s.sender, m.address AS login
    FROM public.mailbox_send_as s
    JOIN public.mailboxes m ON m.id = s.mailbox_id
    JOIN public.domains md ON md.id = m.domain_id
    JOIN public.domains sd ON sd.id = s.domain_id AND sd.organization_id = m.organization_id
    WHERE m.status = 'active' AND md.status = 'active' AND sd.status = 'active'
  )
  SELECT sender, login FROM base
  UNION
  SELECT split_part(b.sender, '@', 1) || '@' || ad.alias AS sender, b.login
  FROM base b
  JOIN mail.alias_domains ad ON ad.target = split_part(b.sender, '@', 2);
