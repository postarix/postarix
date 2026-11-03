ALTER TABLE "domains" ADD COLUMN "rate_limit" integer;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "rate_period" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "rate_limit" integer;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "rate_period" text;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_rate_limit_valid" CHECK (("domains"."rate_limit" IS NULL) = ("domains"."rate_period" IS NULL) AND ("domains"."rate_limit" IS NULL OR "domains"."rate_limit" > 0));--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_rate_limit_valid" CHECK (("mailboxes"."rate_limit" IS NULL) = ("mailboxes"."rate_period" IS NULL) AND ("mailboxes"."rate_limit" IS NULL OR "mailboxes"."rate_limit" > 0));