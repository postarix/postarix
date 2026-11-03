CREATE TABLE "bcc_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"address" text NOT NULL,
	"direction" text NOT NULL,
	"destination" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipient_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"destination" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bcc_rules" ADD CONSTRAINT "bcc_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bcc_rules" ADD CONSTRAINT "bcc_rules_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bcc_rules_organization_id_idx" ON "bcc_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bcc_rules_unique" ON "bcc_rules" USING btree ("address","direction","destination");--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_maps_address_unique" ON "recipient_maps" USING btree ("address");--> statement-breakpoint
-- Blind copies Postfix adds (recipient_bcc_maps and sender_bcc_maps look up a
-- single address there, see bcc_*.cf): the organization's archive and the
-- BCC rules of the address or its domain, these also on the domain's alias
-- domains (mail.archive_copies has them already).
CREATE OR REPLACE VIEW mail.bcc_targets AS
  WITH rules AS (
    SELECT r.address, r.direction, r.destination
    FROM public.bcc_rules r
    JOIN public.domains d ON d.id = r.domain_id AND d.status = 'active'
    WHERE r.enabled
  )
  SELECT address, 'recipient' AS direction, archive AS destination FROM mail.archive_copies
  UNION ALL
  SELECT address, 'sender' AS direction, archive AS destination FROM mail.archive_copies
  UNION ALL
  SELECT address, direction, destination FROM rules
  UNION ALL
  SELECT split_part(r.address, '@', 1) || '@' || ad.alias, r.direction, r.destination
  FROM rules r
  JOIN mail.alias_domains ad ON ad.target = split_part(r.address, '@', 2);
--> statement-breakpoint
-- Instance-wide recipient rewriting (Postfix: first of virtual_alias_maps).
CREATE OR REPLACE VIEW mail.recipient_maps AS
  SELECT address, destination FROM public.recipient_maps WHERE enabled;
