import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { member, user as userTable } from '../src/db/schema/index.js';
import {
  addMember,
  authOf,
  createOrg,
  PASSWORD,
  signIn,
  signUp,
  startApp,
  type TestUser,
} from './helpers.js';

describe('Domains API', () => {
  let app: INestApplication;
  let alice: TestUser; // owner of org A
  let bob: TestUser; // owner of org B
  let carol: TestUser; // plain member of org A
  let superAdmin: TestAgent;
  let superAdminId: string;
  let orgA: string;
  let orgB: string;

  const domainsOf = (orgId: string) => `/api/orgs/${orgId}/domains`;

  beforeAll(async () => {
    app = await startApp();
    alice = await signUp(app, 'alice');
    bob = await signUp(app, 'bob');
    carol = await signUp(app, 'carol');
    orgA = await createOrg(alice, 'Acme');
    orgB = await createOrg(bob, 'Bravo');
    await addMember(app, orgA, carol.id, 'member');

    const adminEmail = `root-${Date.now()}@example.test`;
    const root = await createSuperAdmin(authOf(app), { email: adminEmail, password: PASSWORD, name: 'Root' });
    superAdminId = root.id;
    superAdmin = await signIn(app, adminEmail);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('serves the health check without a session', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
    });

    it('rejects requests without a session', async () => {
      await request(app.getHttpServer()).get(domainsOf(orgA)).expect(401);
    });

    it('rejects state-changing requests from an untrusted origin, even with a valid session', async () => {
      await alice.agent
        .post(domainsOf(orgA))
        .set('Origin', 'https://evil.example')
        .send({ name: 'csrf.example' })
        .expect(403);
      const list = await alice.agent.get(domainsOf(orgA)).expect(200);
      expect(list.body.data.map((d: { name: string }) => d.name)).not.toContain('csrf.example');
    });
  });

  describe('creation and validation', () => {
    it('lets an owner create a domain, normalizing the name', async () => {
      const res = await alice.agent.post(domainsOf(orgA)).send({ name: '  Example.COM. ' }).expect(201);
      expect(res.body).toMatchObject({ name: 'example.com', status: 'pending' });
      expect(res.body.id).toEqual(expect.any(String));
    });

    it('stores internationalized names in punycode', async () => {
      const res = await alice.agent.post(domainsOf(orgA)).send({ name: 'café.example' }).expect(201);
      expect(res.body.name).toBe('xn--caf-dma.example');
    });

    it.each([
      ['a single label', 'localhost'],
      ['an IPv4 address', '127.0.0.1'],
      ['a label starting with a hyphen', '-bad.example'],
      ['an empty label', 'a..example'],
      ['whitespace inside', 'exa mple.com'],
      ['a numeric TLD', 'example.123'],
      ['an empty string', ''],
    ])('rejects %s', async (_label, name) => {
      await alice.agent.post(domainsOf(orgA)).send({ name }).expect(400);
    });

    it('rejects unknown fields', async () => {
      await alice.agent
        .post(domainsOf(orgA))
        .send({ name: 'extra.example', organizationId: orgB })
        .expect(400);
    });

    it('returns the DNS TXT record that proves ownership', async () => {
      const res = await alice.agent.post(domainsOf(orgA)).send({ name: 'verify.example' }).expect(201);
      expect(res.body.verificationRecord).toMatch(/^postarix-verification=[\w-]{32}$/);
      expect(res.body.verifiedAt).toBeNull();
    });

    it('rejects a duplicate inside the same organization', async () => {
      await alice.agent.post(domainsOf(orgA)).send({ name: 'EXAMPLE.com' }).expect(409);
    });

    it('does not reveal or block a pending domain held by another organization', async () => {
      // Ownership is decided by DNS verification, not by who claims the name first.
      const res = await bob.agent.post(domainsOf(orgB)).send({ name: 'example.com' }).expect(201);
      expect(res.body.status).toBe('pending');
    });
  });

  describe('isolation between organizations', () => {
    let aliceDomainId: string;

    beforeAll(async () => {
      const res = await alice.agent.post(domainsOf(orgA)).send({ name: 'private.example' }).expect(201);
      aliceDomainId = res.body.id;
    });

    it('hides another organization entirely (404, not 403)', async () => {
      await bob.agent.get(domainsOf(orgA)).expect(404);
      await bob.agent.get(`${domainsOf(orgA)}/${aliceDomainId}`).expect(404);
      await bob.agent.post(domainsOf(orgA)).send({ name: 'hijack.example' }).expect(404);
      await bob.agent.delete(`${domainsOf(orgA)}/${aliceDomainId}`).expect(404);
    });

    it('does not resolve a foreign domain ID through the caller’s own organization', async () => {
      await bob.agent.get(`${domainsOf(orgB)}/${aliceDomainId}`).expect(404);
      await bob.agent.delete(`${domainsOf(orgB)}/${aliceDomainId}`).expect(404);
      // Still intact for its real owner.
      await alice.agent.get(`${domainsOf(orgA)}/${aliceDomainId}`).expect(200);
    });

    it('never lists another organization’s domains', async () => {
      const res = await bob.agent.get(domainsOf(orgB)).expect(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      const names = res.body.data.map((d: { name: string }) => d.name);
      expect(ids).not.toContain(aliceDomainId);
      expect(names).not.toContain('private.example');
    });

    it('returns 404 for an organization that does not exist', async () => {
      await alice.agent.get(domainsOf('00000000-0000-0000-0000-000000000000')).expect(404);
    });
  });

  describe('roles', () => {
    it('lets a plain member read but not write', async () => {
      const list = await carol.agent.get(domainsOf(orgA)).expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      const someId = list.body.data[0].id as string;

      await carol.agent.post(domainsOf(orgA)).send({ name: 'member.example' }).expect(403);
      await carol.agent.delete(`${domainsOf(orgA)}/${someId}`).expect(403);
    });

    it('lets an organization admin write', async () => {
      const dave = await signUp(app, 'dave');
      await addMember(app, orgA, dave.id, 'admin');
      const res = await dave.agent.post(domainsOf(orgA)).send({ name: 'admin.example' }).expect(201);
      await dave.agent.delete(`${domainsOf(orgA)}/${res.body.id}`).expect(204);
    });

    it('honours the highest of several comma-separated member roles', async () => {
      const erin = await signUp(app, 'erin');
      await addMember(app, orgA, erin.id, 'member');
      await app
        .get<Database>(DATABASE)
        .update(member)
        .set({ role: 'member,admin' })
        .where(and(eq(member.organizationId, orgA), eq(member.userId, erin.id)));
      await erin.agent.post(domainsOf(orgA)).send({ name: 'multi-role.example' }).expect(201);
    });

    it('gives the instance super-admin owner-level access to any organization', async () => {
      const res = await superAdmin.get(domainsOf(orgA)).expect(200);
      expect(res.body.data.map((d: { name: string }) => d.name)).toContain('example.com');
      await superAdmin.post(domainsOf(orgA)).send({ name: 'root.example' }).expect(201);
    });

    it('does not downgrade a super-admin who is also a plain member', async () => {
      await addMember(app, orgB, superAdminId, 'member');
      await superAdmin.post(domainsOf(orgB)).send({ name: 'root-member.example' }).expect(201);
    });

    it('recognises the super-admin role among several comma-separated roles', async () => {
      const email = `multi-root-${Date.now()}@example.test`;
      const user = await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Multi' });
      await app
        .get<Database>(DATABASE)
        .update(userTable)
        .set({ role: 'user,admin' })
        .where(eq(userTable.id, user.id));
      const agent = await signIn(app, email);
      await agent.get(domainsOf(orgA)).expect(200);
    });
  });

  describe('reading and deleting', () => {
    it('rejects malformed IDs', async () => {
      await alice.agent.get(`${domainsOf(orgA)}/not-a-uuid`).expect(400);
    });

    it('deletes a domain', async () => {
      const created = await alice.agent.post(domainsOf(orgA)).send({ name: 'temp.example' }).expect(201);
      const url = `${domainsOf(orgA)}/${created.body.id}`;
      await alice.agent.delete(url).expect(204);
      await alice.agent.get(url).expect(404);
    });
  });
});
