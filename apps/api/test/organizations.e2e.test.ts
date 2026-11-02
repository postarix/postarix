import type { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { addMember, authOf, createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

describe('Organizations, members and audit', () => {
  let app: INestApplication;
  let alice: TestUser; // owner of A
  let bob: TestUser; // owner of B
  let carol: TestUser; // admin of A
  let dave: TestUser; // member of A
  let orgA: string;
  let orgB: string;
  let root: TestAgent;

  beforeAll(async () => {
    app = await startApp();
    alice = await signUp(app, 'org-alice');
    bob = await signUp(app, 'org-bob');
    carol = await signUp(app, 'org-carol');
    dave = await signUp(app, 'org-dave');
    orgA = await createOrg(alice, 'Alpha');
    orgB = await createOrg(bob, 'Bravo');
    await addMember(app, orgA, carol.id, 'admin');
    await addMember(app, orgA, dave.id, 'member');
    const email = `org-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
  });

  afterAll(async () => {
    await app.close();
  });

  const memberIdOf = async (agent: TestAgent, orgId: string, email: string) => {
    const res = await agent.get(`/api/orgs/${orgId}/members`).expect(200);
    return (res.body.data as { id: string; email: string }[]).find((m) => m.email === email)!.id;
  };

  describe('organization lists', () => {
    it('lists the caller’s organizations with role and counts', async () => {
      const res = await carol.agent.get('/api/me/organizations').expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ id: orgA, role: 'admin', counts: { members: 3 } });

      const bobs = await bob.agent.get('/api/me/organizations').expect(200);
      expect(bobs.body.data.map((o: { id: string }) => o.id)).toEqual([orgB]);
    });

    it('lists every organization for super-admins only', async () => {
      const res = await root.get('/api/admin/organizations').expect(200);
      const ids = res.body.data.map((o: { id: string }) => o.id);
      expect(ids).toEqual(expect.arrayContaining([orgA, orgB]));
      await alice.agent.get('/api/admin/organizations').expect(404);
    });

    it('shows an overview to members and hides it from others', async () => {
      const res = await dave.agent.get(`/api/orgs/${orgA}/overview`).expect(200);
      expect(res.body).toMatchObject({ id: orgA, name: 'Alpha', role: 'member', viaSuperAdmin: false });
      await bob.agent.get(`/api/orgs/${orgA}/overview`).expect(404);
      const asRoot = await root.get(`/api/orgs/${orgA}/overview`).expect(200);
      expect(asRoot.body).toMatchObject({ role: 'owner', viaSuperAdmin: true });
    });
  });

  describe('members', () => {
    it('are listed for admins only', async () => {
      const res = await carol.agent.get(`/api/orgs/${orgA}/members`).expect(200);
      expect(res.body.data.map((m: { email: string }) => m.email).sort()).toEqual(
        [alice.email, carol.email, dave.email].sort(),
      );
      await dave.agent.get(`/api/orgs/${orgA}/members`).expect(403);
      await bob.agent.get(`/api/orgs/${orgA}/members`).expect(404);
    });

    it('can be added by email when the account exists', async () => {
      const erin = await signUp(app, 'org-erin');
      const res = await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: erin.email }).expect(201);
      expect(res.body).toMatchObject({ email: erin.email, role: 'member' });
      await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: erin.email }).expect(409);
      const unknown = await carol.agent
        .post(`/api/orgs/${orgA}/members`)
        .send({ email: 'nobody@example.test' })
        .expect(422);
      expect(unknown.body.code).toBe('UNKNOWN_ACCOUNT');
    });

    it('reserves the owner role to owners', async () => {
      const frank = await signUp(app, 'org-frank');
      await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: frank.email, role: 'owner' }).expect(403);
      const daveId = await memberIdOf(carol.agent, orgA, dave.email);
      await carol.agent.patch(`/api/orgs/${orgA}/members/${daveId}`).send({ role: 'owner' }).expect(403);
      const aliceId = await memberIdOf(carol.agent, orgA, alice.email);
      await carol.agent.delete(`/api/orgs/${orgA}/members/${aliceId}`).expect(403);
      await carol.agent.patch(`/api/orgs/${orgA}/members/${aliceId}`).send({ role: 'member' }).expect(403);
    });

    it('never leaves an organization without an owner', async () => {
      const aliceId = await memberIdOf(alice.agent, orgA, alice.email);
      await alice.agent.patch(`/api/orgs/${orgA}/members/${aliceId}`).send({ role: 'admin' }).expect(400);
      await alice.agent.delete(`/api/orgs/${orgA}/members/${aliceId}`).expect(400);

      const daveId = await memberIdOf(alice.agent, orgA, dave.email);
      await alice.agent.patch(`/api/orgs/${orgA}/members/${daveId}`).send({ role: 'owner' }).expect(200);
      await alice.agent.patch(`/api/orgs/${orgA}/members/${daveId}`).send({ role: 'member' }).expect(200);
    });

    it('cannot be changed through another organization', async () => {
      const daveId = await memberIdOf(alice.agent, orgA, dave.email);
      await bob.agent.patch(`/api/orgs/${orgB}/members/${daveId}`).send({ role: 'admin' }).expect(404);
      await bob.agent.delete(`/api/orgs/${orgB}/members/${daveId}`).expect(404);
      await bob.agent.patch(`/api/orgs/${orgA}/members/${daveId}`).send({ role: 'admin' }).expect(404);
      const res = await alice.agent.get(`/api/orgs/${orgA}/members`).expect(200);
      expect(res.body.data.find((m: { email: string }) => m.email === dave.email).role).toBe('member');
    });

    it('can be removed by admins', async () => {
      const gina = await signUp(app, 'org-gina');
      const added = await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: gina.email }).expect(201);
      await carol.agent.delete(`/api/orgs/${orgA}/members/${added.body.id}`).expect(204);
      await gina.agent.get(`/api/orgs/${orgA}/overview`).expect(404);
    });
  });

  describe('audit log', () => {
    it('records changes, newest first, with the actor', async () => {
      const domain = await alice.agent
        .post(`/api/orgs/${orgA}/domains`)
        .send({ name: `audit-${Date.now()}.example` })
        .expect(201);
      await alice.agent.post(`/api/orgs/${orgA}/domains/${domain.body.id}/verify`).expect(200);

      const res = await carol.agent.get(`/api/orgs/${orgA}/audit?limit=5`).expect(200);
      expect(res.body.data[0]).toMatchObject({
        action: 'domain.verified',
        targetLabel: domain.body.name,
        actorEmail: alice.email,
      });
      expect(res.body.data[1]).toMatchObject({ action: 'domain.created' });
      expect(res.body.data.some((e: { action: string }) => e.action === 'member.added')).toBe(true);
    });

    it('pages with "before" and stays inside the organization', async () => {
      const first = await alice.agent.get(`/api/orgs/${orgA}/audit?limit=1`).expect(200);
      const next = await alice.agent
        .get(`/api/orgs/${orgA}/audit?limit=1&before=${encodeURIComponent(first.body.data[0].createdAt)}`)
        .expect(200);
      expect(next.body.data[0].id).not.toBe(first.body.data[0].id);

      await dave.agent.get(`/api/orgs/${orgA}/audit`).expect(403);
      await bob.agent.get(`/api/orgs/${orgA}/audit`).expect(404);
      const own = await bob.agent.get(`/api/orgs/${orgB}/audit`).expect(200);
      expect(own.body.data.every((e: { actorEmail: string }) => e.actorEmail !== alice.email)).toBe(true);
    });
  });
});
