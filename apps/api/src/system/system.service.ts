import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, SYSTEM_STORE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type Heartbeat, type QueueSnapshot, type ReportingService, reportingServices, type SystemStore } from './system-store.js';

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
@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);
  private readonly startedAt = new Date();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(SYSTEM_STORE) private readonly store: SystemStore,
  ) {}

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
    for (const service of reportingServices) {
      const beat = (await this.store.heartbeat(service).catch(() => null)) as StoredHeartbeat | null;
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

  /** The newest lines of a service's log (oldest first), optionally only those containing `filter`. */
  async logs(service: ReportingService, limit: number, filter: string | undefined): Promise<string[]> {
    const lines = await this.store.readLog(service, filter ? 5000 : limit);
    if (!filter) return lines;
    const needle = filter.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(needle)).slice(-limit);
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
