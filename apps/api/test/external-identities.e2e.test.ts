import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { user } from '../src/db/schema/index.js';
import { resolveExternalIdentity } from '../src/identities/resolve-identity.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

const ISSUER = 'https://app.example.test';

describe('External identities', () => {
  let app: INestApplication;
  let db: Database;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let mailboxA: { id: string; userId: string };

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    a = await mailboxInNewOrg(app, 'xid-a');
    b = await mailboxInNewOrg(app, 'xid-b');
    mailboxA = (await a.owner.agent.get(`/api/orgs/${a.orgId}/mailboxes`).expect(200)).body.data[0];
  });

  afterAll(async () => {
    await app.close();
  });

  it('links a person of the organization by mailbox or by account, and finds them by the pair', async () => {
    const linked = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/identities`)
      .send({ mailboxId: mailboxA.id, issuer: ISSUER, subject: 'user-42', label: 'Shop account' })
      .expect(201);
    expect(linked.body).toMatchObject({ userId: mailboxA.userId, address: a.address, issuer: ISSUER, subject: 'user-42', label: 'Shop account' });
    await a.owner.agent.post(`/api/orgs/${a.orgId}/identities`).send({ userId: mailboxA.userId, issuer: 'https://idp.example.test', subject: 'abc' }).expect(201);

    const list = await a.owner.agent.get(`/api/orgs/${a.orgId}/identities`).query({ userId: mailboxA.userId }).expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(await resolveExternalIdentity(db, a.orgId, ISSUER, 'user-42')).toEqual({ userId: mailboxA.userId, address: a.address });
    // The same pair means nothing in another organization.
    expect(await resolveExternalIdentity(db, b.orgId, ISSUER, 'user-42')).toBeNull();

    // One person per pair in an organization.
    await a.owner.agent.post(`/api/orgs/${a.orgId}/identities`).send({ userId: mailboxA.userId, issuer: ISSUER, subject: 'user-42' }).expect(409);

    const audit = (await a.owner.agent.get(`/api/orgs/${a.orgId}/audit`).expect(200)).body.data as { action: string; details: unknown }[];
    expect(audit.find((e) => e.action === 'identity.linked')?.details).toMatchObject({ issuer: 'https://idp.example.test', subject: 'abc' });
  });

  it('stays inside its organization', async () => {
    const [identity] = (await a.owner.agent.get(`/api/orgs/${a.orgId}/identities`).expect(200)).body.data;
    // Another organization's admin: not their list, not their person, not their identity.
    await b.owner.agent.get(`/api/orgs/${a.orgId}/identities`).expect(404);
    expect((await b.owner.agent.get(`/api/orgs/${b.orgId}/identities`).expect(200)).body.data).toEqual([]);
    await b.owner.agent.post(`/api/orgs/${b.orgId}/identities`).send({ mailboxId: mailboxA.id, issuer: ISSUER, subject: 'steal' }).expect(404);
    await b.owner.agent.post(`/api/orgs/${b.orgId}/identities`).send({ userId: mailboxA.userId, issuer: ISSUER, subject: 'steal' }).expect(404);
    await b.owner.agent.delete(`/api/orgs/${b.orgId}/identities/${identity.id}`).expect(404);
    await b.owner.agent.delete(`/api/orgs/${a.orgId}/identities/${identity.id}`).expect(404);
    // Members are not administrators.
    await a.agent.get(`/api/orgs/${a.orgId}/identities`).expect(403);
    await a.agent.post(`/api/orgs/${a.orgId}/identities`).send({ mailboxId: mailboxA.id, issuer: ISSUER, subject: 'me' }).expect(403);
  });

  it('never links nor resolves an instance administrator, and stops resolving a mailbox that cannot sign in', async () => {
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, mailboxA.userId));
    try {
      expect(await resolveExternalIdentity(db, a.orgId, ISSUER, 'user-42')).toBeNull();
      await a.owner.agent.post(`/api/orgs/${a.orgId}/identities`).send({ mailboxId: mailboxA.id, issuer: ISSUER, subject: 'other' }).expect(422);
    } finally {
      await db.update(user).set({ role: 'user' }).where(eq(user.id, mailboxA.userId));
    }
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/mailboxes/${mailboxA.id}`).send({ status: 'no_login' }).expect(200);
    expect(await resolveExternalIdentity(db, a.orgId, ISSUER, 'user-42')).toBeNull();
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/mailboxes/${mailboxA.id}`).send({ status: 'active' }).expect(200);
    expect(await resolveExternalIdentity(db, a.orgId, ISSUER, 'user-42')).not.toBeNull();
  });

  it('can be linked by an instance administrator, and unlinked', async () => {
    const rootEmail = `xid-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email: rootEmail, password: PASSWORD, name: 'Root' });
    const root = await signIn(app, rootEmail);
    const viaRoot = await root.post(`/api/orgs/${a.orgId}/identities`).send({ mailboxId: mailboxA.id, issuer: ISSUER, subject: 'by-root' }).expect(201);
    await root.delete(`/api/orgs/${a.orgId}/identities/${viaRoot.body.id}`).expect(204);
    expect(await resolveExternalIdentity(db, a.orgId, ISSUER, 'by-root')).toBeNull();
    const audit = (await a.owner.agent.get(`/api/orgs/${a.orgId}/audit`).expect(200)).body.data as { action: string }[];
    expect(audit.some((e) => e.action === 'identity.unlinked')).toBe(true);
  });
});
