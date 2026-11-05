CREATE TABLE "connected_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_hash" text,
	"jwks_uri" text,
	"jwks" jsonb,
	"require_private_key_jwt" boolean DEFAULT false NOT NULL,
	"identity_issuer" text NOT NULL,
	"allow_user_id_subjects" boolean DEFAULT false NOT NULL,
	"scopes" text[] NOT NULL,
	"allowed_ips" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_apps_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "organization_supervisors" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_supervisors_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "supervision_access" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supervision_access_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"grant_id" uuid NOT NULL,
	"request" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supervision_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"app_id" uuid NOT NULL,
	"supervisor_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_mail_options" ADD COLUMN "supervision_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_mail_options" ADD COLUMN "supervision_notify" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_apps" ADD CONSTRAINT "connected_apps_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_supervisors" ADD CONSTRAINT "organization_supervisors_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_supervisors" ADD CONSTRAINT "organization_supervisors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_access" ADD CONSTRAINT "supervision_access_grant_id_supervision_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."supervision_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_grants" ADD CONSTRAINT "supervision_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_grants" ADD CONSTRAINT "supervision_grants_app_id_connected_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."connected_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_grants" ADD CONSTRAINT "supervision_grants_supervisor_id_user_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_grants" ADD CONSTRAINT "supervision_grants_subject_id_user_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_apps_organization_id_idx" ON "connected_apps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "supervision_access_grant_idx" ON "supervision_access" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "supervision_grants_lookup_idx" ON "supervision_grants" USING btree ("app_id","supervisor_id","subject_id");