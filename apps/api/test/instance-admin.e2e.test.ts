import type { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import type { DnsResolver } from '../src/core/dns.js';
import { DNS_RESOLVER, SYSTEM_MAILER } from '../src/core/tokens.js';
import type { MemorySystemMailer } from '../src/mail/system-mailer.js';
import { BroadcastService } from '../src/system/instance-admin.js';
import { authOf, mailboxInNewOrg, newAgent, PASSWORD, signIn, startApp } from './helpers.js';

describe('Instance administration: administrators, mail to every mailbox, DKIM overview', () => {
  let app: INestApplication;
  let root: TestAgent;
  let rootId: string;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  const suffix = Date.now().toString(36);
  const published = new Map<string, string[][]>();

  beforeAll(async () => {
    app = await startApp();
    app.get<DnsResolver>(DNS_RESOLVER).resolveTxt = async (name) => {
      const found = published.get(name);
      if (!found) throw Object.assign(new Error('no data'), { code: 'ENOTFOUND' });
      return found;
    };
    const email = `ia-root-${suffix}@example.test`;
    rootId = (await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' })).id;
    root = await signIn(app, email);
    a = await mailboxInNewOrg(app, 'ia-a');
    b = await mailboxInNewOrg(app, 'ia-b');
  });

  afterAll(async () => {
    await app.close();
  });

  it('adds, lists and removes instance administrators', async () => {
    const email = `ia-new-${suffix}@example.test`;
    await root.post('/api/system/admins').send({ email }).expect(422);
    await root.post('/api/system/admins').send({ email, name: 'New', password: 'short' }).expect(422);
    const created = await root.post('/api/system/admins').send({ email, name: 'New', password: PASSWORD }).expect(201);
    expect(created.body.created).toBe(true);
    await root.post('/api/system/admins').send({ email }).expect(409);

    // An existing account (an organization's owner) is promoted.
    const promoted = await root.post('/api/system/admins').send({ email: a.owner.email }).expect(201);
    expect(promoted.body).toEqual({ id: a.owner.id, created: false });
    const owner = await signIn(app, a.owner.email);
    await owner.get('/api/system/admins').expect(200);

    const list = await root.get('/api/system/admins').expect(200);
    const emails = list.body.data.map((x: { email: string }) => x.email);
    expect(emails).toEqual(expect.arrayContaining([email, a.owner.email]));

    await root.delete(`/api/system/admins/${rootId}`).expect(422);
    await root.delete(`/api/system/admins/${a.owner.id}`).expect(204);
    await owner.get('/api/system/admins').expect(401);
    await (await signIn(app, a.owner.email)).get('/api/system/admins').expect(404);
    await root.delete(`/api/system/admins/${created.body.id}`).expect(204);
    await root.delete(`/api/system/admins/${created.body.id}`).expect(404);

    // The new account can still sign in, without the rights.
    await newAgent(app).post('/api/auth/sign-in/email').send({ email, password: PASSWORD }).expect(200);
  });

  it('sends mail to every mailbox, or those of some organizations', async () => {
    const mailer = app.get<MemorySystemMailer>(SYSTEM_MAILER);
    const all = await root.post('/api/system/broadcast').send({ subject: 'Maintenance', text: 'Tonight.', dryRun: true }).expect(202);
    expect(all.body.recipients).toBeGreaterThanOrEqual(2);

    mailer.sent.length = 0;
    const some = await root
      .post('/api/system/broadcast')
      .send({ subject: 'Maintenance', text: 'Tonight at 22:00.', organizationIds: [a.orgId, b.orgId], exclude: [b.address.toUpperCase()], from: 'ops@example.test' })
      .expect(202);
    expect(some.body.recipients).toBe(1);
    await app.get(BroadcastService).last;
    expect(mailer.sent).toEqual([{ to: a.address, from: 'ops@example.test', subject: 'Maintenance', text: 'Tonight at 22:00.' }]);
    await root.post('/api/system/broadcast').send({ subject: 'Two\nlines', text: 'x' }).expect(400);
  });

  it('shows every domain’s DKIM key and its DNS state, and copies a key to another domain', async () => {
    // Removing the rights ended a.owner's sessions (first test).
    const ownerA = await signIn(app, a.owner.email);
    const keyA = (await ownerA.get(`/api/orgs/${a.orgId}/domains/${a.domainId}/dkim`).expect(200)).body.key;
    published.set(keyA.record.name, [[keyA.record.value]]);

    const list = await root.get('/api/system/dkim').expect(200);
    const rowA = list.body.data.find((d: { domainId: string }) => d.domainId === a.domainId);
    const rowB = list.body.data.find((d: { domainId: string }) => d.domainId === b.domainId);
    expect(rowA).toMatchObject({ domain: a.domainName, selector: keyA.selector, bits: 2048, dns: 'ok', organizationId: a.orgId });
    expect(rowB).toMatchObject({ domain: b.domainName, dns: 'missing' });

    await root.post('/api/system/dkim/duplicate').send({ fromDomainId: a.domainId, toDomainId: a.domainId }).expect(422);
    await root.post('/api/system/dkim/duplicate').send({ fromDomainId: a.domainId, toDomainId: b.domainId }).expect(201);
    const keyB = (await b.owner.agent.get(`/api/orgs/${b.orgId}/domains/${b.domainId}/dkim`).expect(200)).body.key;
    expect(keyB.selector).toBe(keyA.selector);
    expect(keyB.record.value).toBe(keyA.record.value);
  });

  it('is for instance administrators only', async () => {
    await b.owner.agent.get('/api/system/admins').expect(404);
    await b.owner.agent.post('/api/system/admins').send({ email: b.owner.email }).expect(404);
    await b.owner.agent.post('/api/system/broadcast').send({ subject: 'x', text: 'x' }).expect(404);
    await b.owner.agent.get('/api/system/dkim').expect(404);
    await b.owner.agent.post('/api/system/dkim/duplicate').send({ fromDomainId: a.domainId, toDomainId: b.domainId }).expect(404);
  });
});
