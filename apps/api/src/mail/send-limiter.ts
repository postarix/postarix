import type { CounterStore } from '../core/counter-store.js';

/**
 * Quota per key within a fixed window (messages and recipients sent per
 * hour), in the shared counter store so it holds across API instances.
 */
export class SendLimiter {
  constructor(
    private readonly store: CounterStore,
    private readonly name: string,
    private readonly maxWeight: number,
    private readonly windowMs: number,
  ) {}

  /** Records `weight` units for `key` if they fit in the window; returns false otherwise. */
  tryTake(key: string, weight: number): Promise<boolean> {
    return this.store.tryAdd(`quota:${this.name}:${key}`, weight, this.maxWeight, this.windowMs);
  }
}
