ALTER TABLE "domains" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "default_mailbox_quota_bytes" bigint;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "max_mailboxes" integer;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "max_aliases" integer;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "max_mailbox_quota_bytes" bigint;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "total_quota_bytes" bigint;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_limits_valid" CHECK (("domains"."max_mailboxes" IS NULL OR "domains"."max_mailboxes" >= 0)
        AND ("domains"."max_aliases" IS NULL OR "domains"."max_aliases" >= 0)
        AND ("domains"."default_mailbox_quota_bytes" IS NULL OR "domains"."default_mailbox_quota_bytes" > 0)
        AND ("domains"."max_mailbox_quota_bytes" IS NULL OR "domains"."max_mailbox_quota_bytes" > 0)
        AND ("domains"."total_quota_bytes" IS NULL OR "domains"."total_quota_bytes" > 0));