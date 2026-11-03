import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { ENV } from '../core/tokens.js';

/** What Rspamd decided, in the words the admin panel uses. */
export type ScanOutcome = 'delivered' | 'spam' | 'greylisted' | 'deferred' | 'rejected';

const OUTCOMES: Record<string, ScanOutcome> = {
  'no action': 'delivered',
  'add header': 'spam',
  'rewrite subject': 'spam',
  greylist: 'greylisted',
  'soft reject': 'deferred',
  reject: 'rejected',
};

interface RspamdRow {
  unix_time?: number;
  'message-id'?: string;
  rcpt_smtp?: string[] | string;
  sender_smtp?: string;
  sender_mime?: string;
  subject?: string;
  score?: number;
  required_score?: number;
  action?: string;
  symbols?: Record<string, { score?: number }>;
  ip?: string;
  user?: string;
  size?: number;
  time_real?: number;
}

export interface ScanDto {
  id: string;
  time: string;
  from: string;
  to: string[];
  subject: string;
  outcome: ScanOutcome;
  action: string;
  score: number;
  requiredScore: number;
  reasons: { name: string; score: number }[];
  ip: string | null;
  /** The account that sent it (authenticated mail), else null. */
  user: string | null;
  sizeBytes: number | null;
  scanMs: number | null;
}

export interface RspamdStatsDto {
  version: string | null;
  uptimeSeconds: number | null;
  scanned: number;
  learned: number;
  spamCount: number;
  hamCount: number;
  connections: number;
  actions: Record<string, number>;
}

/** Messages per hour of the last day, by outcome (oldest hour first). */
export interface TrafficDto {
  hours: { hour: string; delivered: number; spam: number; rejected: number; greylisted: number; outgoing: number }[];
  totals: { delivered: number; spam: number; rejected: number; greylisted: number; outgoing: number };
}

/**
 * Rspamd's controller, for instance administrators: the whole filtering
 * history and statistics (organizations only see their own part, see
 * MailLogService). Uses the read-only controller password.
 */
@Injectable()
export class RspamdService {
  private readonly logger = new Logger(RspamdService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.RSPAMD_CONTROLLER_URL && this.env.RSPAMD_CONTROLLER_PASSWORD);
  }

  private async get<T>(path: string): Promise<T> {
    const base = this.env.RSPAMD_CONTROLLER_URL;
    const password = this.env.RSPAMD_CONTROLLER_PASSWORD;
    if (!base || !password) throw new ServiceUnavailableException('The spam filter is not configured on this server');
    try {
      const response = await fetch(new URL(path, base), { headers: { password }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Rspamd answered ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      this.logger.warn(`Rspamd ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('The spam filter is unavailable');
    }
  }

  private async rows(): Promise<RspamdRow[]> {
    const body = await this.get<{ rows?: RspamdRow[] } | RspamdRow[]>('/history?from=0&to=4999');
    const rows = Array.isArray(body) ? body : (body.rows ?? []);
    return rows.sort((a, b) => (b.unix_time ?? 0) - (a.unix_time ?? 0));
  }

  async history(limit: number, filter?: string): Promise<ScanDto[]> {
    const needle = filter?.toLowerCase();
    const out: ScanDto[] = [];
    for (const row of await this.rows()) {
      const scan = toScan(row, out.length);
      if (needle && ![scan.from, scan.subject, scan.ip ?? '', scan.user ?? '', ...scan.to].some((v) => v.toLowerCase().includes(needle))) continue;
      out.push(scan);
      if (out.length >= limit) break;
    }
    return out;
  }

  async stats(): Promise<RspamdStatsDto> {
    const stat = await this.get<{
      version?: string;
      uptime?: number;
      scanned?: number;
      learned?: number;
      spam_count?: number;
      ham_count?: number;
      connections?: number;
      actions?: Record<string, number>;
    }>('/stat');
    return {
      version: stat.version ?? null,
      uptimeSeconds: stat.uptime ?? null,
      scanned: stat.scanned ?? 0,
      learned: stat.learned ?? 0,
      spamCount: stat.spam_count ?? 0,
      hamCount: stat.ham_count ?? 0,
      connections: stat.connections ?? 0,
      actions: stat.actions ?? {},
    };
  }

  /** The last 24 hours of the history, per hour. */
  async traffic(now = new Date()): Promise<TrafficDto> {
    const end = Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000;
    const start = end - 24 * 3_600_000;
    const hours = Array.from({ length: 24 }, (_, i) => ({
      hour: new Date(start + i * 3_600_000).toISOString(),
      delivered: 0,
      spam: 0,
      rejected: 0,
      greylisted: 0,
      outgoing: 0,
    }));
    const totals = { delivered: 0, spam: 0, rejected: 0, greylisted: 0, outgoing: 0 };
    for (const row of await this.rows()) {
      const ms = (row.unix_time ?? 0) * 1000;
      if (ms < start || ms >= end) continue;
      const bucket = hours[Math.floor((ms - start) / 3_600_000)]!;
      const outgoing = Boolean(row.user) && row.user !== 'unknown';
      const outcome = OUTCOMES[row.action ?? ''] ?? 'delivered';
      const key = outgoing ? 'outgoing' : outcome === 'deferred' ? 'greylisted' : outcome;
      bucket[key]++;
      totals[key]++;
    }
    return { hours, totals };
  }
}

function toScan(row: RspamdRow, index: number): ScanDto {
  const recipients = Array.isArray(row.rcpt_smtp) ? row.rcpt_smtp : row.rcpt_smtp ? [row.rcpt_smtp] : [];
  const authenticated = Boolean(row.user) && row.user !== 'unknown';
  return {
    id: row['message-id'] ?? `${row.unix_time ?? 0}-${index}`,
    time: new Date((row.unix_time ?? 0) * 1000).toISOString(),
    from: row.sender_smtp || row.sender_mime || '',
    to: recipients,
    subject: row.subject ?? '',
    outcome: OUTCOMES[row.action ?? ''] ?? 'delivered',
    action: row.action ?? 'no action',
    score: Math.round((row.score ?? 0) * 100) / 100,
    requiredScore: row.required_score ?? 0,
    reasons: Object.entries(row.symbols ?? {})
      .map(([name, s]) => ({ name, score: Math.round((s.score ?? 0) * 100) / 100 }))
      .filter((r) => r.score !== 0)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 12),
    ip: row.ip ?? null,
    user: authenticated ? (row.user ?? null) : null,
    sizeBytes: row.size ?? null,
    scanMs: typeof row.time_real === 'number' ? Math.round(row.time_real * 1000) : null,
  };
}
