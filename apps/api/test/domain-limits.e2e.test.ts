import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { addMember, authOf, createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

const MiB = 1024 * 1024;

describe('Domain settings and limits', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let alice: TestUser; // owner of org A
  let bob: TestUser; // owner of org B
  let carol: TestUser; // admin of org A
  let dave: TestUser; // plain member of org A
  let root: TestAgent; // instance administrator, not a member
  let orgA: string;
  let orgB: string;
  let domainA: { id: string; name: string };
  let domainB: string;

  const domains = (orgId: string) => `/api/orgs/${orgId}/domains`;
  const mailboxes = (orgId: string) => `/api/orgs/${orgId}/mailboxes`;
  const aliases = (orgId: string) => `/api/orgs/${orgId}/aliases`;

  async function activeDomain(owner: TestUser, orgId: string, prefix: string) {
    const name = `${prefix}-${Date.now()}.example`;
    const created = await owner.agent.post(domains(orgId)).send({ name }).expect(201);
    await owner.agent.post(`${domains(orgId)}/${created.body.id}/verify`).expect(200);
    return { id: created.body.id as string, name };
  }

  const mailbox = (localPart: string, extra: Record<string, unknown> = {}) => ({
    domainId: domainA.id,
    localPart,
    password: 'a long mailbox password',
    ...extra,
  });

  beforeAll(async () => {
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    alice = await signUp(app, 'lim-alice');
    bob = await signUp(app, 'lim-bob');
    carol = await signUp(app, 'lim-carol');
    dave = await signUp(app, 'lim-dave');
    orgA = await createOrg(alice, 'LimitsA');
    orgB = await createOrg(bob, 'LimitsB');
    await addMember(app, orgA, carol.id, 'admin');
    await addMember(app, orgA, dave.id, 'member');
    domainA = await activeDomain(alice, orgA, 'lim-a');
    domainB = (await activeDomain(bob, orgB, 'lim-b')).id;
    const email = `lim-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows settings, limits and usage', async () => {
    const res = await alice.agent.get(`${domains(orgA)}/${domainA.id}`).expect(200);
    expect(res.body).toMatchObject({
      description: '',
      defaultMailboxQuotaBytes: null,
      limits: { maxMailboxes: null, maxAliases: null, maxMailboxQuotaBytes: null, totalQuotaBytes: null },
      usage: { mailboxes: 0, aliases: 0, quotaBytes: 0, unlimitedMailboxes: 0 },
    });
  });

  it('lets organization administrators set the description and default quota, not the limits', async () => {
    const res = await carol.agent
      .patch(`${domains(orgA)}/${domainA.id}`)
      .send({ description: 'Main domain', defaultMailboxQuotaBytes: 100 * MiB })
      .expect(200);
    expect(res.body).toMatchObject({ description: 'Main domain', defaultMailboxQuotaBytes: 100 * MiB });

    await alice.agent.patch(`${domains(orgA)}/${domainA.id}`).send({ maxMailboxes: 100 }).expect(403);
    await dave.agent.patch(`${domains(orgA)}/${domainA.id}`).send({ description: 'x' }).expect(403);
  });

  it('gives new mailboxes the default quota, unless they choose one', async () => {
    const fallback = await alice.agent.post(mailboxes(orgA)).send(mailbox('first')).expect(201);
    expect(fallback.body.quotaBytes).toBe(100 * MiB);
    expect(engine.mailboxes.get(`first@${domainA.name}`)?.quotaBytes).toBe(100 * MiB);
    const unlimited = await alice.agent.post(mailboxes(orgA)).send(mailbox('second', { quotaBytes: null })).expect(201);
    expect(unlimited.body.quotaBytes).toBeNull();
  });

  it('refuses limits below what the domain already has', async () => {
    const res = await root.patch(`${domains(orgA)}/${domainA.id}`).send({ maxMailboxes: 1 }).expect(409);
    expect(res.body.code).toBe('DOMAIN_LIMIT_BELOW_USAGE');
    // An unlimited mailbox exists, so no quota limit can be set yet.
    await root.patch(`${domains(orgA)}/${domainA.id}`).send({ totalQuotaBytes: 1000 * MiB }).expect(409);
  });

  it('enforces the mailbox, alias and quota limits an instance administrator sets', async () => {
    const second = (await alice.agent.get(mailboxes(orgA)).expect(200)).body.data.find(
      (m: { localPart: string }) => m.localPart === 'second',
    );
    await alice.agent.patch(`${mailboxes(orgA)}/${second.id}`).send({ quotaBytes: 100 * MiB }).expect(200);

    const limits = await root
      .patch(`${domains(orgA)}/${domainA.id}`)
      .send({ maxMailboxes: 3, maxAliases: 1, maxMailboxQuotaBytes: 200 * MiB, totalQuotaBytes: 400 * MiB })
      .expect(200);
    expect(limits.body).toMatchObject({
      limits: { maxMailboxes: 3, maxAliases: 1, maxMailboxQuotaBytes: 200 * MiB, totalQuotaBytes: 400 * MiB },
      usage: { mailboxes: 2, quotaBytes: 200 * MiB },
    });

    // Per mailbox: at most 200 MiB, never unlimited.
    expect((await alice.agent.post(mailboxes(orgA)).send(mailbox('big', { quotaBytes: 300 * MiB })).expect(422)).body.code).toBe(
      'MAILBOX_QUOTA_TOO_LARGE',
    );
    await alice.agent.post(mailboxes(orgA)).send(mailbox('nolimit', { quotaBytes: null })).expect(422);
    // In total: 200 MiB used of 400.
    await alice.agent.patch(`${mailboxes(orgA)}/${second.id}`).send({ quotaBytes: 200 * MiB }).expect(200);
    expect((await alice.agent.post(mailboxes(orgA)).send(mailbox('third', { quotaBytes: 150 * MiB })).expect(409)).body.code).toBe(
      'DOMAIN_QUOTA_EXCEEDED',
    );
    await alice.agent.post(mailboxes(orgA)).send(mailbox('third', { quotaBytes: 100 * MiB })).expect(201);
    // Three mailboxes: the limit.
    expect((await alice.agent.post(mailboxes(orgA)).send(mailbox('fourth', { quotaBytes: MiB })).expect(409)).body.code).toBe(
      'DOMAIN_MAILBOX_LIMIT',
    );

    await alice.agent.post(aliases(orgA)).send({ domainId: domainA.id, localPart: 'one', destinations: [`first@${domainA.name}`] }).expect(201);
    expect(
      (await alice.agent.post(aliases(orgA)).send({ domainId: domainA.id, localPart: 'two', destinations: [`first@${domainA.name}`] }).expect(409))
        .body.code,
    ).toBe('DOMAIN_ALIAS_LIMIT');
  });

  it('refuses a default quota that does not fit the limits', async () => {
    await carol.agent
      .patch(`${domains(orgA)}/${domainA.id}`)
      .send({ defaultMailboxQuotaBytes: 300 * MiB })
      .expect(422);
  });

  it('lets an instance administrator lift the limits again', async () => {
    const res = await root
      .patch(`${domains(orgA)}/${domainA.id}`)
      .send({ maxMailboxes: null, maxAliases: null, maxMailboxQuotaBytes: null, totalQuotaBytes: null })
      .expect(200);
    expect(res.body.limits).toEqual({ maxMailboxes: null, maxAliases: null, maxMailboxQuotaBytes: null, totalQuotaBytes: null });
    // The refused creations left no account behind.
    await alice.agent.post(mailboxes(orgA)).send(mailbox('fourth', { quotaBytes: null })).expect(201);
  });

  it('disables and enables a verified domain', async () => {
    const person = await signIn(app, `first@${domainA.name}`, 'a long mailbox password');
    await person.get('/api/me/app-passwords').expect(200);
    const off = await carol.agent.patch(`${domains(orgA)}/${domainA.id}`).send({ enabled: false }).expect(200);
    expect(off.body.status).toBe('disabled');
    await alice.agent.post(mailboxes(orgA)).send(mailbox('fifth')).expect(422);
    // Its mailboxes are signed out, and cannot sign in again meanwhile.
    await person.get('/api/me/app-passwords').expect(401);
    await expect(signIn(app, `first@${domainA.name}`, 'a long mailbox password')).rejects.toThrow();
    const on = await carol.agent.patch(`${domains(orgA)}/${domainA.id}`).send({ enabled: true }).expect(200);
    expect(on.body.status).toBe('active');

    const pending = await alice.agent.post(domains(orgA)).send({ name: `lim-pending-${Date.now()}.example` }).expect(201);
    await alice.agent.patch(`${domains(orgA)}/${pending.body.id}`).send({ enabled: true }).expect(422);
  });

  it('validates input', async () => {
    await alice.agent.patch(`${domains(orgA)}/${domainA.id}`).send({}).expect(400);
    await alice.agent.patch(`${domains(orgA)}/${domainA.id}`).send({ defaultMailboxQuotaBytes: 5 }).expect(400);
    await alice.agent.patch(`${domains(orgA)}/${domainA.id}`).send({ unknown: true }).expect(400);
    await alice.agent.patch(`${domains(orgA)}/not-a-uuid`).send({ description: 'x' }).expect(400);
  });

  describe('isolation between organizations', () => {
    it("cannot read or change another organization's domain", async () => {
      await alice.agent.get(`${domains(orgA)}/${domainB}`).expect(404);
      await alice.agent.patch(`${domains(orgA)}/${domainB}`).send({ description: 'mine' }).expect(404);
      await alice.agent.patch(`${domains(orgB)}/${domainB}`).send({ description: 'mine' }).expect(404);
      await alice.agent.patch(`${domains(orgA)}/${domainB}`).send({ enabled: false }).expect(404);
      const b = await bob.agent.get(`${domains(orgB)}/${domainB}`).expect(200);
      expect(b.body).toMatchObject({ description: '', status: 'active' });
    });

    it("cannot create mailboxes or aliases in another organization's domain", async () => {
      await alice.agent.post(mailboxes(orgA)).send({ ...mailbox('intruder'), domainId: domainB }).expect(422);
      await alice.agent
        .post(aliases(orgA))
        .send({ domainId: domainB, localPart: 'intruder', destinations: [`first@${domainA.name}`] })
        .expect(422);
    });
  });
});
