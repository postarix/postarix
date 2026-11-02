import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type AuditEventRow, auditEvents } from '../db/schema/index.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export interface AuditTarget {
  type: string;
  id?: string | undefined;
  label?: string | undefined;
}

export interface AuditActor {
  userId: string;
  userEmail: string;
  ipAddress: string | null;
}

/** Position in the audit log: a full-precision timestamp (as PostgreSQL prints it) and an ID. */
export interface AuditCursor {
  at: string;
  id: string;
}

export function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url');
}

/** Returns null for anything that is not a cursor this API produced. */
export function decodeCursor(value: string): AuditCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed as unknown[];
    if (typeof at !== 'string' || typeof id !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/.test(at)) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export interface AuditEventDto {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  actorEmail: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

function toDto(row: AuditEventRow): AuditEventDto {
  return {
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    actorEmail: row.actorEmail,
    details: row.details ?? null,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Append-only audit trail. Recording never fails the action being audited: a
 * failed write is logged instead.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Records an action taken inside an organization. */
  record(
    ctx: TenantContext,
    action: string,
    target: AuditTarget,
    details?: Record<string, unknown>,
  ): Promise<void> {
    // Changes made through instance-administrator access are marked as such.
    const marked = ctx.viaSuperAdmin ? { ...details, viaSuperAdmin: true } : details;
    return this.write(ctx.organizationId, ctx, action, target, marked);
  }

  /** Records an instance-level action (not tied to one organization). */
  recordInstance(
    actor: AuditActor,
    action: string,
    target: AuditTarget,
    details?: Record<string, unknown>,
  ): Promise<void> {
    return this.write(null, actor, action, target, details);
  }

  private async write(
    organizationId: string | null,
    actor: AuditActor,
    action: string,
    target: AuditTarget,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(auditEvents).values({
        organizationId,
        actorUserId: actor.userId,
        actorEmail: actor.userEmail,
        action,
        targetType: target.type,
        targetId: target.id ?? null,
        targetLabel: target.label ?? null,
        details: details ?? null,
        ipAddress: actor.ipAddress,
      });
    } catch (error) {
      this.logger.error(`Could not record audit event ${action}: ${(error as Error).message}`);
    }
  }

  /**
   * Newest first, scoped to the organization. Pages with an opaque keyset
   * cursor on (created_at, id) at full (microsecond) precision, so events
   * created in the same instant are neither skipped nor repeated.
   */
  async list(
    ctx: TenantContext,
    options: { limit: number; cursor?: AuditCursor | undefined },
  ): Promise<{ data: AuditEventDto[]; nextCursor: string | null }> {
    const conditions = [eq(auditEvents.organizationId, ctx.organizationId)];
    if (options.cursor) {
      conditions.push(sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${options.cursor.at}::timestamptz, ${options.cursor.id}::uuid)`);
    }
    const rows = await this.db
      .select({ row: auditEvents, at: sql<string>`${auditEvents.createdAt}::text` })
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(options.limit + 1);
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ row }) => toDto(row)),
      nextCursor: rows.length > options.limit && last ? encodeCursor({ at: last.at, id: last.row.id }) : null,
    };
  }
}
