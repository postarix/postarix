import type { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import type { CounterStore } from '../src/core/counter-store.js';
import { COUNTER_STORE, HASH_STORE } from '../src/core/tokens.js';
import {
  FILTER_RULES_HASH,
  FORWARDING_HOSTS_HASH,
  ForwardingHostsService,
  IpAccessService,
  normalizeNetwork,
} from '../src/policies/policies.js';
import type { MemoryHashStore } from '../src/spam/spam-store.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('Server-wide mail policies: forwarding hosts, IP access, lockouts, content rules', () => {
  let app: INestApplication;
  let store: MemoryHashStore;
  let root: TestAgent;
  let org: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  const suffix = Date.now().toString(36);

  const hash = (name: string) => store.hashes.get(name) ?? new Map<string, string>();

  beforeAll(async () => {
    app = await startApp();
    store = app.get<MemoryHashStore>(HASH_STORE);
    app.get(ForwardingHostsService).resolve = async (name) => {
      if (name === `relay-${suffix}.example.test`) return ['192.0.2.55', '2001:db8::55'];
      throw new Error('ENOTFOUND');
    };
    const email = `policies-root-${suffix}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    org = await mailboxInNewOrg(app, 'policies');
  });

  afterAll(async () => {
    await app.close();
  });

  it('normalizes addresses and networks', () => {
    expect(normalizeNetwork(' 203.0.113.0/24 ')).toBe('203.0.113.0/24');
    expect(normalizeNetwork('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(normalizeNetwork('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeNetwork('203.0.113.0/33')).toBeNull();
    expect(normalizeNetwork('example.com')).toBeNull();
  });

  it('keeps forwarding hosts and publishes their networks for Rspamd', async () => {
    const net = await root.post('/api/system/forwarding-hosts').send({ host: '198.51.100.0/28', note: 'Gateway' }).expect(201);
    const name = await root
      .post('/api/system/forwarding-hosts')
      .send({ host: `Relay-${suffix}.example.test.`, spamFilter: false })
      .expect(201);
    expect(name.body.host).toBe(`relay-${suffix}.example.test`);
    expect(name.body.addresses).toEqual(['192.0.2.55', '2001:db8::55']);
    await root.post('/api/system/forwarding-hosts').send({ host: '198.51.100.0/28' }).expect(409);
    await root.post('/api/system/forwarding-hosts').send({ host: 'not a host!' }).expect(400);

    expect(hash(FORWARDING_HOSTS_HASH).get('198.51.100.0/28')).toBe('1');
    expect(hash(FORWARDING_HOSTS_HASH).get('192.0.2.55')).toBe('0');
    expect(hash(FORWARDING_HOSTS_HASH).get('2001:db8::55')).toBe('0');

    await root.patch(`/api/system/forwarding-hosts/${net.body.id}`).send({ enabled: false }).expect(200);
    expect(hash(FORWARDING_HOSTS_HASH).has('198.51.100.0/28')).toBe(false);
    const list = await root.get('/api/system/forwarding-hosts').expect(200);
    expect(list.body.data.map((h: { host: string }) => h.host)).toEqual(expect.arrayContaining(['198.51.100.0/28', `relay-${suffix}.example.test`]));

    await root.delete(`/api/system/forwarding-hosts/${net.body.id}`).expect(204);
    await root.delete(`/api/system/forwarding-hosts/${name.body.id}`).expect(204);
    expect(hash(FORWARDING_HOSTS_HASH).has('192.0.2.55')).toBe(false);
  });

  it('keeps allowed and blocked networks, and the API refuses blocked ones', async () => {
    const access = app.get(IpAccessService);
    const block = await root.post('/api/system/ip-access').send({ network: '203.0.113.0/24', kind: 'block', note: 'Abuse' }).expect(201);
    const allow = await root.post('/api/system/ip-access').send({ network: '2001:DB8:1::/48', kind: 'allow' }).expect(201);
    expect(allow.body.network).toBe('2001:db8:1::/48');
    await root.post('/api/system/ip-access').send({ network: '203.0.113.0/24', kind: 'block' }).expect(409);
    await root.post('/api/system/ip-access').send({ network: '300.1.1.1', kind: 'block' }).expect(400);
    // Never one's own address (tests connect from 127.0.0.1).
    const own = await root.post('/api/system/ip-access').send({ network: '127.0.0.0/8', kind: 'block' }).expect(422);
    expect(own.body.message).toMatch(/your own address/);

    expect(access.isBlocked('203.0.113.77')).toBe(true);
    expect(access.isBlocked('::ffff:203.0.113.77')).toBe(true);
    expect(access.isBlocked('198.51.100.1')).toBe(false);
    expect(access.isAllowed('2001:db8:1::9')).toBe(true);

    await root.patch(`/api/system/ip-access/${block.body.id}`).send({ enabled: false }).expect(200);
    expect(access.isBlocked('203.0.113.77')).toBe(false);
    const list = await root.get('/api/system/ip-access').expect(200);
    expect(list.body.data.find((e: { id: string }) => e.id === block.body.id).enabled).toBe(false);
    await root.delete(`/api/system/ip-access/${block.body.id}`).expect(204);
    await root.delete(`/api/system/ip-access/${allow.body.id}`).expect(204);
  });

  it('lists sign-in lockouts and lifts them', async () => {
    const counters = app.get<CounterStore>(COUNTER_STORE);
    const subject = `locked-${suffix}@example.test`;
    for (let i = 0; i < 10; i++) await counters.increment(`fail:mail-login:${subject}`, 60_000);
    await counters.increment(`fail:web-sign-in:almost-${suffix}@example.test`, 60_000);

    const list = await root.get('/api/system/lockouts').expect(200);
    const locked = list.body.data.find((l: { subject: string }) => l.subject === subject);
    expect(locked).toMatchObject({ kind: 'mail-login', failures: 10, locked: true });
    expect(list.body.data.find((l: { subject: string }) => l.subject === `almost-${suffix}@example.test`)).toMatchObject({ locked: false, failures: 1 });

    await root.delete(`/api/system/lockouts/mail-login/${encodeURIComponent(subject)}`).expect(204);
    expect(await counters.count(`fail:mail-login:${subject}`)).toBe(0);
  });

  it('keeps content rules and publishes them for Rspamd', async () => {
    const subject = await root.post('/api/system/filter-rules').send({ target: 'subject', pattern: `^win a (car|prize) ${suffix}`, action: 'reject' }).expect(201);
    const header = await root.post('/api/system/filter-rules').send({ target: 'header', header: 'X-Mailer', pattern: 'BulkBlaster', action: 'junk' }).expect(201);
    await root.post('/api/system/filter-rules').send({ target: 'header', pattern: 'x', action: 'junk' }).expect(400);
    await root.post('/api/system/filter-rules').send({ target: 'subject', pattern: '(unclosed', action: 'junk' }).expect(400);

    expect(hash(FILTER_RULES_HASH).get(subject.body.id)).toBe(`reject|subject||^win a (car|prize) ${suffix}`);
    expect(hash(FILTER_RULES_HASH).get(header.body.id)).toBe('junk|header|x-mailer|BulkBlaster');

    await root.patch(`/api/system/filter-rules/${header.body.id}`).send({ enabled: false }).expect(200);
    expect(hash(FILTER_RULES_HASH).has(header.body.id)).toBe(false);
    await root.delete(`/api/system/filter-rules/${subject.body.id}`).expect(204);
    await root.delete(`/api/system/filter-rules/${header.body.id}`).expect(204);
    expect(hash(FILTER_RULES_HASH).has(subject.body.id)).toBe(false);
  });

  it('is for instance administrators only', async () => {
    for (const path of ['forwarding-hosts', 'ip-access', 'lockouts', 'filter-rules']) {
      await org.owner.agent.get(`/api/system/${path}`).expect(404);
    }
    await org.owner.agent.post('/api/system/ip-access').send({ network: '192.0.2.0/24', kind: 'allow' }).expect(404);
  });
});
