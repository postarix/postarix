ALTER TABLE "mail_imports" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD COLUMN "mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD COLUMN "interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_imports_organization_id_idx" ON "mail_imports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mail_imports_mailbox_id_idx" ON "mail_imports" USING btree ("mailbox_id");--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_owner_valid" CHECK (("mail_imports"."user_id" IS NOT NULL AND "mail_imports"."organization_id" IS NULL) OR ("mail_imports"."user_id" IS NULL AND "mail_imports"."organization_id" IS NOT NULL AND "mail_imports"."mailbox_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_interval_valid" CHECK ("mail_imports"."interval_minutes" IS NULL OR "mail_imports"."interval_minutes" >= 5);