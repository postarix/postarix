CREATE TABLE "mail_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"mailbox_address" text NOT NULL,
	"host" text NOT NULL,
	"port" bigint NOT NULL,
	"security" text NOT NULL,
	"username" text NOT NULL,
	"password" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported" bigint DEFAULT 0 NOT NULL,
	"skipped" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mail_imports" ADD CONSTRAINT "mail_imports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_imports_user_id_idx" ON "mail_imports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mail_imports_status_idx" ON "mail_imports" USING btree ("status");