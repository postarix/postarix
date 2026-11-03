CREATE TABLE "mailbox_send_as" (
	"mailbox_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aliases" DROP CONSTRAINT "aliases_destinations_not_empty";--> statement-breakpoint
ALTER TABLE "aliases" ADD COLUMN "discard" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_send_as" ADD CONSTRAINT "mailbox_send_as_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_send_as" ADD CONSTRAINT "mailbox_send_as_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_send_as_unique" ON "mailbox_send_as" USING btree ("mailbox_id","sender");--> statement-breakpoint
CREATE INDEX "mailbox_send_as_sender_idx" ON "mailbox_send_as" USING btree ("sender");--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_destinations_not_empty" CHECK (cardinality("aliases"."destinations") > 0 OR "aliases"."discard");--> statement-breakpoint
-- Aliases for Postfix' virtual_alias_maps. A discarding alias goes to the
-- discard transport. Mailboxes map to themselves: Postfix tries "@domain" (a
-- catch-all) after the full address, and must not hand a mailbox's mail to
-- the catch-all.
CREATE OR REPLACE VIEW mail.aliases AS
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
  FROM mail.mailboxes mb;
--> statement-breakpoint
-- Which login may use which envelope sender (Postfix also looks up "@domain"):
-- a mailbox may send as itself, as its organization's aliases that deliver to
-- it (not catch-alls: they would cover the whole domain), and as the addresses
-- or domains it was allowed explicitly, on its organization's domains.
CREATE OR REPLACE VIEW mail.sender_logins AS
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
  WHERE m.status = 'active' AND md.status = 'active' AND sd.status = 'active';
