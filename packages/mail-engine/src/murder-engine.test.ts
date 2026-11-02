import { describe, expect, it } from 'vitest';
import { MemoryMailEngine } from './memory-engine.js';
import { MurderEngine } from './murder-engine.js';
import { MailEngineError } from './types.js';

function setup() {
  const one = new MemoryMailEngine();
  const two = new MemoryMailEngine();
  const placed = new Map<string, string>();
  const engine = new MurderEngine({
    propagationMs: 0,
    backends: { one, two },
    locate: async (address) => placed.get(address) ?? null,
    place: async (address, names) => {
      // Fewest mailboxes first.
      const counts = names.map((n) => [...placed.values()].filter((v) => v === n).length);
      const name = names[counts.indexOf(Math.min(...counts))]!;
      placed.set(address, name);
      return name;
    },
  });
  return { engine, one, two, placed };
}

describe('MurderEngine', () => {
  it('creates each mailbox on the backend it places it on, and reaches it there', async () => {
    const { engine, one, two } = setup();
    await engine.createMailbox('a@example.com', { quotaBytes: null });
    await engine.createMailbox('b@example.com', { quotaBytes: 1000 });
    expect([...one.mailboxes.keys()]).toEqual(['a@example.com']);
    expect([...two.mailboxes.keys()]).toEqual(['b@example.com']);
    expect(await engine.getUsage('b@example.com')).toEqual({ usedBytes: 0, quotaBytes: 1000 });
    await engine.setShares('a@example.com', 'calendar', 'Default', [{ grantee: 'c@example.com', access: 'read' }]);
    expect(await one.listShares('a@example.com', 'calendar', 'Default')).toHaveLength(1);
    await engine.deleteMailbox('b@example.com');
    expect(two.mailboxes.size).toBe(0);
  });

  it('reports unknown mailboxes as not found', async () => {
    const { engine } = setup();
    await expect(engine.getUsage('nobody@example.com')).rejects.toMatchObject({ code: 'not_found' });
    await expect(engine.getUsage('nobody@example.com')).rejects.toBeInstanceOf(MailEngineError);
  });

  it('moves a mailbox to another backend and records it there', async () => {
    const servers: Record<string, MemoryMailEngine> = {};
    class Backend extends MemoryMailEngine {
      async transfer(address: string, server: string) {
        const target = servers[server]!;
        target.mailboxes.set(address, this.mailboxes.get(address)!);
        this.mailboxes.delete(address);
      }
    }
    const one = new Backend();
    const two = new Backend();
    servers['cyrus-1'] = one;
    servers['cyrus-2'] = two;
    const placed = new Map<string, string>();
    const engine = new MurderEngine({
      propagationMs: 0,
      backends: { one, two },
      serverNames: { one: 'cyrus-1', two: 'cyrus-2' },
      locate: async (address) => placed.get(address) ?? null,
      place: async (address) => (placed.set(address, 'one'), 'one'),
      relocate: async (address, backend) => void placed.set(address, backend),
    });
    await engine.createMailbox('a@example.com', { quotaBytes: 1000 });
    await engine.moveMailbox('a@example.com', 'two');
    expect(one.mailboxes.size).toBe(0);
    expect([...two.mailboxes.keys()]).toEqual(['a@example.com']);
    expect(placed.get('a@example.com')).toBe('two');
    expect(await engine.getUsage('a@example.com')).toEqual({ usedBytes: 0, quotaBytes: 1000 });
    await expect(engine.moveMailbox('a@example.com', 'three')).rejects.toMatchObject({ code: 'rejected' });
    await expect(engine.moveMailbox('nobody@example.com', 'one')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is healthy only when every backend is', async () => {
    const { engine } = setup();
    expect(await engine.health()).toEqual({ ok: true });
  });
});
