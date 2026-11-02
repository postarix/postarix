CREATE TABLE "dkim_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"selector" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dkim_keys" ADD CONSTRAINT "dkim_keys_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dkim_keys_domain_id_selector_unique" ON "dkim_keys" USING btree ("domain_id","selector");--> statement-breakpoint
CREATE UNIQUE INDEX "dkim_keys_one_active_per_domain" ON "dkim_keys" USING btree ("domain_id") WHERE "dkim_keys"."status" = 'active';