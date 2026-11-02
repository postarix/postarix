CREATE TABLE "aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"address" text NOT NULL,
	"destinations" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliases_address_unique" UNIQUE("address"),
	CONSTRAINT "aliases_destinations_not_empty" CHECK (cardinality("aliases"."destinations") > 0)
);
--> statement-breakpoint
CREATE TABLE "app_passwords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"lookup_prefix" text NOT NULL,
	"password_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" uuid NOT NULL,
	"user_id" text,
	"local_part" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"quota_bytes" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_address_unique" UNIQUE("address"),
	CONSTRAINT "mailboxes_quota_positive" CHECK ("mailboxes"."quota_bytes" IS NULL OR "mailboxes"."quota_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_passwords" ADD CONSTRAINT "app_passwords_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aliases_organization_id_idx" ON "aliases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "app_passwords_user_id_idx" ON "app_passwords" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_passwords_user_id_name_unique" ON "app_passwords" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "app_passwords_lookup_idx" ON "app_passwords" USING btree ("user_id","lookup_prefix");--> statement-breakpoint
CREATE INDEX "mailboxes_organization_id_idx" ON "mailboxes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mailboxes_domain_id_idx" ON "mailboxes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "mailboxes_user_id_idx" ON "mailboxes" USING btree ("user_id");