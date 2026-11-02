CREATE TABLE "organization_security" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"require_second_factor" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_security" ADD CONSTRAINT "organization_security_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;