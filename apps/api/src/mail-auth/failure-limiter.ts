import type { CounterStore } from '../core/counter-store.js';

/**
 * Counts failed logins per key within a time window and blocks the key once
 * the limit is reached, even for correct passwords, until the window expires.
 * The counters live in the shared counter store (Valkey in production), so
 * every API instance sees the same ones.
 */
export class FailureLimiter {
  constructor(
    private readonly store: CounterStore,
    private readonly name: string,
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  private key(subject: string): string {
    return `fail:${this.name}:${subject.toLowerCase()}`;
  }

  async isBlocked(subject: string): Promise<boolean> {
    return (await this.store.count(this.key(subject))) >= this.maxFailures;
  }

  async recordFailure(subject: string): Promise<void> {
    await this.store.increment(this.key(subject), this.windowMs);
  }

  async recordSuccess(subject: string): Promise<void> {
    await this.store.delete(this.key(subject));
  }
}
