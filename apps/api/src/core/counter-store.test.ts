import { describe, expect, it } from 'vitest';
import { MemoryCounterStore, ValkeyCounterStore, type CounterStore } from './counter-store.js';

const behaves = (name: string, make: () => CounterStore | null) =>
  describe(name, () => {
    const store = make();
    it.skipIf(!store)('counts within a window and caps weighted additions', async () => {
      const s = store!;
      const key = `test:${name}:${Date.now()}:${Math.random()}`;
      expect(await s.increment(key, 60_000)).toBe(1);
      expect(await s.increment(key, 60_000)).toBe(2);
      expect(await s.count(key)).toBe(2);
      await s.delete(key);
      expect(await s.count(key)).toBe(0);

      expect(await s.tryAdd(`${key}:q`, 3, 5, 60_000)).toBe(true);
      expect(await s.tryAdd(`${key}:q`, 3, 5, 60_000)).toBe(false);
      expect(await s.tryAdd(`${key}:q`, 2, 5, 60_000)).toBe(true);
      expect(await s.count(`${key}:q`)).toBe(5);

      await s.setValue(`${key}:v`, 'hello', 60_000);
      expect(await s.getValue(`${key}:v`)).toBe('hello');
      await s.close();
    });
  });

describe('counter store', () => {
  it('forgets counters once their window is over (memory)', async () => {
    let now = 1_000;
    const store = new MemoryCounterStore(() => now);
    await store.increment('k', 100);
    now += 50;
    expect(await store.increment('k', 100)).toBe(2);
    now += 60;
    expect(await store.count('k')).toBe(0);
    expect(await store.increment('k', 100)).toBe(1);
  });

  behaves('memory', () => new MemoryCounterStore());
  // Runs when a Valkey/Redis is available to the tests.
  behaves('valkey', () => (process.env.TEST_VALKEY_URL ? new ValkeyCounterStore(process.env.TEST_VALKEY_URL) : null));
});
