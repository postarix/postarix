import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Param,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { normalizeAddress } from '../common/addresses.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE, HASH_STORE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { domains, mailboxes, spamListEntries, type SpamListEntryRow, spamListKinds } from '../db/schema/index.js';
import { normalizeDomainName } from '../domains/domain-name.js';
import { findOwnMailbox } from '../jmap/my-mailbox.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import { type HashStore, SPAM_LISTS_HASH, SPAM_SCORES_HASH } from './spam-store.js';

/** A sender: an address, "@domain" (also "*@domain") or "@.domain" (its subdomains). */
export const senderPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .transform((value, ctx) => {
    const raw = value.startsWith('*@') ? value.slice(1) : value;
    let normalized: string | null;
    if (raw.startsWith('@.')) {
      const d = normalizeDomainName(raw.slice(2));
      normalized = d ? `@.${d}` : null;
    } else if (raw.startsWith('@')) {
      const d = normalizeDomainName(raw.slice(1));
      normalized = d ? `@${d}` : null;
    } else {
      normalized = normalizeAddress(raw);
    }
    if (!normalized || normalized.includes(',')) {
      ctx.addIssue({ code: 'custom', message: 'Use an address, @domain, or @.domain for its subdomains' });
      return z.NEVER;
    }
    return normalized;
  });

const score = z.number().min(0).max(1000);

/** Spam thresholds; null: inherited (the domain's, then the server's). */
export const spamScoresSchema = z
  .strictObject({ junkScore: score.nullable(), rejectScore: score.nullable() })
  .refine((v) => v.junkScore === null || v.rejectScore === null || v.junkScore < v.rejectScore, {
    message: 'The junk score must be lower than the reject score',
    path: ['junkScore'],
  });
export type SpamScores = z.infer<typeof spamScoresSchema>;

const entrySchema = z.strictObject({ kind: z.enum(spamListKinds), pattern: senderPatternSchema });
const orgEntrySchema = entrySchema
  .extend({ domainId: z.uuid().optional(), mailboxId: z.uuid().optional() })
  .refine((v) => Boolean(v.domainId) !== Boolean(v.mailboxId), 'Choose a domain or a mailbox');
const targetQuerySchema = z
  .object({ domainId: z.uuid().optional(), mailboxId: z.uuid().optional() })
  .refine((v) => Boolean(v.domainId) !== Boolean(v.mailboxId), 'Choose a domain or a mailbox');

export interface SpamListEntryDto {
  id: string;
  kind: SpamListEntryRow['kind'];
  pattern: string;
  createdAt: string;
}

const entryDto = (row: SpamListEntryRow): SpamListEntryDto => ({
  id: row.id,
  kind: row.kind,
  pattern: row.pattern,
  createdAt: row.createdAt.toISOString(),
});

/** "junk:reject", either may be empty. */
export function encodeScores(scores: { spamJunkScore: number | null; spamRejectScore: number | null }): string | null {
  if (scores.spamJunkScore === null && scores.spamRejectScore === null) return null;
  return `${scores.spamJunkScore ?? ''}:${scores.spamRejectScore ?? ''}`;
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ENTRIES_PER_TARGET = 500;

/**
 * Spam thresholds and allow/block lists per mailbox, per domain and for the
 * whole instance. Kept in the database and published to Valkey for Rspamd
 * (keyed by "address", "@domain" or "*").
 */
@Injectable()
export class SpamService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SpamService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HASH_STORE) private readonly store: HashStore,
  ) {}

  /** Publishes the thresholds of a mailbox ("ann@example.com") or domain ("@example.com"). */
  async publishScores(
    key: string,
    scores: { spamJunkScore: number | null; spamRejectScore: number | null } | null,
  ): Promise<void> {
    try {
      await this.store.set(SPAM_SCORES_HASH, key, scores ? encodeScores(scores) : null);
    } catch (error) {
      this.logger.error(`Cannot publish the spam scores of ${key}: ${(error as Error).message}`);
    }
  }

  // --- Lists -----------------------------------------------------------------

  async list(target: ListTarget): Promise<SpamListEntryDto[]> {
    const rows = await this.db
      .select()
      .from(spamListEntries)
      .where(targetFilter(target))
      .orderBy(asc(spamListEntries.kind), asc(spamListEntries.pattern));
    return rows.map(entryDto);
  }

  async add(target: ListTarget, kind: SpamListEntryRow['kind'], pattern: string): Promise<SpamListEntryDto> {
    const existing = await this.db.select().from(spamListEntries).where(targetFilter(target));
    if (existing.some((e) => e.pattern === pattern)) throw new ConflictException('This sender is already on a list');
    if (existing.length >= MAX_ENTRIES_PER_TARGET)
      throw new UnprocessableEntityException(`At most ${MAX_ENTRIES_PER_TARGET} senders`);
    const [row] = await this.db
      .insert(spamListEntries)
      .values({
        organizationId: target.organizationId,
        domainId: target.domainId ?? null,
        mailboxId: target.mailboxId ?? null,
        kind,
        pattern,
      })
      .returning();
    await this.publishList(target);
    return entryDto(row!);
  }

  async remove(target: ListTarget, id: string): Promise<void> {
    const deleted = await this.db
      .delete(spamListEntries)
      .where(and(targetFilter(target), eq(spamListEntries.id, id)))
      .returning({ id: spamListEntries.id });
    if (deleted.length === 0) throw new NotFoundException('Entry not found');
    await this.publishList(target);
  }

  /** Removes an entry of the organization, whichever of its domains or mailboxes it belongs to. */
  async removeInOrganization(ctx: TenantContext, id: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(spamListEntries)
      .where(and(eq(spamListEntries.id, id), eq(spamListEntries.organizationId, ctx.organizationId)));
    if (!row) throw new NotFoundException('Entry not found');
    await this.remove(
      { organizationId: ctx.organizationId, domainId: row.domainId, mailboxId: row.mailboxId, key: '' },
      id,
    );
  }

  private async publishList(target: ListTarget): Promise<void> {
    const key = target.key || (await this.keyOf(target));
    if (!key) return;
    const rows = await this.db.select().from(spamListEntries).where(targetFilter(target));
    try {
      await this.store.set(SPAM_LISTS_HASH, key, encodeList(rows));
    } catch (error) {
      this.logger.error(`Cannot publish the spam lists of ${key}: ${(error as Error).message}`);
    }
  }

  private async keyOf(target: ListTarget): Promise<string | null> {
    if (target.mailboxId) {
      const [m] = await this.db
        .select({ address: mailboxes.address })
        .from(mailboxes)
        .where(eq(mailboxes.id, target.mailboxId));
      return m?.address ?? null;
    }
    if (target.domainId) {
      const [d] = await this.db.select({ name: domains.name }).from(domains).where(eq(domains.id, target.domainId));
      return d ? `@${d.name}` : null;
    }
    return '*';
  }

  // --- Organization targets ------------------------------------------------

  /** Resolves a domain or mailbox of the organization into a list target (404 otherwise). */
  async orgTarget(
    ctx: TenantContext,
    input: { domainId?: string | undefined; mailboxId?: string | undefined },
  ): Promise<ListTarget> {
    if (input.mailboxId) {
      const [m] = await this.db
        .select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.organizationId, ctx.organizationId)));
      if (!m) throw new NotFoundException('Mailbox not found');
      return { organizationId: ctx.organizationId, mailboxId: m.id, key: m.address };
    }
    const [d] = await this.db
      .select({ id: domains.id, name: domains.name })
      .from(domains)
      .where(and(eq(domains.id, input.domainId!), eq(domains.organizationId, ctx.organizationId)));
    if (!d) throw new NotFoundException('Domain not found');
    return { organizationId: ctx.organizationId, domainId: d.id, key: `@${d.name}` };
  }

  /** The signed-in person's own mailbox as a list target. */
  async ownTarget(userId: string): Promise<ListTarget & { scores: SpamScores }> {
    const address = await findOwnMailbox(this.db, userId);
    if (!address) throw new NotFoundException('You have no mailbox');
    const [m] = await this.db
      .select({
        id: mailboxes.id,
        organizationId: mailboxes.organizationId,
        junk: mailboxes.spamJunkScore,
        reject: mailboxes.spamRejectScore,
      })
      .from(mailboxes)
      .where(eq(mailboxes.address, address));
    if (!m) throw new NotFoundException('You have no mailbox');
    return {
      organizationId: m.organizationId,
      mailboxId: m.id,
      key: address,
      scores: { junkScore: m.junk, rejectScore: m.reject },
    };
  }

  async setOwnScores(userId: string, scores: SpamScores): Promise<SpamScores> {
    const target = await this.ownTarget(userId);
    await this.db
      .update(mailboxes)
      .set({ spamJunkScore: scores.junkScore, spamRejectScore: scores.rejectScore })
      .where(eq(mailboxes.id, target.mailboxId!));
    await this.publishScores(target.key, { spamJunkScore: scores.junkScore, spamRejectScore: scores.rejectScore });
    return scores;
  }

  // --- Sync -----------------------------------------------------------------

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Rewrites every published threshold and list from the database. */
  async sync(): Promise<void> {
    try {
      const scores = new Map<string, string>();
      const domainRows = await this.db
        .select({ name: domains.name, spamJunkScore: domains.spamJunkScore, spamRejectScore: domains.spamRejectScore })
        .from(domains)
        .where(or(isNotNull(domains.spamJunkScore), isNotNull(domains.spamRejectScore)));
      for (const row of domainRows) scores.set(`@${row.name}`, encodeScores(row)!);
      const mailboxRows = await this.db
        .select({
          address: mailboxes.address,
          spamJunkScore: mailboxes.spamJunkScore,
          spamRejectScore: mailboxes.spamRejectScore,
        })
        .from(mailboxes)
        .where(or(isNotNull(mailboxes.spamJunkScore), isNotNull(mailboxes.spamRejectScore)));
      for (const row of mailboxRows) scores.set(row.address, encodeScores(row)!);
      await this.store.replaceAll(SPAM_SCORES_HASH, scores);

      const entries = await this.db
        .select({ entry: spamListEntries, address: mailboxes.address, domain: domains.name })
        .from(spamListEntries)
        .leftJoin(mailboxes, eq(mailboxes.id, spamListEntries.mailboxId))
        .leftJoin(domains, eq(domains.id, spamListEntries.domainId));
      const grouped = new Map<string, SpamListEntryRow[]>();
      for (const { entry, address, domain } of entries) {
        const key = address ?? (domain ? `@${domain}` : entry.organizationId === null ? '*' : null);
        if (!key) continue;
        grouped.set(key, [...(grouped.get(key) ?? []), entry]);
      }
      await this.store.replaceAll(
        SPAM_LISTS_HASH,
        new Map([...grouped].map(([key, rows]) => [key, encodeList(rows)!])),
      );
    } catch (error) {
      this.logger.error(`Spam settings synchronisation failed: ${(error as Error).message}`);
    }
  }
}

export interface ListTarget {
  organizationId: string | null;
  domainId?: string | null;
  mailboxId?: string | null;
  /** The key Rspamd looks it up by (empty: computed). */
  key: string;
}

function targetFilter(target: ListTarget) {
  if (target.mailboxId) return eq(spamListEntries.mailboxId, target.mailboxId);
  if (target.domainId) return eq(spamListEntries.domainId, target.domainId);
  return and(
    isNull(spamListEntries.organizationId),
    isNull(spamListEntries.domainId),
    isNull(spamListEntries.mailboxId),
  );
}

/** "a:pattern,b:pattern…" (patterns never contain commas). */
function encodeList(rows: SpamListEntryRow[]): string | null {
  if (rows.length === 0) return null;
  return rows.map((r) => `${r.kind === 'allow' ? 'a' : 'b'}:${r.pattern}`).join(',');
}

// --- Controllers ---------------------------------------------------------------

/** Organization admins: lists of their domains and mailboxes. */
@Controller('orgs/:orgId/spam-lists')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class OrgSpamListsController {
  constructor(
    @Inject(SpamService) private readonly spam: SpamService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Tenant() ctx: TenantContext,
    @Query(new ZodValidationPipe(targetQuerySchema)) query: z.infer<typeof targetQuerySchema>,
  ): Promise<{ data: SpamListEntryDto[] }> {
    return { data: await this.spam.list(await this.spam.orgTarget(ctx, query)) };
  }

  @Post()
  async add(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(orgEntrySchema)) body: z.infer<typeof orgEntrySchema>,
  ): Promise<SpamListEntryDto> {
    const target = await this.spam.orgTarget(ctx, body);
    const entry = await this.spam.add(target, body.kind, body.pattern);
    await this.audit.record(ctx, `spam_list.${body.kind}_added`, {
      type: 'spam_list',
      id: entry.id,
      label: `${target.key}: ${body.pattern}`,
    });
    return entry;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', new ZodValidationPipe(z.uuid())) id: string): Promise<void> {
    await this.spam.removeInOrganization(ctx, id);
    await this.audit.record(ctx, 'spam_list.removed', { type: 'spam_list', id });
  }
}

/** Instance administrators: lists for every recipient on the server. */
@Controller('system/spam-lists')
@UseGuards(SuperAdminGuard)
export class GlobalSpamListsController {
  constructor(@Inject(SpamService) private readonly spam: SpamService) {}

  private readonly target: ListTarget = { organizationId: null, key: '*' };

  @Get()
  async list(): Promise<{ data: SpamListEntryDto[] }> {
    return { data: await this.spam.list(this.target) };
  }

  @Post()
  add(@Body(new ZodValidationPipe(entrySchema)) body: z.infer<typeof entrySchema>): Promise<SpamListEntryDto> {
    return this.spam.add(this.target, body.kind, body.pattern);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ZodValidationPipe(z.uuid())) id: string): Promise<void> {
    await this.spam.remove(this.target, id);
  }
}

/** Everyone with a mailbox: their own thresholds and lists (the webmail's spam settings). */
@Controller('me/spam')
export class MySpamController {
  constructor(@Inject(SpamService) private readonly spam: SpamService) {}

  @Get()
  async get(@CurrentSession() session: AuthSession): Promise<SpamScores & { entries: SpamListEntryDto[] }> {
    const target = await this.spam.ownTarget(session.user.id);
    return { ...target.scores, entries: await this.spam.list(target) };
  }

  @Put('scores')
  setScores(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(spamScoresSchema)) body: SpamScores,
  ): Promise<SpamScores> {
    return this.spam.setOwnScores(session.user.id, body);
  }

  @Post('entries')
  async add(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(entrySchema)) body: z.infer<typeof entrySchema>,
  ): Promise<SpamListEntryDto> {
    return this.spam.add(await this.spam.ownTarget(session.user.id), body.kind, body.pattern);
  }

  @Delete('entries/:id')
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthSession,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<void> {
    await this.spam.remove(await this.spam.ownTarget(session.user.id), id);
  }
}

@Module({
  controllers: [OrgSpamListsController, GlobalSpamListsController, MySpamController],
  providers: [SpamService, OrgAccessGuard],
  exports: [SpamService],
})
export class SpamModule {}
