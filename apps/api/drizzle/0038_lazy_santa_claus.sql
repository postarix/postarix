CREATE TABLE "organization_mail_options" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"shared_sender_header" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_mailbox_members" (
	"mailbox_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"rights" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_mailbox_members_mailbox_id_user_id_pk" PRIMARY KEY("mailbox_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "shared_seen" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_mail_options" ADD CONSTRAINT "organization_mail_options_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_mailbox_members" ADD CONSTRAINT "shared_mailbox_members_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_mailbox_members" ADD CONSTRAINT "shared_mailbox_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_mailbox_members_user_id_idx" ON "shared_mailbox_members" USING btree ("user_id");--> statement-breakpoint
-- Members of a shared mailbox with "send" may also send as it (from mail apps
-- with their own login; the webmail goes through the API's own checks).
CREATE OR REPLACE VIEW mail.sender_logins AS
  WITH base AS (
    SELECT mb.address AS sender, mb.address AS login
    FROM mail.mailboxes mb
    UNION
    SELECT a.address AS sender, m.address AS login
    FROM public.aliases a
    JOIN public.domains ad ON ad.id = a.domain_id
    JOIN public.mailboxes m ON m.address = ANY (a.destinations) AND m.organization_id = a.organization_id
    JOIN public.domains md ON md.id = m.domain_id
    WHERE a.enabled AND NOT a.discard AND a.local_part <> '' AND (a.expires_at IS NULL OR a.expires_at > now())
      AND ad.status = 'active' AND m.status = 'active' AND md.status = 'active'
    UNION
    SELECT s.sender, m.address AS login
    FROM public.mailbox_send_as s
    JOIN public.mailboxes m ON m.id = s.mailbox_id
    JOIN public.domains md ON md.id = m.domain_id
    JOIN public.domains sd ON sd.id = s.domain_id AND sd.organization_id = m.organization_id
    WHERE m.status = 'active' AND md.status = 'active' AND sd.status = 'active'
    UNION
    SELECT sh.address AS sender, m.address AS login
    FROM public.shared_mailbox_members smm
    JOIN public.mailboxes sh ON sh.id = smm.mailbox_id AND sh.kind = 'shared'
    JOIN public.domains shd ON shd.id = sh.domain_id
    JOIN public.mailboxes m ON m.user_id = smm.user_id AND m.organization_id = sh.organization_id AND m.kind = 'person'
    JOIN public.domains md ON md.id = m.domain_id
    WHERE smm.rights = 'send'
      AND sh.status <> 'disabled' AND shd.status = 'active' AND m.status = 'active' AND md.status = 'active'
  )
  SELECT sender, login FROM base
  UNION
  SELECT split_part(b.sender, '@', 1) || '@' || ad.alias AS sender, b.login
  FROM base b
  JOIN mail.alias_domains ad ON ad.target = split_part(b.sender, '@', 2);
