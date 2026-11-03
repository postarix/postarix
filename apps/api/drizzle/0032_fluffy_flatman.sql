ALTER TABLE "domains" ADD COLUMN "backup_mx" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "backup_mx_nexthop" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "mta_sts_mode" text;--> statement-breakpoint
-- Domains whose mailboxes are here (Postfix: virtual_mailbox_domains); backup
-- MX domains are relayed instead.
CREATE OR REPLACE VIEW mail.domains AS
  SELECT d.name
  FROM public.domains d
  WHERE d.status = 'active' AND NOT d.backup_mx;
--> statement-breakpoint
-- Backup MX domains (Postfix: relay_domains, and relay_recipient_maps accepts
-- every address of them: the primary server knows its recipients).
CREATE OR REPLACE VIEW mail.backup_mx_domains AS
  SELECT d.name, d.backup_mx_nexthop AS nexthop
  FROM public.domains d
  WHERE d.status = 'active' AND d.backup_mx;
--> statement-breakpoint
-- Routes per destination (Postfix: transport_maps), and backup MX domains
-- with a fixed primary server.
CREATE OR REPLACE VIEW mail.transport_routes AS
  SELECT destination, 'smtp:' || nexthop AS transport
  FROM public.transport_routes
  WHERE enabled
  UNION ALL
  SELECT name AS destination, 'relay:' || nexthop AS transport
  FROM mail.backup_mx_domains
  WHERE nexthop IS NOT NULL;
