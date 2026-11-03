import { HttpException, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { CounterStore } from '../core/counter-store.js';
import { COUNTER_STORE, DATABASE, RATE_LIMIT_STORE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { domains, mailboxes, type RatePeriod, ratePeriods } from '../db/schema/index.js';

/**
 * Sending rate limits: how many messages a mailbox may send per second,
 * minute, hour or day. A mailbox's own limit, else its domain's (applied to
 * each of its mailboxes). Rspamd enforces them for mail apps (SMTP), reading
 * them from Valkey; the API enforces them for the webmail. Both count in the
 * same Valkey counters (see rspamd.local.lua, POSTARIX_RATELIMIT).
 */
export interface RateLimit {
  messages: number;
  per: RatePeriod;
}

export const rateLimitSchema = z
  .strictObject({
    messages: z.number().int().min(1).max(1_000_000),
    per: z.enum(Object.keys(ratePeriods) as [RatePeriod, ...RatePeriod[]]),
  })
  .nullable();

export function toRateLimit(row: { rateLimit: number | null; ratePeriod: RatePeriod | null }): RateLimit | null {
  return row.rateLimit !== null && row.ratePeriod !== null ? { messages: row.rateLimit, per: row.ratePeriod } : null;
}

export function rateColumns(limit: RateLimit | null): { rateLimit: number | null; ratePeriod: RatePeriod | null } {
  return limit ? { rateLimit: limit.messages, ratePeriod: limit.per } : { rateLimit: null, ratePeriod: null };
}

/** Valkey hash read by Rspamd: field = address or "@domain", value = "<messages>:<seconds>". */
export const RATE_LIMITS_HASH = 'POSTARIX_RATELIMITS';

/** The counter key (without the CounterStore's "postarix:" prefix) for a sender in the current window. */
export function rateCounterKey(address: string, seconds: number, now = Date.now()): string {
  return `ratelimit:${address}:${seconds}:${Math.floor(now / 1000 / seconds)}`;
}

export interface RateLimitStore {
  set(key: string, limit: RateLimit | null): Promise<void>;
  replaceAll(limits: Map<string, RateLimit>): Promise<void>;
  close(): Promise<void>;
}

const encode = (limit: RateLimit) => `${limit.messages}:${ratePeriods[limit.per]}`;

export class ValkeyRateLimitStore implements RateLimitStore {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }

  async set(key: string, limit: RateLimit | null): Promise<void> {
    if (limit) await this.client.hset(RATE_LIMITS_HASH, key, encode(limit));
    else await this.client.hdel(RATE_LIMITS_HASH, key);
  }

  async replaceAll(limits: Map<string, RateLimit>): Promise<void> {
    const pipeline = this.client.multi().del(RATE_LIMITS_HASH);
    if (limits.size > 0) {
      pipeline.hset(RATE_LIMITS_HASH, Object.fromEntries([...limits].map(([key, limit]) => [key, encode(limit)])));
    }
    await pipeline.exec();
  }

  async close(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly limits = new Map<string, string>();

  async set(key: string, limit: RateLimit | null): Promise<void> {
    if (limit) this.limits.set(key, encode(limit));
    else this.limits.delete(key);
  }

  async replaceAll(limits: Map<string, RateLimit>): Promise<void> {
    this.limits.clear();
    for (const [key, limit] of limits) this.limits.set(key, encode(limit));
  }

  async close(): Promise<void> {}
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class RateLimitsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RateLimitsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(COUNTER_STORE) private readonly counters: CounterStore,
  ) {}

  /** Publishes a mailbox's ("ann@example.com") or domain's ("@example.com") limit; failures are healed by the sync. */
  async publish(key: string, limit: RateLimit | null): Promise<void> {
    try {
      await this.store.set(key, limit);
    } catch (error) {
      this.logger.error(`Cannot publish the rate limit of ${key}: ${(error as Error).message}`);
    }
  }

  /**
   * Counts one message sent by the mailbox through the webmail, refusing it
   * (429) over the mailbox's limit or, without one, its domain's.
   */
  async take(address: string): Promise<void> {
    const limit = await this.limitOf(address);
    if (!limit) return;
    const seconds = ratePeriods[limit.per];
    const count = await this.counters.increment(rateCounterKey(address, seconds), seconds * 1000);
    if (count > limit.messages) {
      throw new HttpException(`Sending limit reached (${limit.messages} messages per ${limit.per}); try again later`, 429);
    }
  }

  private async limitOf(address: string): Promise<RateLimit | null> {
    const [row] = await this.db
      .select({
        rateLimit: mailboxes.rateLimit,
        ratePeriod: mailboxes.ratePeriod,
        domainLimit: domains.rateLimit,
        domainPeriod: domains.ratePeriod,
      })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(eq(mailboxes.address, address))
      .limit(1);
    if (!row) return null;
    return toRateLimit(row) ?? toRateLimit({ rateLimit: row.domainLimit, ratePeriod: row.domainPeriod });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Rewrites every published limit from the database, so Valkey converges after restarts or missed updates. */
  async sync(): Promise<void> {
    try {
      const limits = new Map<string, RateLimit>();
      const domainRows = await this.db
        .select({ name: domains.name, rateLimit: domains.rateLimit, ratePeriod: domains.ratePeriod })
        .from(domains)
        .where(and(isNotNull(domains.rateLimit), inArray(domains.status, ['active'])));
      for (const row of domainRows) limits.set(`@${row.name}`, toRateLimit(row)!);
      const mailboxRows = await this.db
        .select({ address: mailboxes.address, rateLimit: mailboxes.rateLimit, ratePeriod: mailboxes.ratePeriod })
        .from(mailboxes)
        .where(isNotNull(mailboxes.rateLimit));
      for (const row of mailboxRows) limits.set(row.address, toRateLimit(row)!);
      await this.store.replaceAll(limits);
    } catch (error) {
      this.logger.error(`Rate limit synchronisation failed: ${(error as Error).message}`);
    }
  }
}
