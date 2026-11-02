import { createPublicKey } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE, DKIM_PUBLISHER } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { dkimKeys } from '../src/db/schema/index.js';
import { type MemoryDkimPublisher, ValkeyDkimPublisher } from '../src/dkim/dkim-publisher.js';
import { decryptPrivateKey, encryptPrivateKey } from '../src/dkim/dkim-crypto.js';
import { DkimService } from '../src/dkim/dkim.service.js';
import { createOrg, signUp, startApp, type TestUser } from './helpers.js';

const publicKeyOf = (pem: string) =>
  createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');

describe('DKIM keys', () => {
  let app: INestApplication;
  let publisher: MemoryDkimPublisher;
  let alice: TestUser;
  let orgA: string;

  beforeAll(async () => {
    app = await startApp();
    publisher = app.get<MemoryDkimPublisher>(DKIM_PUBLISHER);
    alice = await signUp(app, 'dkim-alice');
    orgA = await createOrg(alice, 'DkimA');
  });

  afterAll(async () => {
    await app.close();
  });

  async function createDomain(name: string) {
    const res = await alice.agent.post(`/api/orgs/${orgA}/domains`).send({ name }).expect(201);
    return res.body as { id: string; name: string };
  }

  it('generates a key for every new domain, stored encrypted', async () => {
    const domain = await createDomain(`dkim-${Date.now()}.example`);
    const [key] = await app
      .get<Database>(DATABASE)
      .select()
      .from(dkimKeys)
      .where(eq(dkimKeys.domainId, domain.id));
    expect(key?.selector).toMatch(/^px\d{6}$/);
    expect(key?.privateKeyEncrypted).toMatch(/^v1:/);
    expect(key?.privateKeyEncrypted).not.toContain('PRIVATE KEY');
  });

  it('publishes the key only once the domain is active, and the pair matches the DNS record', async () => {
    const domain = await createDomain(`dkim-pub-${Date.now()}.example`);
    expect(publisher.selectors.has(domain.name)).toBe(false);

    await alice.agent.post(`/api/orgs/${orgA}/domains/${domain.id}/verify`).expect(200);
    const selector = publisher.selectors.get(domain.name);
    expect(selector).toBeDefined();
    const pem = publisher.keys.get(`${selector}.${domain.name}`)!;
    expect(pem).toContain('BEGIN PRIVATE KEY');

    const records = await alice.agent.get(`/api/orgs/${orgA}/domains/${domain.id}/dns-records`).expect(200);
    const dkim = records.body.data.find((r: { purpose: string }) => r.purpose === 'dkim');
    expect(dkim.name).toBe(`${selector}._domainkey.${domain.name}`);
    expect(dkim.value).toBe(`v=DKIM1; k=rsa; p=${publicKeyOf(pem)}`);
    expect(JSON.stringify(records.body)).not.toContain('PRIVATE KEY');
  });

  it('lists the records to publish, including verification while pending', async () => {
    const domain = await createDomain(`dkim-dns-${Date.now()}.example`);
    const res = await alice.agent.get(`/api/orgs/${orgA}/domains/${domain.id}/dns-records`).expect(200);
    const purposes = res.body.data.map((r: { purpose: string }) => r.purpose);
    expect(purposes).toEqual(['verification', 'mx', 'spf', 'dkim', 'dmarc']);
    expect(res.body.data[1]).toMatchObject({ type: 'MX', name: domain.name, value: '10 localhost.' });
  });

  it('hides another organization’s DNS records', async () => {
    const domain = await createDomain(`dkim-iso-${Date.now()}.example`);
    const bob = await signUp(app, 'dkim-bob');
    const orgB = await createOrg(bob, 'DkimB');
    await bob.agent.get(`/api/orgs/${orgA}/domains/${domain.id}/dns-records`).expect(404);
    await bob.agent.get(`/api/orgs/${orgB}/domains/${domain.id}/dns-records`).expect(404);
  });

  it('unpublishes the key when the domain is deleted', async () => {
    const domain = await createDomain(`dkim-del-${Date.now()}.example`);
    await alice.agent.post(`/api/orgs/${orgA}/domains/${domain.id}/verify`).expect(200);
    expect(publisher.selectors.has(domain.name)).toBe(true);
    await alice.agent.delete(`/api/orgs/${orgA}/domains/${domain.id}`).expect(204);
    expect(publisher.selectors.has(domain.name)).toBe(false);
  });

  it('re-publishes active domains and drops stale entries on startup', async () => {
    const domain = await createDomain(`dkim-sync-${Date.now()}.example`);
    await alice.agent.post(`/api/orgs/${orgA}/domains/${domain.id}/verify`).expect(200);
    await app.close();

    app = await startApp();
    publisher = app.get<MemoryDkimPublisher>(DKIM_PUBLISHER);
    // A fresh in-memory publisher starts empty; bootstrap must restore the key.
    expect(publisher.selectors.has(domain.name)).toBe(true);

    // An entry for a domain that is no longer active is removed by the next sync.
    await publisher.publish('stale.example', 'px000000', 'pem');
    await app.get(DkimService).onApplicationBootstrap();
    expect(publisher.selectors.has('stale.example')).toBe(false);
    expect(publisher.keys.has('px000000.stale.example')).toBe(false);
    expect(publisher.selectors.has(domain.name)).toBe(true);
  });
});

describe('DKIM key encryption', () => {
  it('round-trips and fails with the wrong secret', () => {
    const secret = 'a'.repeat(40);
    const stored = encryptPrivateKey('-----BEGIN PRIVATE KEY-----\nabc\n', secret);
    expect(decryptPrivateKey(stored, secret)).toBe('-----BEGIN PRIVATE KEY-----\nabc\n');
    expect(() => decryptPrivateKey(stored, 'b'.repeat(40))).toThrow();
    expect(encryptPrivateKey('same', secret)).not.toBe(encryptPrivateKey('same', secret));
  });
});

const valkeyUrl = process.env.TEST_VALKEY_URL ?? 'redis://127.0.0.1:6379';

describe('ValkeyDkimPublisher', () => {
  it('writes the hashes Rspamd reads and replaces the previous selector', async () => {
    const publisher = new ValkeyDkimPublisher(valkeyUrl);
    const domain = `valkey-${Date.now()}.example`;
    try {
      await publisher.publish(domain, 'px202601', 'old-pem');
      await publisher.publish(domain, 'px202602', 'new-pem');
      expect(await publisher.publishedDomains()).toContain(domain);

      const { Redis } = await import('ioredis');
      const redis = new Redis(valkeyUrl);
      try {
        expect(await redis.hget('DKIM_SELECTORS', domain)).toBe('px202602');
        expect(await redis.hget('DKIM_KEYS', `px202602.${domain}`)).toBe('new-pem');
        expect(await redis.hget('DKIM_KEYS', `px202601.${domain}`)).toBeNull();

        await publisher.unpublish(domain);
        expect(await redis.hget('DKIM_SELECTORS', domain)).toBeNull();
        expect(await redis.hget('DKIM_KEYS', `px202602.${domain}`)).toBeNull();
      } finally {
        redis.disconnect();
      }
    } finally {
      await publisher.close();
    }
  });
});
