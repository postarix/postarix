import { Redis } from 'ioredis';

/**
 * Short-lived counters and values shared by every API instance: login failure
 * counters, sending quotas and Better Auth's rate limiter. Kept in Valkey when
 * VALKEY_URL is set (always in production), so the limits hold across
 * replicas and restarts; in memory otherwise (development and tests).
 */
export interface CounterStore {
  /** Adds 1 to the counter (created with the window as its lifetime); returns the new value. */
  increment(key: string, windowMs: number): Promise<number>;
  /** Adds `weight` if the counter stays at or below `max` within its window; returns whether it did. */
  tryAdd(key: string, weight: number, max: number, windowMs: number): Promise<boolean>;
  count(key: string): Promise<number>;
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Counters whose key starts with `prefix` (at most `max`), with their time left. */
  list(prefix: string, max?: number): Promise<{ key: string; value: string; ttlMs: number }[]>;
  close(): Promise<void>;
}

const PREFIX = 'postarix:';

// Atomic "add if it fits": KEYS[1] counter, ARGV weight, max, window (ms).
const TRY_ADD = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local weight = tonumber(ARGV[1])
if current + weight > tonumber(ARGV[2]) then return 0 end
local value = redis.call('INCRBY', KEYS[1], weight)
if value == weight then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 1`;

export class ValkeyCounterStore implements CounterStore {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3, keyPrefix: PREFIX });
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const [[, value]] = (await this.client.multi().incr(key).pexpire(key, windowMs, 'NX').exec()) as [[Error | null, number]];
    return value;
  }

  async tryAdd(key: string, weight: number, max: number, windowMs: number): Promise<boolean> {
    return (await this.client.eval(TRY_ADD, 1, key, weight, max, windowMs)) === 1;
  }

  async count(key: string): Promise<number> {
    return Number((await this.client.get(key)) ?? 0);
  }

  getValue(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setValue(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async list(prefix: string, max = 1000): Promise<{ key: string; value: string; ttlMs: number }[]> {
    // SCAN matches full key names: the client's key prefix is not applied.
    const pattern = `${PREFIX}${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      keys.push(...batch.map((k) => k.slice(PREFIX.length)));
    } while (cursor !== '0' && keys.length < max);
    const found = keys.slice(0, max);
    if (found.length === 0) return [];
    const pipeline = this.client.multi();
    for (const key of found) pipeline.get(key).pttl(key);
    const results = ((await pipeline.exec()) ?? []).map(([, value]) => value);
    return found
      .map((key, i) => ({ key, value: results[i * 2] as string | null, ttlMs: Number(results[i * 2 + 1]) }))
      .filter((e): e is { key: string; value: string; ttlMs: number } => e.value !== null);
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }
}

export class MemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlMs: number | null): void {
    const existing = this.entries.get(key);
    const expiresAt = ttlMs === null && existing && existing.expiresAt > this.now() ? existing.expiresAt : this.now() + (ttlMs ?? 0);
    this.entries.set(key, { value, expiresAt });
    if (this.entries.size > 100_000) {
      for (const k of this.entries.keys()) this.read(k);
    }
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const current = this.read(key);
    const value = Number(current ?? 0) + 1;
    this.write(key, String(value), current === null ? windowMs : null);
    return value;
  }

  async tryAdd(key: string, weight: number, max: number, windowMs: number): Promise<boolean> {
    const current = this.read(key);
    const used = Number(current ?? 0);
    if (used + weight > max) return false;
    this.write(key, String(used + weight), current === null ? windowMs : null);
    return true;
  }

  async count(key: string): Promise<number> {
    return Number(this.read(key) ?? 0);
  }

  async getValue(key: string): Promise<string | null> {
    return this.read(key);
  }

  async setValue(key: string, value: string, ttlMs: number): Promise<void> {
    this.write(key, value, ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(prefix: string, max = 1000): Promise<{ key: string; value: string; ttlMs: number }[]> {
    const out: { key: string; value: string; ttlMs: number }[] = [];
    for (const key of [...this.entries.keys()]) {
      if (out.length >= max) break;
      if (!key.startsWith(prefix)) continue;
      const value = this.read(key);
      if (value !== null) out.push({ key, value, ttlMs: this.entries.get(key)!.expiresAt - this.now() });
    }
    return out;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}
