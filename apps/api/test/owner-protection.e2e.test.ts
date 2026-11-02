import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

// Admins manage the organization's mailboxes, but not the accounts of the
// people above or beside them: otherwise an admin could reset an owner's
// password, sign in as them and make themselves owner.
describe('Owners and admins are out of other admins’ reach', () => {
  let app: INestApplication;
  let owner: TestUser;
  let orgId: string;
  let domainId: string;
  const ids: Record<string, string> = {};
  let adminAgent: Awaited<ReturnType<typeof signIn>>;

  const mailbox = async (localPart: string) =>
    (await owner.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId, localPart, password: PASSWORD }).expect(201)).body as { id: string; address: string };
  const memberIdOf = async (email: string) =>
    ((await owner.agent.get(`/api/orgs/${orgId}/members`).expect(200)).body.data as { id: string; email: string }[]).find((m) => m.email === email)!.id;

  beforeAll(async () => {
    app = await startApp();
    owner = await signUp(app, 'op-owner');
    orgId = await createOrg(owner, 'OwnerProtection');
    const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `op-${Date.now()}.example` });
    domainId = domain.body.id;
    await owner.agent.post(`/api/orgs/${orgId}/domains/${domainId}/verify`).expect(200);

    const boss = await mailbox('boss');
    const admin = await mailbox('admin');
    const peer = await mailbox('peer');
    const worker = await mailbox('worker');
    Object.assign(ids, { boss: boss.id, admin: admin.id, peer: peer.id, worker: worker.id });
    await owner.agent.patch(`/api/orgs/${orgId}/members/${await memberIdOf(boss.address)}`).send({ role: 'owner' }).expect(200);
    await owner.agent.patch(`/api/orgs/${orgId}/members/${await memberIdOf(admin.address)}`).send({ role: 'admin' }).expect(200);
    await owner.agent.patch(`/api/orgs/${orgId}/members/${await memberIdOf(peer.address)}`).send({ role: 'admin' }).expect(200);
    adminAgent = await signIn(app, admin.address);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets admins manage members’ mailboxes', async () => {
    await adminAgent.post(`/api/orgs/${orgId}/mailboxes/${ids.worker}/password`).send({ password: 'a new long password' }).expect(204);
  });

  it('keeps owners’ and other admins’ accounts for owners', async () => {
    for (const target of [ids.boss, ids.peer]) {
      await adminAgent.post(`/api/orgs/${orgId}/mailboxes/${target}/password`).send({ password: 'a new long password' }).expect(403);
      await adminAgent.patch(`/api/orgs/${orgId}/mailboxes/${target}`).send({ status: 'disabled' }).expect(403);
      await adminAgent.delete(`/api/orgs/${orgId}/mailboxes/${target}`).expect(403);
    }
    await owner.agent.post(`/api/orgs/${orgId}/mailboxes/${ids.peer}/password`).send({ password: 'a new long password' }).expect(204);
  });

  it('keeps single sign-on for owners', async () => {
    const res = await adminAgent.post(`/api/orgs/${orgId}/sso`).send({ domainId, issuer: 'https://idp.example', clientId: 'x', clientSecret: 'y' });
    expect(res.status).toBe(403);
    await adminAgent.get(`/api/orgs/${orgId}/sso`).expect(200);
  });
});
