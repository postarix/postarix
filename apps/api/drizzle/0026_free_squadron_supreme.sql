CREATE TABLE "quarantine_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"envelope_from" text DEFAULT '' NOT NULL,
	"from_header" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"score" real NOT NULL,
	"symbols" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"message" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "quarantine_notify" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine_items" ADD CONSTRAINT "quarantine_items_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quarantine_items_mailbox_created_idx" ON "quarantine_items" USING btree ("mailbox_id","created_at");--> statement-breakpoint
CREATE INDEX "quarantine_items_organization_id_idx" ON "quarantine_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quarantine_items_created_at_idx" ON "quarantine_items" USING btree ("created_at");