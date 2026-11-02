ALTER TABLE "domains" DROP CONSTRAINT "domains_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "aliases" DROP CONSTRAINT "aliases_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "mailboxes" DROP CONSTRAINT "mailboxes_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Forwarding does not imply send-as across organizations: an alias only lets a
-- mailbox send as it when both belong to the same organization.
CREATE OR REPLACE VIEW mail.sender_logins AS
  SELECT mb.address AS sender, mb.address AS login
  FROM mail.mailboxes mb
  UNION
  SELECT a.address AS sender, m.address AS login
  FROM public.aliases a
  JOIN public.domains ad ON ad.id = a.domain_id
  JOIN public.mailboxes m ON m.address = ANY (a.destinations) AND m.organization_id = a.organization_id
  JOIN public.domains md ON md.id = m.domain_id
  WHERE a.enabled AND ad.status = 'active' AND m.status = 'active' AND md.status = 'active';
