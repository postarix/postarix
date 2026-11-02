import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
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
    return this.write(ctx.organizationId, ctx, action, target, details);
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

  /** Newest first, scoped to the organization. */
  async list(ctx: TenantContext, options: { limit: number; before?: Date | undefined }): Promise<AuditEventDto[]> {
    const conditions = [eq(auditEvents.organizationId, ctx.organizationId)];
    if (options.before) conditions.push(lt(auditEvents.createdAt, options.before));
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt))
      .limit(options.limit);
    return rows.map(toDto);
  }
}
