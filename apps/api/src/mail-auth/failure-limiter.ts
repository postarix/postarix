import type { CounterStore } from '../core/counter-store.js';

/**
 * Counts failed logins per key within a time window and blocks the key once
 * the limit is reached, even for correct passwords, until the window expires.
 * The counters live in the shared counter store (Valkey in production), so
 * every API instance sees the same ones.
 */
export interface FailureLimits {
  maxFailures: number;
  windowMs: number;
}

export class FailureLimiter {
  private readonly limits: () => Promise<FailureLimits>;

  /** `limits` is fixed, or read each time (instance settings can change it). */
  constructor(
    private readonly store: CounterStore,
    private readonly name: string,
    limits: FailureLimits | (() => Promise<FailureLimits>),
  ) {
    this.limits = typeof limits === 'function' ? limits : async () => limits;
  }

  private key(subject: string): string {
    return `fail:${this.name}:${subject.toLowerCase()}`;
  }

  async isBlocked(subject: string): Promise<boolean> {
    return (await this.store.count(this.key(subject))) >= (await this.limits()).maxFailures;
  }

  async recordFailure(subject: string): Promise<void> {
    await this.store.increment(this.key(subject), (await this.limits()).windowMs);
  }

  async recordSuccess(subject: string): Promise<void> {
    await this.store.delete(this.key(subject));
  }
}
