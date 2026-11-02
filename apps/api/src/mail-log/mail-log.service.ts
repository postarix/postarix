import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { ENV } from '../core/tokens.js';
import { DomainsRepository } from '../domains/domains.repository.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/** What happened to a message, in words admins use. */
export type MailOutcome = 'delivered' | 'spam' | 'greylisted' | 'deferred' | 'rejected';

export interface MailLogEntryDto {
  id: string;
  time: string;
  direction: 'in' | 'out';
  from: string;
  to: string[];
  subject: string;
  outcome: MailOutcome;
  score: number;
  requiredScore: number;
  /** The rules that weighed most towards spam, strongest first. */
  reasons: { name: string; score: number }[];
  ip: string | null;
}

interface RspamdRow {
  unix_time?: number;
  'message-id'?: string;
  rcpt_smtp?: string[] | string;
  sender_smtp?: string;
  subject?: string;
  score?: number;
  required_score?: number;
  action?: string;
  symbols?: Record<string, { score?: number }>;
  ip?: string;
  user?: string;
}

const OUTCOMES: Record<string, MailOutcome> = {
  'no action': 'delivered',
  'add header': 'spam',
  'rewrite subject': 'spam',
  greylist: 'greylisted',
  'soft reject': 'deferred',
  reject: 'rejected',
};

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/**
 * The filtering history of an organization's mail, from Rspamd's history.
 * Rspamd keeps one history for the whole instance; each organization only
 * sees messages to or from its own domains, and only its own recipients of
 * incoming messages.
 */
@Injectable()
export class MailLogService {
  private readonly logger = new Logger(MailLogService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DomainsRepository) private readonly domains: DomainsRepository,
  ) {}

  async list(ctx: TenantContext, limit: number): Promise<MailLogEntryDto[]> {
    // Only domains the organization has proven it owns, and only mail from
    // after it proved it: a pending claim costs nothing, and a domain may have
    // belonged to another organization before.
    const since = new Map<string, number>();
    for (const d of await this.domains.list(ctx)) {
      if (d.status === 'pending' || !d.verifiedAt) continue;
      since.set(d.name.toLowerCase(), d.verifiedAt.getTime() / 1000);
    }
    if (since.size === 0) return [];
    const out: MailLogEntryDto[] = [];
    for (const row of await this.history()) {
      const time = row.unix_time ?? 0;
      const ownAt = (domain: string) => time >= (since.get(domain) ?? Infinity);
      const recipients = (Array.isArray(row.rcpt_smtp) ? row.rcpt_smtp : row.rcpt_smtp ? [row.rcpt_smtp] : []).map((r) => r.toLowerCase());
      const sender = (row.sender_smtp ?? '').toLowerCase();
      const ownRecipients = recipients.filter((r) => ownAt(domainOf(r)));
      // Sent by one of the organization's accounts (authenticated) from its
      // domains. Rspamd records unauthenticated mail with the user "unknown".
      const authenticated = Boolean(row.user) && row.user !== 'unknown';
      const outgoing = authenticated && sender.includes('@') && ownAt(domainOf(sender));
      if (!outgoing && ownRecipients.length === 0) continue;
      const reasons = Object.entries(row.symbols ?? {})
        .map(([name, s]) => ({ name, score: Math.round((s.score ?? 0) * 100) / 100 }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      out.push({
        id: row['message-id'] ?? `${row.unix_time ?? 0}-${out.length}`,
        time: new Date((row.unix_time ?? 0) * 1000).toISOString(),
        direction: outgoing ? 'out' : 'in',
        from: row.sender_smtp ?? '',
        to: outgoing ? recipients : ownRecipients,
        subject: row.subject ?? '',
        outcome: OUTCOMES[row.action ?? ''] ?? 'delivered',
        score: Math.round((row.score ?? 0) * 100) / 100,
        requiredScore: row.required_score ?? 0,
        reasons,
        // A client address belongs to whoever sent the message: never show an
        // authenticated sender's address, which may be another organization's user.
        ip: outgoing || authenticated ? null : (row.ip ?? null),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private async history(): Promise<RspamdRow[]> {
    const base = this.env.RSPAMD_CONTROLLER_URL;
    const password = this.env.RSPAMD_CONTROLLER_PASSWORD;
    if (!base || !password) throw new ServiceUnavailableException('The filtering history is not configured on this server');
    try {
      const response = await fetch(new URL('/history?from=0&to=4999', base), {
        headers: { password },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Rspamd answered ${response.status}`);
      const body = (await response.json()) as { rows?: RspamdRow[] } | RspamdRow[];
      const rows = Array.isArray(body) ? body : (body.rows ?? []);
      return rows.sort((a, b) => (b.unix_time ?? 0) - (a.unix_time ?? 0));
    } catch (error) {
      this.logger.warn(`Could not read Rspamd's history: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('The spam filter is unavailable');
    }
  }
}
