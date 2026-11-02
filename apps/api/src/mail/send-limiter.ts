/** Sliding-window quota per key (messages and recipients sent per hour). */
export class SendLimiter {
  private readonly events = new Map<string, { at: number; weight: number }[]>();

  constructor(
    private readonly maxWeight: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records `weight` units for `key` if they fit in the window; returns false otherwise. */
  tryTake(key: string, weight: number): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.events.get(key) ?? []).filter((event) => event.at > cutoff);
    const used = recent.reduce((sum, event) => sum + event.weight, 0);
    if (used + weight > this.maxWeight) {
      this.events.set(key, recent);
      return false;
    }
    recent.push({ at: this.now(), weight });
    this.events.set(key, recent);
    if (this.events.size > 50_000) this.events.clear();
    return true;
  }
}
