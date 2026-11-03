import type { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { HASH_STORE } from '../src/core/tokens.js';
import type { MemoryHashStore } from '../src/spam/spam-store.js';
import { SPAM_LISTS_HASH, SPAM_SCORES_HASH } from '../src/spam/spam-store.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('Spam thresholds and allow/block lists', () => {
  let app: INestApplication;
  let store: MemoryHashStore;
  let root: TestAgent;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let mailboxA: string;
  let mailboxB: string;

  const scores = () => store.hashes.get(SPAM_SCORES_HASH) ?? new Map();
  const lists = () => store.hashes.get(SPAM_LISTS_HASH) ?? new Map();

  beforeAll(async () => {
    app = await startApp();
    store = app.get<MemoryHashStore>(HASH_STORE);
    const email = `spam-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    a = await mailboxInNewOrg(app, 'spam-a');
    b = await mailboxInNewOrg(app, 'spam-b');
    mailboxA = (await a.owner.agent.get(`/api/orgs/${a.orgId}/mailboxes`).expect(200)).body.data[0].id;
    mailboxB = (await b.owner.agent.get(`/api/orgs/${b.orgId}/mailboxes`).expect(200)).body.data[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets thresholds per domain and mailbox, and publishes them for Rspamd', async () => {
    const domain = await a.owner.agent
      .patch(`/api/orgs/${a.orgId}/domains/${a.domainId}`)
      .send({ spamScores: { junkScore: 4, rejectScore: 12 } })
      .expect(200);
    expect(domain.body.spamScores).toEqual({ junkScore: 4, rejectScore: 12 });
    expect(scores().get(`@${a.domainName}`)).toBe('4:12');
    await a.owner.agent
      .patch(`/api/orgs/${a.orgId}/mailboxes/${mailboxA}`)
      .send({ spamScores: { junkScore: null, rejectScore: 30 } })
      .expect(200);
    expect(scores().get(a.address)).toBe(':30');
    await a.owner.agent
      .patch(`/api/orgs/${a.orgId}/mailboxes/${mailboxA}`)
      .send({ spamScores: { junkScore: 10, rejectScore: 5 } })
      .expect(400);
    await a.owner.agent
      .patch(`/api/orgs/${a.orgId}/mailboxes/${mailboxA}`)
      .send({ spamScores: { junkScore: null, rejectScore: null } })
      .expect(200);
    expect(scores().has(a.address)).toBe(false);
  });

  it('keeps allow and block lists per domain and mailbox', async () => {
    const url = `/api/orgs/${a.orgId}/spam-lists`;
    const allowed = await a.owner.agent
      .post(url)
      .send({ mailboxId: mailboxA, kind: 'allow', pattern: 'Boss@Partner.Example' })
      .expect(201);
    expect(allowed.body).toMatchObject({ kind: 'allow', pattern: 'boss@partner.example' });
    await a.owner.agent.post(url).send({ domainId: a.domainId, kind: 'block', pattern: '*@spammy.example' }).expect(201);
    await a.owner.agent.post(url).send({ domainId: a.domainId, kind: 'block', pattern: '@.bad.example' }).expect(201);
    await a.owner.agent.post(url).send({ domainId: a.domainId, kind: 'allow', pattern: '@spammy.example' }).expect(409);
    await a.owner.agent.post(url).send({ domainId: a.domainId, kind: 'block', pattern: 'not valid' }).expect(400);
    await a.owner.agent.post(url).send({ kind: 'block', pattern: '@x.example' }).expect(400);

    expect(lists().get(a.address)).toBe('a:boss@partner.example');
    expect(lists().get(`@${a.domainName}`)).toBe('b:@spammy.example,b:@.bad.example');
    const list = await a.owner.agent.get(`${url}?domainId=${a.domainId}`).expect(200);
    expect(list.body.data.map((e: { pattern: string }) => e.pattern)).toEqual(['@.bad.example', '@spammy.example']);

    await a.owner.agent.delete(`${url}/${allowed.body.id}`).expect(204);
    expect(lists().has(a.address)).toBe(false);
  });

  it('lets people set their own thresholds and lists', async () => {
    const res = await a.agent.put('/api/me/spam/scores').send({ junkScore: 3, rejectScore: null }).expect(200);
    expect(res.body).toEqual({ junkScore: 3, rejectScore: null });
    expect(scores().get(a.address)).toBe('3:');
    const entry = await a.agent.post('/api/me/spam/entries').send({ kind: 'block', pattern: 'pest@nuisance.example' }).expect(201);
    const mine = await a.agent.get('/api/me/spam').expect(200);
    expect(mine.body).toMatchObject({ junkScore: 3, rejectScore: null, entries: [{ pattern: 'pest@nuisance.example' }] });
    // Someone else's mailbox is out of reach.
    await b.agent.delete(`/api/me/spam/entries/${entry.body.id}`).expect(404);
    await a.agent.delete(`/api/me/spam/entries/${entry.body.id}`).expect(204);
  });

  it('keeps server-wide lists for instance administrators', async () => {
    const entry = await root.post('/api/system/spam-lists').send({ kind: 'block', pattern: '@scam.example' }).expect(201);
    expect(lists().get('*')).toBe('b:@scam.example');
    await a.owner.agent.get('/api/system/spam-lists').expect(404);
    await root.delete(`/api/system/spam-lists/${entry.body.id}`).expect(204);
    expect(lists().has('*')).toBe(false);
  });

  describe('isolation between organizations', () => {
    it("cannot read or change another organization's lists", async () => {
      const entry = await b.owner.agent
        .post(`/api/orgs/${b.orgId}/spam-lists`)
        .send({ mailboxId: mailboxB, kind: 'allow', pattern: 'friend@b.example' })
        .expect(201);
      await a.owner.agent.get(`/api/orgs/${a.orgId}/spam-lists?mailboxId=${mailboxB}`).expect(404);
      await a.owner.agent.get(`/api/orgs/${a.orgId}/spam-lists?domainId=${b.domainId}`).expect(404);
      await a.owner.agent.post(`/api/orgs/${a.orgId}/spam-lists`).send({ mailboxId: mailboxB, kind: 'block', pattern: '@x.example' }).expect(404);
      await a.owner.agent.delete(`/api/orgs/${a.orgId}/spam-lists/${entry.body.id}`).expect(404);
      await a.owner.agent.get(`/api/orgs/${b.orgId}/spam-lists?mailboxId=${mailboxB}`).expect(404);
      await a.owner.agent.patch(`/api/orgs/${a.orgId}/mailboxes/${mailboxB}`).send({ spamScores: { junkScore: 1, rejectScore: 2 } }).expect(404);
      const still = await b.owner.agent.get(`/api/orgs/${b.orgId}/spam-lists?mailboxId=${mailboxB}`).expect(200);
      expect(still.body.data).toHaveLength(1);
    });
  });
});
