-- Single sign-on providers whose organization no longer holds a verified domain
-- of that name (domains deleted before deletion took providers with it). Sign-in
-- finds providers by domain, so these would capture the domain's next owner.
DELETE FROM "sso_provider" p
WHERE NOT EXISTS (
  SELECT 1 FROM "domains" d
  WHERE d."organization_id" = p."organization_id"
    AND d."name" = p."domain"
    AND d."status" <> 'pending'
);
--> statement-breakpoint
-- One provider per domain, as sign-in assumes.
CREATE UNIQUE INDEX IF NOT EXISTS "sso_provider_domain_unique" ON "sso_provider" ("domain");
