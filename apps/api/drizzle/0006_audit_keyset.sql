DROP INDEX "audit_events_org_created_idx";--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at","id");