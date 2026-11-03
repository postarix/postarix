import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { CounterStore } from '../core/counter-store.js';
import { COUNTER_STORE, DATABASE, HASH_STORE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import {
  type FilterRuleRow,
  filterActions,
  filterRules,
  filterTargets,
  type ForwardingHostRow,
  forwardingHosts,
  ipAccess,
  ipAccessKinds,
  type IpAccessRow,
} from '../db/schema/index.js';
import { InstanceSettingsModule, InstanceSettingsService } from '../settings/instance-settings.js';
import type { HashStore } from '../spam/spam-store.js';

/** Valkey hashes Rspamd reads (see rspamd.local.lua). */
export const FORWARDING_HOSTS_HASH = 'POSTARIX_FORWARDING_HOSTS';
export const FILTER_RULES_HASH = 'POSTARIX_FILTER_RULES';

const SYNC_INTERVAL_MS = 10 * 60_000;
const IP_ACCESS_REFRESH_MS = 30_000;

// --- Shared --------------------------------------------------------------------

/** "203.0.113.7" or "203.0.113.0/24" (also IPv6), normalized; null when it is neither. */
export function normalizeNetwork(value: string): string | null {
  const [address = '', bits, ...rest] = value.trim().toLowerCase().split('/');
  if (rest.length > 0) return null;
  const version = isIP(address);
  if (!version) return null;
  if (bits === undefined) return address;
  if (!/^\d{1,3}$/.test(bits)) return null;
  const n = Number(bits);
  if (n > (version === 4 ? 32 : 128)) return null;
  return `${address}/${n}`;
}

function blockListOf(networks: string[]): BlockList {
  const list = new BlockList();
  for (const network of networks) {
    const [base, bits] = network.split('/');
    const family = isIP(base!) === 6 ? 'ipv6' : 'ipv4';
    try {
      if (bits === undefined) list.addAddress(base!, family);
      else list.addSubnet(base!, Number(bits), family);
    } catch {
      // A malformed row is skipped rather than break every check.
    }
  }
  return list;
}

function plainAddress(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function matches(list: BlockList, ip: string | undefined): boolean {
  if (!ip) return false;
  const address = plainAddress(ip);
  const version = isIP(address);
  if (!version) return false;
  return list.check(address, version === 6 ? 'ipv6' : 'ipv4');
}

const networkSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const network = normalizeNetwork(value);
    if (!network) {
      ctx.addIssue({ code: 'custom', message: 'Use an IP address or a network such as 203.0.113.0/24' });
      return z.NEVER;
    }
    return network;
  });

const noteSchema = z.string().trim().max(200).default('');

function actorOf(session: AuthSession, req: Request) {
  return { userId: session.user.id, userEmail: session.user.email, ipAddress: req.ip ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

// --- Forwarding hosts ------------------------------------------------------------

const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((value, ctx) => {
    const network = normalizeNetwork(value);
    if (network) return network;
    const name = value.replace(/\.$/, '');
    if (/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name)) return name;
    ctx.addIssue({ code: 'custom', message: 'Use an IP address, a network such as 203.0.113.0/24, or a host name' });
    return z.NEVER;
  });

export const forwardingHostSchema = z.strictObject({
  host: hostSchema,
  spamFilter: z.boolean().default(true),
  note: noteSchema,
});
const forwardingHostUpdateSchema = z
  .strictObject({ spamFilter: z.boolean(), enabled: z.boolean(), note: z.string().trim().max(200) })
  .partial();

export interface ForwardingHostDto {
  id: string;
  host: string;
  spamFilter: boolean;
  enabled: boolean;
  note: string;
  /** For a host name: the addresses it had at the last check. */
  addresses: string[];
  createdAt: string;
}

type Resolve = (name: string) => Promise<string[]>;

const resolveName: Resolve = async (name) => (await lookup(name, { all: true, verbatim: true })).map((a) => a.address);

@Injectable()
export class ForwardingHostsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ForwardingHostsService.name);
  private timer: NodeJS.Timeout | undefined;
  /** Host name → its addresses at the last check. */
  private readonly resolved = new Map<string, string[]>();
  /** Replaced by tests. */
  resolve: Resolve = resolveName;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HASH_STORE) private readonly store: HashStore,
  ) {}

  private toDto(row: ForwardingHostRow): ForwardingHostDto {
    return {
      id: row.id,
      host: row.host,
      spamFilter: row.spamFilter,
      enabled: row.enabled,
      note: row.note,
      addresses: normalizeNetwork(row.host) ? [] : (this.resolved.get(row.host) ?? []),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(): Promise<ForwardingHostDto[]> {
    const rows = await this.db.select().from(forwardingHosts).orderBy(asc(forwardingHosts.host));
    return rows.map((r) => this.toDto(r));
  }

  async add(input: z.infer<typeof forwardingHostSchema>): Promise<ForwardingHostDto> {
    let row: ForwardingHostRow | undefined;
    try {
      [row] = await this.db.insert(forwardingHosts).values(input).returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This host is already listed');
      throw error;
    }
    await this.sync();
    return this.toDto(row!);
  }

  async update(id: string, change: z.infer<typeof forwardingHostUpdateSchema>): Promise<ForwardingHostDto> {
    const [row] = await this.db.update(forwardingHosts).set(change).where(eq(forwardingHosts.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.sync();
    return this.toDto(row);
  }

  async remove(id: string): Promise<ForwardingHostRow> {
    const [row] = await this.db.delete(forwardingHosts).where(eq(forwardingHosts.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.sync();
    return row;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Publishes every enabled host's networks (host names resolved again). */
  async sync(): Promise<void> {
    try {
      const rows = await this.db.select().from(forwardingHosts).where(eq(forwardingHosts.enabled, true));
      const published = new Map<string, string>();
      for (const row of rows) {
        let networks: string[];
        if (normalizeNetwork(row.host)) {
          networks = [row.host];
        } else {
          try {
            networks = await this.resolve(row.host);
            this.resolved.set(row.host, networks);
          } catch {
            // Keep the last known addresses when the name does not resolve now.
            networks = this.resolved.get(row.host) ?? [];
          }
        }
        // With the filter off anywhere, it is off for that network.
        for (const network of networks) {
          if (published.get(network) !== '0') published.set(network, row.spamFilter ? '1' : '0');
        }
      }
      await this.store.replaceAll(FORWARDING_HOSTS_HASH, published);
    } catch (error) {
      this.logger.error(`Forwarding hosts synchronisation failed: ${(error as Error).message}`);
    }
  }
}

@Controller('system/forwarding-hosts')
@UseGuards(SuperAdminGuard)
export class ForwardingHostsController {
  constructor(
    @Inject(ForwardingHostsService) private readonly hosts: ForwardingHostsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<{ data: ForwardingHostDto[] }> {
    return { data: await this.hosts.list() };
  }

  @Post()
  async add(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(forwardingHostSchema)) body: z.infer<typeof forwardingHostSchema>,
  ): Promise<ForwardingHostDto> {
    const host = await this.hosts.add(body);
    await this.audit.recordInstance(actorOf(session, req), 'forwarding_host.added', { type: 'forwarding_host', id: host.id, label: host.host });
    return host;
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(forwardingHostUpdateSchema)) body: z.infer<typeof forwardingHostUpdateSchema>,
  ): Promise<ForwardingHostDto> {
    const host = await this.hosts.update(id, body);
    await this.audit.recordInstance(actorOf(session, req), 'forwarding_host.changed', { type: 'forwarding_host', id, label: host.host }, body);
    return host;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<void> {
    const row = await this.hosts.remove(id);
    await this.audit.recordInstance(actorOf(session, req), 'forwarding_host.removed', { type: 'forwarding_host', id, label: row.host });
  }
}

// --- IP access ------------------------------------------------------------------------

export const ipAccessSchema = z.strictObject({
  network: networkSchema,
  kind: z.enum(ipAccessKinds),
  note: noteSchema,
});
const ipAccessUpdateSchema = z.strictObject({ enabled: z.boolean(), note: z.string().trim().max(200) }).partial();

export interface IpAccessDto {
  id: string;
  network: string;
  kind: IpAccessRow['kind'];
  note: string;
  enabled: boolean;
  createdAt: string;
}

const ipAccessDto = (row: IpAccessRow): IpAccessDto => ({
  id: row.id,
  network: row.network,
  kind: row.kind,
  note: row.note,
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Allowed and blocked networks. Postfix reads them itself (mail.client_access);
 * the API refuses blocked addresses on every route but the internal ones.
 */
@Injectable()
export class IpAccessService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IpAccessService.name);
  private blocked = new BlockList();
  private allowed = new BlockList();
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<IpAccessDto[]> {
    const rows = await this.db.select().from(ipAccess).orderBy(asc(ipAccess.kind), asc(ipAccess.network));
    return rows.map(ipAccessDto);
  }

  async add(input: z.infer<typeof ipAccessSchema>, requesterIp: string | undefined): Promise<IpAccessDto> {
    if (input.kind === 'block' && matches(blockListOf([input.network]), requesterIp)) {
      throw new UnprocessableEntityException('This would block your own address');
    }
    let row: IpAccessRow | undefined;
    try {
      [row] = await this.db.insert(ipAccess).values(input).returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This network is already listed');
      throw error;
    }
    await this.refresh();
    return ipAccessDto(row!);
  }

  async update(id: string, change: z.infer<typeof ipAccessUpdateSchema>, requesterIp: string | undefined): Promise<IpAccessDto> {
    if (change.enabled) {
      const [current] = await this.db.select().from(ipAccess).where(eq(ipAccess.id, id));
      if (current?.kind === 'block' && matches(blockListOf([current.network]), requesterIp)) {
        throw new UnprocessableEntityException('This would block your own address');
      }
    }
    const [row] = await this.db.update(ipAccess).set(change).where(eq(ipAccess.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.refresh();
    return ipAccessDto(row);
  }

  async remove(id: string): Promise<IpAccessRow> {
    const [row] = await this.db.delete(ipAccess).where(eq(ipAccess.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.refresh();
    return row;
  }

  /** Whether the API refuses this client (blocked, and not also allowed more precisely: a block wins). */
  isBlocked(ip: string | undefined): boolean {
    return matches(this.blocked, ip);
  }

  isAllowed(ip: string | undefined): boolean {
    return matches(this.allowed, ip);
  }

  async refresh(): Promise<void> {
    try {
      const rows = await this.db.select().from(ipAccess).where(eq(ipAccess.enabled, true));
      this.blocked = blockListOf(rows.filter((r) => r.kind === 'block').map((r) => r.network));
      this.allowed = blockListOf(rows.filter((r) => r.kind === 'allow').map((r) => r.network));
    } catch (error) {
      this.logger.error(`Reading the IP access lists failed: ${(error as Error).message}`);
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), IP_ACCESS_REFRESH_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Express middleware: refuses blocked clients (never the internal routes, which the mail containers use). */
  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (req.path.startsWith('/api/internal') || req.path === '/api/health' || !this.isBlocked(req.ip)) {
      next();
      return;
    }
    res.status(403).json({ statusCode: 403, message: 'Access from your network is refused' });
  };
}

// --- Sign-in lockouts ------------------------------------------------------------------

/** The failure counters of FailureLimiter (see mail-auth/failure-limiter.ts). */
const LOCKOUT_KINDS = { 'web-sign-in': 'Panel and webmail', 'mail-login': 'Mail apps (IMAP, SMTP)' } as const;
type LockoutKind = keyof typeof LOCKOUT_KINDS;

export interface LockoutDto {
  kind: LockoutKind;
  /** The account (an address). */
  subject: string;
  failures: number;
  /** Refused until it expires (even with the right password). */
  locked: boolean;
  expiresAt: string;
}

@Injectable()
export class LockoutsService {
  constructor(
    @Inject(COUNTER_STORE) private readonly counters: CounterStore,
    @Inject(InstanceSettingsService) private readonly settings: InstanceSettingsService,
  ) {}

  async list(): Promise<LockoutDto[]> {
    const { maxFailures } = (await this.settings.get()).signIn;
    const out: LockoutDto[] = [];
    for (const kind of Object.keys(LOCKOUT_KINDS) as LockoutKind[]) {
      for (const entry of await this.counters.list(`fail:${kind}:`, 500)) {
        const failures = Number(entry.value);
        if (!Number.isFinite(failures) || failures <= 0) continue;
        out.push({
          kind,
          subject: entry.key.slice(`fail:${kind}:`.length),
          failures,
          locked: failures >= maxFailures,
          expiresAt: new Date(Date.now() + Math.max(0, entry.ttlMs)).toISOString(),
        });
      }
    }
    return out.sort((a, b) => Number(b.locked) - Number(a.locked) || b.failures - a.failures);
  }

  async clear(kind: LockoutKind, subject: string): Promise<void> {
    await this.counters.delete(`fail:${kind}:${subject.toLowerCase()}`);
  }
}

@Controller('system')
@UseGuards(SuperAdminGuard)
export class IpAccessController {
  constructor(
    @Inject(IpAccessService) private readonly access: IpAccessService,
    @Inject(LockoutsService) private readonly lockouts: LockoutsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('ip-access')
  async list(): Promise<{ data: IpAccessDto[] }> {
    return { data: await this.access.list() };
  }

  @Post('ip-access')
  async add(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(ipAccessSchema)) body: z.infer<typeof ipAccessSchema>,
  ): Promise<IpAccessDto> {
    const entry = await this.access.add(body, req.ip);
    await this.audit.recordInstance(actorOf(session, req), `ip_access.${body.kind}_added`, { type: 'ip_access', id: entry.id, label: entry.network });
    return entry;
  }

  @Patch('ip-access/:id')
  async update(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(ipAccessUpdateSchema)) body: z.infer<typeof ipAccessUpdateSchema>,
  ): Promise<IpAccessDto> {
    const entry = await this.access.update(id, body, req.ip);
    await this.audit.recordInstance(actorOf(session, req), 'ip_access.changed', { type: 'ip_access', id, label: entry.network }, body);
    return entry;
  }

  @Delete('ip-access/:id')
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<void> {
    const row = await this.access.remove(id);
    await this.audit.recordInstance(actorOf(session, req), 'ip_access.removed', { type: 'ip_access', id, label: row.network });
  }

  @Get('lockouts')
  async listLockouts(): Promise<{ data: LockoutDto[] }> {
    return { data: await this.lockouts.list() };
  }

  @Delete('lockouts/:kind/:subject')
  @HttpCode(204)
  async clearLockout(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('kind', new ZodValidationPipe(z.enum(Object.keys(LOCKOUT_KINDS) as [LockoutKind, ...LockoutKind[]]))) kind: LockoutKind,
    @Param('subject', new ZodValidationPipe(z.string().min(1).max(320))) subject: string,
  ): Promise<void> {
    await this.lockouts.clear(kind, subject);
    await this.audit.recordInstance(actorOf(session, req), 'sign_in.unlocked', { type: 'account', label: `${subject} (${kind})` });
  }
}

// --- Content filter rules ------------------------------------------------------------------

const patternSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), 'Use one line')
  .refine((value) => {
    try {
      new RegExp(value, 'i');
      return true;
    } catch {
      return false;
    }
  }, 'This is not a valid regular expression');

export const filterRuleSchema = z
  .strictObject({
    target: z.enum(filterTargets),
    header: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,100}$/, 'Use a header name such as X-Mailer')
      .nullish(),
    pattern: patternSchema,
    action: z.enum(filterActions),
    note: noteSchema,
  })
  .refine((rule) => rule.target !== 'header' || !!rule.header, { message: 'Name the header', path: ['header'] });
const filterRuleUpdateSchema = z.strictObject({ enabled: z.boolean(), note: z.string().trim().max(200) }).partial();

export interface FilterRuleDto {
  id: string;
  target: FilterRuleRow['target'];
  header: string | null;
  pattern: string;
  action: FilterRuleRow['action'];
  note: string;
  enabled: boolean;
  createdAt: string;
}

const filterRuleDto = (row: FilterRuleRow): FilterRuleDto => ({
  id: row.id,
  target: row.target,
  header: row.header,
  pattern: row.pattern,
  action: row.action,
  note: row.note,
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class FilterRulesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FilterRulesService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HASH_STORE) private readonly store: HashStore,
  ) {}

  async list(): Promise<FilterRuleDto[]> {
    return (await this.db.select().from(filterRules).orderBy(asc(filterRules.createdAt))).map(filterRuleDto);
  }

  async add(input: z.infer<typeof filterRuleSchema>): Promise<FilterRuleDto> {
    const [row] = await this.db
      .insert(filterRules)
      .values({ ...input, header: input.target === 'header' ? input.header!.toLowerCase() : null })
      .returning();
    await this.sync();
    return filterRuleDto(row!);
  }

  async update(id: string, change: z.infer<typeof filterRuleUpdateSchema>): Promise<FilterRuleDto> {
    const [row] = await this.db.update(filterRules).set(change).where(eq(filterRules.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.sync();
    return filterRuleDto(row);
  }

  async remove(id: string): Promise<FilterRuleRow> {
    const [row] = await this.db.delete(filterRules).where(eq(filterRules.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.sync();
    return row;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Publishes the enabled rules: id → "action|target|header|regex". */
  async sync(): Promise<void> {
    try {
      const rows = await this.db.select().from(filterRules).where(eq(filterRules.enabled, true));
      await this.store.replaceAll(
        FILTER_RULES_HASH,
        new Map(rows.map((r) => [r.id, `${r.action}|${r.target}|${r.header ?? ''}|${r.pattern}`])),
      );
    } catch (error) {
      this.logger.error(`Content rules synchronisation failed: ${(error as Error).message}`);
    }
  }
}

@Controller('system/filter-rules')
@UseGuards(SuperAdminGuard)
export class FilterRulesController {
  constructor(
    @Inject(FilterRulesService) private readonly rules: FilterRulesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<{ data: FilterRuleDto[] }> {
    return { data: await this.rules.list() };
  }

  @Post()
  async add(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(filterRuleSchema)) body: z.infer<typeof filterRuleSchema>,
  ): Promise<FilterRuleDto> {
    const rule = await this.rules.add(body);
    await this.audit.recordInstance(actorOf(session, req), 'filter_rule.added', { type: 'filter_rule', id: rule.id, label: `${rule.target}: ${rule.pattern}`.slice(0, 200) });
    return rule;
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(filterRuleUpdateSchema)) body: z.infer<typeof filterRuleUpdateSchema>,
  ): Promise<FilterRuleDto> {
    const rule = await this.rules.update(id, body);
    await this.audit.recordInstance(actorOf(session, req), 'filter_rule.changed', { type: 'filter_rule', id, label: rule.pattern.slice(0, 200) }, body);
    return rule;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<void> {
    const row = await this.rules.remove(id);
    await this.audit.recordInstance(actorOf(session, req), 'filter_rule.removed', { type: 'filter_rule', id, label: row.pattern.slice(0, 200) });
  }
}

@Module({
  imports: [InstanceSettingsModule],
  controllers: [ForwardingHostsController, IpAccessController, FilterRulesController],
  providers: [ForwardingHostsService, IpAccessService, LockoutsService, FilterRulesService],
  exports: [IpAccessService],
})
export class PoliciesModule {}
