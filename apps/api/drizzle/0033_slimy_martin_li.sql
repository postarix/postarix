CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_scope_valid" CHECK (("templates"."kind" = 'domain') = ("templates"."organization_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_organization_id_idx" ON "templates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_name_unique" ON "templates" USING btree (coalesce("organization_id", ''),"kind",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "templates_one_default" ON "templates" USING btree (coalesce("organization_id", ''),"kind") WHERE "templates"."is_default";