ALTER TABLE "domains" ADD COLUMN "alias_of_domain_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_alias_of_domain_id_domains_id_fk" FOREIGN KEY ("alias_of_domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domains_alias_of_domain_id_idx" ON "domains" USING btree ("alias_of_domain_id");--> statement-breakpoint
-- Alias domains in use: both the alias and its target active, in one organization.
CREATE OR REPLACE VIEW mail.alias_domains AS
  SELECT a.name AS alias, t.name AS target
  FROM public.domains a
  JOIN public.domains t ON t.id = a.alias_of_domain_id AND t.organization_id = a.organization_id
  WHERE a.status = 'active' AND t.status = 'active';
--> statement-breakpoint
-- Aliases for Postfix' virtual_alias_maps (see 0020), and each of them again on
-- the target domain's alias domains: x@alias goes where x@target goes.
CREATE OR REPLACE VIEW mail.aliases AS
  WITH base AS (
    SELECT a.address, unnest(a.destinations) AS destination
    FROM public.aliases a
    JOIN public.domains d ON d.id = a.domain_id
    WHERE a.enabled AND NOT a.discard AND d.status = 'active'
    UNION ALL
    SELECT a.address, 'discard@discard.postarix.invalid' AS destination
    FROM public.aliases a
    JOIN public.domains d ON d.id = a.domain_id
    WHERE a.enabled AND a.discard AND d.status = 'active'
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
    WHERE a.enabled AND NOT a.discard AND a.local_part <> ''
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
--> statement-breakpoint
CREATE OR REPLACE VIEW mail.tls_required_in AS
  SELECT m.address
  FROM public.mailboxes m
  JOIN public.domains d ON d.id = m.domain_id
  WHERE m.tls_required_in AND m.status IN ('active', 'no_login') AND d.status = 'active'
  UNION ALL
  SELECT m.local_part || '@' || ad.alias
  FROM public.mailboxes m
  JOIN public.domains d ON d.id = m.domain_id
  JOIN mail.alias_domains ad ON ad.target = d.name
  WHERE m.tls_required_in AND m.status IN ('active', 'no_login') AND d.status = 'active';
--> statement-breakpoint
-- Archiving (see 0017), for the addresses on alias domains too.
CREATE OR REPLACE VIEW mail.archive_copies AS
  WITH base AS (
    SELECT m.address, a.address AS archive
    FROM public.organization_archiving oa
    JOIN public.mailboxes a ON a.id = oa.archive_mailbox_id AND a.status = 'active'
    JOIN public.mailboxes m ON m.organization_id = oa.organization_id AND m.id <> a.id
    UNION ALL
    SELECT al.address, a.address AS archive
    FROM public.organization_archiving oa
    JOIN public.mailboxes a ON a.id = oa.archive_mailbox_id AND a.status = 'active'
    JOIN public.aliases al ON al.organization_id = oa.organization_id
  )
  SELECT address, archive FROM base
  UNION ALL
  SELECT split_part(b.address, '@', 1) || '@' || ad.alias AS address, b.archive
  FROM base b
  JOIN mail.alias_domains ad ON ad.target = split_part(b.address, '@', 2);
