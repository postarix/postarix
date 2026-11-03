CREATE TABLE "filter_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"header" text,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forwarding_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"spam_filter" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"kind" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "filter_rules_enabled_idx" ON "filter_rules" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "forwarding_hosts_host_unique" ON "forwarding_hosts" USING btree ("host");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_access_network_kind_unique" ON "ip_access" USING btree ("network","kind");--> statement-breakpoint
-- Postfix's client check (check_client_access, see client_access.cf): OK for
-- allowed networks, REJECT for blocked ones (a block wins), nothing otherwise.
-- A definer function, so the mail role reads no table directly and a
-- malformed address is no error.
CREATE OR REPLACE FUNCTION mail.client_access(address text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  ip inet;
BEGIN
  BEGIN
    ip := address::inet;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  RETURN (
    SELECT CASE WHEN a.kind = 'block' THEN 'REJECT Access from your network is refused' ELSE 'OK' END
    FROM public.ip_access a
    WHERE a.enabled AND a.network::inet >>= ip
    ORDER BY (a.kind = 'block') DESC, masklen(a.network::inet) DESC
    LIMIT 1
  );
END
$$;
