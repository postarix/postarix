import type { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { SYSTEM_MAILER } from '../src/core/tokens.js';
import type { MemorySystemMailer } from '../src/mail/system-mailer.js';
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

    it('can be added back by email only if they own a mailbox here', async () => {
      // A mailbox owner who was removed from the organization can be added back.
      const domain = await alice.agent.post(`/api/orgs/${orgA}/domains`).send({ name: `members-${Date.now()}.example` });
      await alice.agent.post(`/api/orgs/${orgA}/domains/${domain.body.id}/verify`).expect(200);
      const mailbox = await alice.agent
        .post(`/api/orgs/${orgA}/mailboxes`)
        .send({ domainId: domain.body.id, localPart: 'erin', password: PASSWORD })
        .expect(201);
      const erinId = await memberIdOf(carol.agent, orgA, mailbox.body.address);
      await carol.agent.delete(`/api/orgs/${orgA}/members/${erinId}`).expect(204);
      const res = await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: mailbox.body.address }).expect(201);
      expect(res.body).toMatchObject({ email: mailbox.body.address, role: 'member' });
      await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: mailbox.body.address }).expect(409);

      // Accounts of other organizations look exactly like unknown addresses.
      const foreign = await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: bob.email }).expect(422);
      const unknown = await carol.agent.post(`/api/orgs/${orgA}/members`).send({ email: 'nobody@example.test' }).expect(422);
      expect(foreign.body).toEqual(unknown.body);
      expect(unknown.body.code).toBe('NOT_ELIGIBLE');
      const orgsOfBob = await bob.agent.get('/api/me/organizations').expect(200);
      expect(orgsOfBob.body.data.map((o: { id: string }) => o.id)).toEqual([orgB]);
    });

    it('can be added from any account by instance administrators, and that is marked in the log', async () => {
      const frida = await signUp(app, 'org-frida');
      await root.post(`/api/orgs/${orgA}/members`).send({ email: frida.email }).expect(201);
      const log = await alice.agent.get(`/api/orgs/${orgA}/audit?limit=1`).expect(200);
      expect(log.body.data[0]).toMatchObject({ action: 'member.added', targetLabel: frida.email, details: { viaSuperAdmin: true } });
      // The new member is told, by mail.
      const notice = app.get<MemorySystemMailer>(SYSTEM_MAILER).sent.find((m) => m.to === frida.email);
      expect(notice?.subject).toMatch(/^You are now a member of /);
      expect(notice?.text).toContain('Nothing changes for your mailbox');
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
      const added = await root.post(`/api/orgs/${orgA}/members`).send({ email: gina.email }).expect(201);
      await carol.agent.delete(`/api/orgs/${orgA}/members/${added.body.id}`).expect(204);
      await gina.agent.get(`/api/orgs/${orgA}/overview`).expect(404);
    });

    it('never ends up without an owner, even under concurrent changes', async () => {
      const harry = await signUp(app, 'org-harry');
      const iris = await signUp(app, 'org-iris');
      const orgC = await createOrg(harry, 'Charlie');
      await addMember(app, orgC, iris.id, 'owner');
      const harryId = await memberIdOf(harry.agent, orgC, harry.email);
      const irisId = await memberIdOf(harry.agent, orgC, iris.email);
      // Each owner demotes the other at the same time: at most one may succeed.
      const results = await Promise.all([
        harry.agent.patch(`/api/orgs/${orgC}/members/${irisId}`).send({ role: 'member' }),
        iris.agent.patch(`/api/orgs/${orgC}/members/${harryId}`).send({ role: 'member' }),
      ]);
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      const members = await root.get(`/api/orgs/${orgC}/members`).expect(200);
      expect(members.body.data.filter((m: { role: string }) => m.role === 'owner')).toHaveLength(1);
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
    });

    it('pages through events created in the same instant without losing any', async () => {
      const orgD = await createOrg(alice, 'Delta');
      const names = Array.from({ length: 24 }, (_, i) => `burst-${Date.now()}-${i}.example`);
      await Promise.all(names.map((name) => alice.agent.post(`/api/orgs/${orgD}/domains`).send({ name }).expect(201)));

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { data: { id: string }[]; nextCursor: string | null } } = await alice.agent
          .get(`/api/orgs/${orgD}/audit`)
          .query({ limit: 5, ...(cursor ? { cursor } : {}) })
          .expect(200);
        seen.push(...res.body.data.map((e) => e.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(24);

      await alice.agent.get(`/api/orgs/${orgD}/audit?cursor=not-a-cursor`).expect(400);
    });

    it('stays inside the organization', async () => {
      await dave.agent.get(`/api/orgs/${orgA}/audit`).expect(403);
      await bob.agent.get(`/api/orgs/${orgA}/audit`).expect(404);
      const own = await bob.agent.get(`/api/orgs/${orgB}/audit`).expect(200);
      expect(own.body.data.every((e: { actorEmail: string }) => e.actorEmail !== alice.email)).toBe(true);
    });
  });
});
