import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { and, desc, eq, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE, QUARANTINE_SOURCE, SYSTEM_MAILER } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailboxes, quarantineItems, type QuarantineItemRow, type QuarantineNotify, quarantineNotifyIntervals } from '../db/schema/index.js';
import { findOwnMailbox } from '../jmap/my-mailbox.js';
import { ServerJmap } from '../mail/jmap-client.js';
import type { SystemMailer } from '../mail/system-mailer.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import type { QuarantineSource } from './quarantine-source.js';

const POLL_MS = 10_000;
const HOUSEKEEPING_MS = 15 * 60 * 1000;
const PAGE = 200;

export interface QuarantineItemDto {
  id: string;
  mailboxId: string;
  recipient: string;
  envelopeFrom: string;
  fromHeader: string;
  subject: string;
  score: number;
  symbols: string[];
  sizeBytes: number;
  createdAt: string;
}

const summary = {
  id: quarantineItems.id,
  mailboxId: quarantineItems.mailboxId,
  recipient: mailboxes.address,
  envelopeFrom: quarantineItems.envelopeFrom,
  fromHeader: quarantineItems.fromHeader,
  subject: quarantineItems.subject,
  score: quarantineItems.score,
  symbols: quarantineItems.symbols,
  sizeBytes: quarantineItems.sizeBytes,
  createdAt: quarantineItems.createdAt,
};

type SummaryRow = { [K in keyof typeof summary]: K extends 'createdAt' ? Date : K extends 'recipient' ? string : QuarantineItemRow[Exclude<K, 'recipient'>] };

const toDto = (row: SummaryRow): QuarantineItemDto => ({ ...row, createdAt: row.createdAt.toISOString() });

/** Strips "+tag" and lowercases, as Postfix delivers. */
function baseAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return lower;
  return `${lower.slice(0, at).replace(/\+.*$/, '')}@${lower.slice(at + 1)}`;
}

/**
 * Spam the filter refused, kept for its recipients. Rspamd leaves each
 * refused message (up to a size) in Valkey; this service files it under each
 * hosted mailbox it was for (directly or through aliases), deletes it after
 * QUARANTINE_RETENTION_DAYS, and sends recipients a digest of new items as
 * often as their mailbox asks. Released mail goes to the inbox.
 */
@Injectable()
export class QuarantineService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QuarantineService.name);
  private timers: NodeJS.Timeout[] = [];
  private polling = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(QUARANTINE_SOURCE) private readonly source: QuarantineSource,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    const poll = setInterval(() => void this.collect(), POLL_MS);
    const housekeeping = setInterval(() => void this.housekeeping(), HOUSEKEEPING_MS);
    poll.unref();
    housekeeping.unref();
    this.timers = [poll, housekeeping];
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  /** Files the messages Rspamd refused since the last call. */
  async collect(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    let filed = 0;
    try {
      for (;;) {
        const batch = await this.source.take(50);
        if (batch.length === 0) break;
        for (const { meta, raw } of batch) {
          if (!raw) continue;
          const targets = await this.recipients(meta.recipients.map(baseAddress));
          for (const target of targets) {
            await this.db.insert(quarantineItems).values({
              organizationId: target.organizationId,
              mailboxId: target.id,
              envelopeFrom: String(meta.envelopeFrom ?? '').slice(0, 320),
              fromHeader: String(meta.fromHeader ?? '').slice(0, 320),
              subject: String(meta.subject ?? '').slice(0, 500),
              score: Number(meta.score) || 0,
              symbols: (Array.isArray(meta.symbols) ? meta.symbols : []).map(String).slice(0, 20),
              sizeBytes: raw.length,
              message: raw,
            });
            filed++;
          }
        }
      }
    } catch (error) {
      this.logger.error(`Could not file quarantined mail: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
    return filed;
  }

  /** Hosted mailboxes the addresses deliver to: the mailboxes themselves, through aliases, or a catch-all. */
  private async recipients(addresses: string[]): Promise<{ id: string; organizationId: string }[]> {
    const destinations = new Set<string>();
    for (const address of new Set(addresses)) {
      const lookup = async (key: string) =>
        (await this.db.execute<{ destination: string }>(sql`SELECT destination FROM mail.aliases WHERE address = ${key}`)).rows.map(
          (r) => r.destination,
        );
      let found = await lookup(address);
      if (found.length === 0) found = await lookup(address.slice(address.lastIndexOf('@')));
      for (const destination of found) destinations.add(baseAddress(destination));
    }
    if (destinations.size === 0) return [];
    return this.db
      .select({ id: mailboxes.id, organizationId: mailboxes.organizationId })
      .from(mailboxes)
      .where(inArray(mailboxes.address, [...destinations]));
  }

  /** Deletes expired items and sends the digests that are due. */
  async housekeeping(now = new Date()): Promise<void> {
    try {
      const cutoff = new Date(now.getTime() - this.env.QUARANTINE_RETENTION_DAYS * 86_400_000);
      await this.db.delete(quarantineItems).where(lt(quarantineItems.createdAt, cutoff));
      await this.notify(now);
    } catch (error) {
      this.logger.error(`Quarantine housekeeping failed: ${(error as Error).message}`);
    }
  }

  /** Tells each mailbox about its new items, at most as often as it asks (hourly, daily, weekly). */
  async notify(now = new Date()): Promise<number> {
    const due = { hourly: 3600_000, daily: 86_400_000, weekly: 7 * 86_400_000 } as const;
    const rows = await this.db
      .select({ ...summary, notify: mailboxes.quarantineNotify })
      .from(quarantineItems)
      .innerJoin(mailboxes, eq(mailboxes.id, quarantineItems.mailboxId))
      .where(and(isNull(quarantineItems.notifiedAt), inArray(mailboxes.quarantineNotify, ['hourly', 'daily', 'weekly'])))
      .orderBy(quarantineItems.createdAt);
    const byMailbox = new Map<string, typeof rows>();
    for (const row of rows) byMailbox.set(row.mailboxId, [...(byMailbox.get(row.mailboxId) ?? []), row]);
    let sent = 0;
    for (const items of byMailbox.values()) {
      const interval = due[items[0]!.notify as keyof typeof due];
      // The oldest unannounced item must have waited a whole interval.
      if (now.getTime() - items[0]!.createdAt.getTime() < interval) continue;
      const lines = items.slice(0, 50).map((i) => `- ${i.createdAt.toISOString().slice(0, 16).replace('T', ' ')}  ${i.fromHeader || i.envelopeFrom || '(no sender)'}: ${i.subject || '(no subject)'}`);
      await this.mailer.send({
        to: items[0]!.recipient,
        subject: `${items.length} message${items.length === 1 ? '' : 's'} held as spam`,
        text: [
          `The spam filter refused ${items.length === 1 ? 'this message' : 'these messages'} for ${items[0]!.recipient}:`,
          '',
          ...lines,
          items.length > 50 ? `…and ${items.length - 50} more.` : '',
          '',
          `If one of them is not spam, release it to your inbox in the webmail (your menu → Quarantine) within ${this.env.QUARANTINE_RETENTION_DAYS} days.`,
        ]
          .filter((l, i, all) => l !== '' || all[i - 1] !== '')
          .join('\n'),
      });
      await this.db
        .update(quarantineItems)
        .set({ notifiedAt: now })
        .where(inArray(quarantineItems.id, items.map((i) => i.id)));
      sent++;
    }
    return sent;
  }

  async listForMailboxes(where: SQL): Promise<QuarantineItemDto[]> {
    const rows = await this.db
      .select(summary)
      .from(quarantineItems)
      .innerJoin(mailboxes, eq(mailboxes.id, quarantineItems.mailboxId))
      .where(where)
      .orderBy(desc(quarantineItems.createdAt))
      .limit(PAGE);
    return rows.map(toDto);
  }

  async find(where: SQL): Promise<(QuarantineItemRow & { recipient: string }) | undefined> {
    const [row] = await this.db
      .select({ item: quarantineItems, recipient: mailboxes.address })
      .from(quarantineItems)
      .innerJoin(mailboxes, eq(mailboxes.id, quarantineItems.mailboxId))
      .where(where)
      .limit(1);
    return row ? { ...row.item, recipient: row.recipient } : undefined;
  }

  /** Puts the message in its recipient's inbox, and takes it out of quarantine. */
  async release(item: QuarantineItemRow & { recipient: string }): Promise<void> {
    const jmap = new ServerJmap(this.engine, item.recipient);
    const { list } = await jmap.single<{ list: { id: string; role: string | null }[] }>('Mailbox/get', { properties: ['role'] });
    const inbox = list.find((m) => m.role === 'inbox');
    if (!inbox) throw new NotFoundException('The mailbox has no inbox');
    const blobId = await jmap.upload(item.message, 'message/rfc822');
    await jmap.single('Email/import', { emails: { m: { blobId, mailboxIds: { [inbox.id]: true }, keywords: {} } } });
    await this.db.delete(quarantineItems).where(eq(quarantineItems.id, item.id));
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(quarantineItems).where(eq(quarantineItems.id, id));
  }
}

const idPipe = new ZodValidationPipe(z.uuid());

/** Organization admins: quarantined mail of the organization's mailboxes. */
@Controller('orgs/:orgId/quarantine')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class OrgQuarantineController {
  constructor(
    @Inject(QuarantineService) private readonly quarantine: QuarantineService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private scope(ctx: TenantContext, id?: string) {
    const org = eq(quarantineItems.organizationId, ctx.organizationId);
    return id ? and(org, eq(quarantineItems.id, id))! : org;
  }

  @Get()
  async list(
    @Tenant() ctx: TenantContext,
    @Query(new ZodValidationPipe(z.object({ mailboxId: z.uuid().optional() }))) query: { mailboxId?: string },
  ): Promise<{ data: QuarantineItemDto[] }> {
    const where = query.mailboxId ? and(this.scope(ctx), eq(quarantineItems.mailboxId, query.mailboxId))! : this.scope(ctx);
    return { data: await this.quarantine.listForMailboxes(where) };
  }

  @Get(':id/message')
  @Header('Content-Type', 'message/rfc822')
  async download(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<StreamableFile> {
    const item = await this.quarantine.find(this.scope(ctx, id));
    if (!item) throw new NotFoundException('Not in quarantine');
    return new StreamableFile(item.message, { disposition: 'attachment; filename="quarantined.eml"' });
  }

  @Post(':id/release')
  @HttpCode(204)
  async release(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    const item = await this.quarantine.find(this.scope(ctx, id));
    if (!item) throw new NotFoundException('Not in quarantine');
    await this.quarantine.release(item);
    await this.audit.record(ctx, 'quarantine.released', { type: 'mailbox', id: item.mailboxId, label: item.recipient }, { subject: item.subject });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    const item = await this.quarantine.find(this.scope(ctx, id));
    if (!item) throw new NotFoundException('Not in quarantine');
    await this.quarantine.remove(item.id);
  }
}

/** Everyone with a mailbox: their own quarantined mail and how often they hear about it. */
@Controller('me/quarantine')
export class MyQuarantineController {
  constructor(
    @Inject(QuarantineService) private readonly quarantine: QuarantineService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  private async mailbox(session: AuthSession): Promise<{ id: string; notify: string }> {
    const address = await findOwnMailbox(this.db, session.user.id);
    if (!address) throw new NotFoundException('You have no mailbox');
    const [row] = await this.db
      .select({ id: mailboxes.id, notify: mailboxes.quarantineNotify })
      .from(mailboxes)
      .where(eq(mailboxes.address, address));
    if (!row) throw new NotFoundException('You have no mailbox');
    return row;
  }

  @Get()
  async list(@CurrentSession() session: AuthSession): Promise<{ data: QuarantineItemDto[]; notify: string }> {
    const mailbox = await this.mailbox(session);
    return { data: await this.quarantine.listForMailboxes(eq(quarantineItems.mailboxId, mailbox.id)), notify: mailbox.notify };
  }

  @Put('notify')
  @HttpCode(204)
  async setNotify(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(z.strictObject({ every: z.enum(quarantineNotifyIntervals) }))) body: { every: QuarantineNotify },
  ): Promise<void> {
    const mailbox = await this.mailbox(session);
    await this.db.update(mailboxes).set({ quarantineNotify: body.every }).where(eq(mailboxes.id, mailbox.id));
  }

  @Post(':id/release')
  @HttpCode(204)
  async release(@CurrentSession() session: AuthSession, @Param('id', idPipe) id: string): Promise<void> {
    const mailbox = await this.mailbox(session);
    const item = await this.quarantine.find(and(eq(quarantineItems.mailboxId, mailbox.id), eq(quarantineItems.id, id))!);
    if (!item) throw new NotFoundException('Not in quarantine');
    await this.quarantine.release(item);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() session: AuthSession, @Param('id', idPipe) id: string): Promise<void> {
    const mailbox = await this.mailbox(session);
    const item = await this.quarantine.find(and(eq(quarantineItems.mailboxId, mailbox.id), eq(quarantineItems.id, id))!);
    if (!item) throw new NotFoundException('Not in quarantine');
    await this.quarantine.remove(item.id);
  }
}

@Module({
  controllers: [OrgQuarantineController, MyQuarantineController],
  providers: [QuarantineService, OrgAccessGuard],
  exports: [QuarantineService],
})
export class QuarantineModule {}

