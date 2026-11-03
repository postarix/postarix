import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { count, sql } from 'drizzle-orm';
import { aliases, domains, mailboxes, organization, quarantineItems, user } from '../db/schema/index.js';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, SYSTEM_STORE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type LogEntry, type LogLevel, parseLogLine } from './log-parse.js';
import { type Heartbeat, type LogService, type QueueSnapshot, type ReportingService, type SystemStore } from './system-store.js';

/** A report older than this means the container stopped reporting (it reports every 15 s). */
const STALE_AFTER_MS = 2 * 60 * 1000;
const MAX_LINE = 2000;
const QUEUE_ID = /^[0-9A-Za-z]{5,32}$/;

export const queueActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['deliver', 'hold', 'release', 'delete']),
    ids: z.array(z.string().regex(QUEUE_ID)).min(1).max(1000),
  }),
  z.strictObject({ action: z.enum(['flush', 'delete-all']) }),
]);
export type QueueActionInput = z.infer<typeof queueActionSchema>;

export const heartbeatSchema = z.object({
  version: z.string().max(100).nullable().default(null),
  host: z.string().max(253).nullable().default(null),
  disk: z
    .object({ path: z.string().max(200), usedBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() })
    .nullable()
    .default(null),
});

export type ServiceState = 'ok' | 'down' | 'unknown';

export interface ServiceStatusDto {
  name: string;
  state: ServiceState;
  detail: string | null;
  version: string | null;
  checkedAt: string | null;
  disk: { path: string; usedBytes: number; totalBytes: number } | null;
}

export interface OverviewDto {
  hostname: string;
  version: string | null;
  uptimeSeconds: number;
  counts: { organizations: number; domains: number; pendingDomains: number; mailboxes: number; aliases: number; users: number; quarantined: number };
  queue: { at: string | null; messages: number; held: number; deferred: number };
  services: { ok: number; down: number; unknown: number };
  disks: { service: string; path: string; usedBytes: number; totalBytes: number }[];
}

export interface QueueItemDto {
  id: string;
  queue: string;
  arrivedAt: string | null;
  sizeBytes: number;
  sender: string;
  recipients: { address: string; reason: string | null }[];
}

interface StoredHeartbeat extends Heartbeat {
  disk?: { path: string; usedBytes: number; totalBytes: number } | null;
}

/** Strips control characters (terminal escapes) and caps the length. */
function cleanLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_LINE);
}

/**
 * What instance administrators see of the running system: the state of each
 * service, recent logs of the mail containers, and the mail queue. The mail
 * containers report to the API (logs, queue, heartbeat) instead of the API
 * reaching into them: no container gets the Docker socket, and none exposes
 * anything new.
 */
/** Services shown on the status page from their reports (Rspamd is asked directly). */
const REPORTED: { name: ReportingService; optional: boolean }[] = [
  { name: 'postfix', optional: false },
  { name: 'cyrus', optional: false },
  { name: 'unbound', optional: false },
  { name: 'certs', optional: true },
  { name: 'clamav', optional: true },
  { name: 'crowdsec', optional: true },
];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

@Injectable()
export class SystemService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SystemService.name);
  private readonly startedAt = new Date();
  private apiLines: string[] = [];
  private apiPartial = '';
  private apiTimer: NodeJS.Timeout | undefined;
  private restoreOutput: (() => void) | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(SYSTEM_STORE) private readonly store: SystemStore,
  ) {}

  /**
   * The API's own log: whatever it prints is also kept (like the containers'
   * reports), so the admin panel shows it next to the others.
   */
  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    const streams = [process.stdout, process.stderr];
    const originals = streams.map((stream) => stream.write.bind(stream));
    streams.forEach((stream, i) => {
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        this.captureApiOutput(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (originals[i] as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
    });
    this.restoreOutput = () => streams.forEach((stream, i) => (stream.write = originals[i] as typeof stream.write));
    this.apiTimer = setInterval(() => void this.flushApiLog(), 2000);
    this.apiTimer.unref();
  }

  onApplicationShutdown(): void {
    this.restoreOutput?.();
    if (this.apiTimer) clearInterval(this.apiTimer);
  }

  /** Collects printed output into lines (kept until the next flush). */
  captureApiOutput(text: string): void {
    const parts = (this.apiPartial + text.replace(ANSI, '')).split('\n');
    this.apiPartial = parts.pop() ?? '';
    for (const line of parts) {
      const clean = cleanLine(line.replace(/\r$/, ''));
      if (clean.trim()) this.apiLines.push(clean);
    }
    if (this.apiLines.length > 2000) this.apiLines = this.apiLines.slice(-2000);
  }

  async flushApiLog(): Promise<void> {
    if (this.apiLines.length === 0) return;
    const lines = this.apiLines;
    this.apiLines = [];
    await this.store.appendLog('api', lines).catch(() => undefined);
  }

  // --- Reports from the mail containers -----------------------------------

  async report(service: ReportingService, text: string, heartbeat: z.infer<typeof heartbeatSchema>): Promise<void> {
    const lines = text
      .split('\n')
      .map((line) => cleanLine(line.replace(/\r$/, '')))
      .filter((line) => line.length > 0);
    await this.store.appendLog(service, lines);
    const stored: StoredHeartbeat = { at: new Date().toISOString(), version: heartbeat.version, host: heartbeat.host, disk: heartbeat.disk };
    await this.store.setHeartbeat(service, stored);
  }

  /** Stores Postfix's queue (`postqueue -j` output) and hands back the actions waiting for it. */
  async reportQueue(text: string): Promise<string[]> {
    const items: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        // A truncated last line: skip it.
      }
      if (items.length >= 5000) break;
    }
    await this.store.setQueue({ at: new Date().toISOString(), items });
    return this.store.takeQueueActions();
  }

  // --- For instance administrators ----------------------------------------

  async status(): Promise<ServiceStatusDto[]> {
    const now = new Date().toISOString();
    const result: ServiceStatusDto[] = [
      {
        name: 'api',
        state: 'ok',
        detail: `Running since ${this.startedAt.toISOString()}`,
        version: process.env.POSTARIX_VERSION ?? null,
        checkedAt: now,
        disk: null,
      },
      await this.check('postgres', async () => {
        const rows = await this.db.execute<{ version: string }>(sql`SELECT current_setting('server_version') AS version`);
        return { version: rows.rows[0]?.version ?? null };
      }),
      await this.check('valkey', async () => {
        if (!this.env.VALKEY_URL) return { state: 'unknown' as const, detail: 'Not configured' };
        if (!(await this.store.ping())) throw new Error('No answer');
        return {};
      }),
      await this.check('rspamd', async () => {
        const base = this.env.RSPAMD_CONTROLLER_URL;
        const password = this.env.RSPAMD_CONTROLLER_PASSWORD;
        if (!base || !password) return { state: 'unknown' as const, detail: 'Not configured' };
        const response = await fetch(new URL('/stat', base), { headers: { password }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Answered ${response.status}`);
        const stat = (await response.json()) as { scanned?: number; version?: string };
        return { version: stat.version ?? null, detail: stat.scanned !== undefined ? `${stat.scanned} messages scanned` : null };
      }),
    ];
    for (const { name: service, optional } of REPORTED) {
      const beat = (await this.store.heartbeat(service).catch(() => null)) as StoredHeartbeat | null;
      // Optional services (virus scanning, CrowdSec…) only appear once they report.
      if (!beat && optional) continue;
      const fresh = beat !== null && Date.now() - Date.parse(beat.at) < STALE_AFTER_MS;
      result.push({
        name: service,
        state: fresh ? 'ok' : beat ? 'down' : 'unknown',
        detail: beat ? `Last report ${beat.at}${beat.host ? ` from ${beat.host}` : ''}` : 'No report yet',
        version: beat?.version ?? null,
        checkedAt: beat?.at ?? null,
        disk: beat?.disk ?? null,
      });
    }
    return result;
  }

  private async check(
    name: string,
    probe: () => Promise<{ state?: ServiceState; detail?: string | null; version?: string | null }>,
  ): Promise<ServiceStatusDto> {
    const checkedAt = new Date().toISOString();
    try {
      const out = await probe();
      return { name, state: out.state ?? 'ok', detail: out.detail ?? null, version: out.version ?? null, checkedAt, disk: null };
    } catch (error) {
      this.logger.warn(`Status check of ${name} failed: ${(error as Error).message}`);
      return { name, state: 'down', detail: (error as Error).message, version: null, checkedAt, disk: null };
    }
  }

  /**
   * The newest entries of a service's log (oldest first), parsed, optionally
   * only those containing `filter` and at least as serious as `level`.
   */
  async logEntries(service: LogService, limit: number, filter: string | undefined, level: LogLevel | undefined): Promise<LogEntry[]> {
    if (service === 'api') await this.flushApiLog();
    const lines = await this.store.readLog(service, filter || level ? 5000 : limit);
    const needle = filter?.toLowerCase();
    const now = new Date();
    const min = level ? LEVEL_RANK[level] : 0;
    const out: LogEntry[] = [];
    for (const line of lines) {
      if (needle && !line.toLowerCase().includes(needle)) continue;
      const entry = parseLogLine(line, now);
      if (LEVEL_RANK[entry.level] < min) continue;
      out.push(entry);
    }
    return out.slice(-limit);
  }

  /** The newest lines of a service's log (oldest first), optionally only those containing `filter`. */
  async logs(service: LogService, limit: number, filter: string | undefined): Promise<string[]> {
    if (service === 'api') await this.flushApiLog();
    const lines = await this.store.readLog(service, filter ? 5000 : limit);
    if (!filter) return lines;
    const needle = filter.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(needle)).slice(-limit);
  }

  /** The instance at a glance, for the dashboard. */
  async overview(): Promise<OverviewDto> {
    const one = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
    const [organizations, allDomains, pendingDomains, mailboxCount, aliasCount, users, quarantined] = await Promise.all([
      one(this.db.select({ n: count() }).from(organization)),
      one(this.db.select({ n: count() }).from(domains)),
      one(this.db.select({ n: count() }).from(domains).where(sql`${domains.status} = 'pending'`)),
      one(this.db.select({ n: count() }).from(mailboxes)),
      // Temporary addresses count too; the identity rows of mailboxes are not aliases.
      one(this.db.select({ n: count() }).from(aliases)),
      one(this.db.select({ n: count() }).from(user)),
      one(this.db.select({ n: count() }).from(quarantineItems)),
    ]);
    const status = await this.status();
    const queue = await this.queue();
    return {
      hostname: this.env.MAIL_HOSTNAME,
      version: process.env.POSTARIX_VERSION ?? null,
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      counts: { organizations, domains: allDomains, pendingDomains, mailboxes: mailboxCount, aliases: aliasCount, users, quarantined },
      queue: {
        at: queue.at,
        messages: queue.items.length,
        held: queue.items.filter((i) => i.queue === 'hold').length,
        deferred: queue.items.filter((i) => i.queue === 'deferred').length,
      },
      services: {
        ok: status.filter((s) => s.state === 'ok').length,
        down: status.filter((s) => s.state === 'down').length,
        unknown: status.filter((s) => s.state === 'unknown').length,
      },
      disks: status.flatMap((s) => (s.disk ? [{ service: s.name, ...s.disk }] : [])),
    };
  }

  async queue(): Promise<{ at: string | null; items: QueueItemDto[] }> {
    const snapshot: QueueSnapshot | null = await this.store.queue();
    if (!snapshot) return { at: null, items: [] };
    return { at: snapshot.at, items: snapshot.items.map(toQueueItem).filter((item): item is QueueItemDto => item !== null) };
  }

  /** Queues the action for Postfix, which runs it with its next report (within about 15 seconds). */
  async queueAction(input: QueueActionInput): Promise<void> {
    if (!('ids' in input)) {
      await this.store.pushQueueAction(input.action);
      return;
    }
    for (const id of input.ids) await this.store.pushQueueAction(`${input.action} ${id}`);
  }
}

function toQueueItem(raw: unknown): QueueItemDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as {
    queue_name?: unknown;
    queue_id?: unknown;
    arrival_time?: unknown;
    message_size?: unknown;
    sender?: unknown;
    recipients?: unknown;
  };
  if (typeof item.queue_id !== 'string') return null;
  const recipients = Array.isArray(item.recipients)
    ? item.recipients.map((r: { address?: unknown; delay_reason?: unknown }) => ({
        address: typeof r.address === 'string' ? r.address : '',
        reason: typeof r.delay_reason === 'string' ? r.delay_reason : null,
      }))
    : [];
  return {
    id: item.queue_id,
    queue: typeof item.queue_name === 'string' ? item.queue_name : 'unknown',
    arrivedAt: typeof item.arrival_time === 'number' ? new Date(item.arrival_time * 1000).toISOString() : null,
    sizeBytes: typeof item.message_size === 'number' ? item.message_size : 0,
    sender: typeof item.sender === 'string' ? item.sender : '',
    recipients,
  };
}
