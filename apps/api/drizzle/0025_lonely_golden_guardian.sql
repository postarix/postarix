CREATE TABLE "spam_list_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"domain_id" uuid,
	"mailbox_id" uuid,
	"kind" text NOT NULL,
	"pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spam_list_entries_one_target" CHECK (("spam_list_entries"."organization_id" IS NULL AND "spam_list_entries"."domain_id" IS NULL AND "spam_list_entries"."mailbox_id" IS NULL)
        OR ("spam_list_entries"."organization_id" IS NOT NULL AND (("spam_list_entries"."domain_id" IS NULL) <> ("spam_list_entries"."mailbox_id" IS NULL))))
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "spam_junk_score" real;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "spam_reject_score" real;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "spam_junk_score" real;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "spam_reject_score" real;--> statement-breakpoint
ALTER TABLE "spam_list_entries" ADD CONSTRAINT "spam_list_entries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spam_list_entries" ADD CONSTRAINT "spam_list_entries_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spam_list_entries" ADD CONSTRAINT "spam_list_entries_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spam_list_entries_organization_id_idx" ON "spam_list_entries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "spam_list_entries_domain_id_idx" ON "spam_list_entries" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "spam_list_entries_mailbox_id_idx" ON "spam_list_entries" USING btree ("mailbox_id");