CREATE TABLE "relay_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"password" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tls_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" text NOT NULL,
	"policy" text NOT NULL,
	"parameters" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" text NOT NULL,
	"nexthop" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"password" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "relay_host_id" uuid;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "relay_host_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "tls_policies_destination_unique" ON "tls_policies" USING btree ("destination");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_routes_destination_unique" ON "transport_routes" USING btree ("destination");--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_relay_host_id_relay_hosts_id_fk" FOREIGN KEY ("relay_host_id") REFERENCES "public"."relay_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_relay_host_id_relay_hosts_id_fk" FOREIGN KEY ("relay_host_id") REFERENCES "public"."relay_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Smart host per sender (Postfix: sender_dependent_relayhost_maps, looked up
-- by address, then "@domain"): a mailbox's own, else its domain's.
CREATE OR REPLACE VIEW mail.relayhost_by_sender AS
  SELECT m.address AS sender, r.host AS relayhost
  FROM public.mailboxes m
  JOIN public.relay_hosts r ON r.id = m.relay_host_id AND r.enabled
  UNION ALL
  SELECT '@' || d.name AS sender, r.host AS relayhost
  FROM public.domains d
  JOIN public.relay_hosts r ON r.id = d.relay_host_id AND r.enabled
  WHERE d.status = 'active';
--> statement-breakpoint
-- Credentials per next hop (Postfix: smtp_sasl_password_maps, looked up by the
-- next hop as written in the route), "user:password". Keyed by host only: a
-- password is only ever sent to the host it belongs to.
CREATE OR REPLACE VIEW mail.smtp_credentials AS
  SELECT DISTINCT ON (nexthop) nexthop, credentials FROM (
    SELECT host AS nexthop, username || ':' || password AS credentials, created_at
    FROM public.relay_hosts WHERE enabled AND username <> ''
    UNION ALL
    SELECT nexthop, username || ':' || password AS credentials, created_at
    FROM public.transport_routes WHERE enabled AND username <> ''
  ) c
  ORDER BY nexthop, created_at DESC;
--> statement-breakpoint
-- Routes per destination (Postfix: transport_maps).
CREATE OR REPLACE VIEW mail.transport_routes AS
  SELECT destination, 'smtp:' || nexthop AS transport
  FROM public.transport_routes
  WHERE enabled;
--> statement-breakpoint
-- TLS per destination (Postfix: smtp_tls_policy_maps).
CREATE OR REPLACE VIEW mail.tls_policies AS
  SELECT destination, trim(policy || ' ' || parameters) AS policy
  FROM public.tls_policies
  WHERE enabled;
