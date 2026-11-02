interface Entry {
  failures: number;
  windowStart: number;
}

/**
 * Counts failed logins per key within a time window and blocks the key once
 * the limit is reached, even for correct passwords, until the window expires.
 *
 * In memory for now (single API instance); it will move to Valkey so several
 * API replicas share the counters.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.current(key);
    return entry !== undefined && entry.failures >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const entry = this.current(key);
    if (entry) entry.failures += 1;
    else this.entries.set(key, { failures: 1, windowStart: this.now() });
    if (this.entries.size > 100_000) this.prune();
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private current(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.windowStart >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    for (const key of this.entries.keys()) this.current(key);
  }
}
