CREATE TABLE "organization_archiving" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"archive_mailbox_id" uuid,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_archiving" ADD CONSTRAINT "organization_archiving_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_archiving" ADD CONSTRAINT "organization_archiving_archive_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("archive_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE restrict ON UPDATE no action;