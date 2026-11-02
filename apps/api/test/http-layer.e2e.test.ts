import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { authOf, createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

describe('HTTP layer', () => {
  let app: INestApplication;
  let alice: TestUser;
  let bob: TestUser;
  let orgA: string;

  beforeAll(async () => {
    app = await startApp();
    alice = await signUp(app, 'http-alice');
    bob = await signUp(app, 'http-bob');
    orgA = await createOrg(alice, 'Alpha');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Better Auth routes', () => {
    it('keep the query string intact', async () => {
      const email = `http-root-${Date.now()}@example.test`;
      await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
      const root = await signIn(app, email);
      const all = await root.get('/api/auth/admin/list-users').expect(200);
      expect(all.body.users.length).toBeGreaterThan(1);
      // If the query were dropped, the limit would be ignored.
      const one = await root.get('/api/auth/admin/list-users').query({ limit: 1 }).expect(200);
      expect(one.body.users).toHaveLength(1);
    });

    it('close the organization endpoints our own API replaces', async () => {
      const paths: [string, string, object?][] = [
        ['get', '/api/auth/organization/get-full-organization'],
        ['get', '/api/auth/organization/list-members'],
        ['get', '/api/auth/organization/list-invitations'],
        ['post', '/api/auth/organization/update-member-role', { organizationId: orgA, memberId: 'x', role: 'owner' }],
        ['post', '/api/auth/organization/remove-member', { organizationId: orgA, memberIdOrEmail: bob.email }],
        ['post', '/api/auth/organization/invite-member', { organizationId: orgA, email: bob.email, role: 'admin' }],
        ['post', '/api/auth/organization/add-member', { organizationId: orgA, userId: 'x', role: 'owner' }],
        ['post', '/api/auth/organization/update', { organizationId: orgA, data: { name: 'Renamed' } }],
        ['post', '/api/auth/organization/leave', { organizationId: orgA }],
        ['post', '/api/auth/organization/delete', { organizationId: orgA }],
      ];
      for (const [method, path, body] of paths) {
        const res = method === 'get' ? await alice.agent.get(path).query({ organizationId: orgA }) : await alice.agent.post(path).send(body);
        expect(res.status, path).toBe(404);
      }
      // Creating an organization stays available (to whoever may create one).
      await alice.agent.post('/api/auth/organization/create').send({ name: 'Still', slug: `still-${Date.now()}` }).expect(200);
    });

    it('reject cross-site state-changing requests carrying a session cookie', async () => {
      await alice.agent
        .post('/api/auth/organization/create')
        .set('Origin', 'https://evil.example')
        .send({ name: 'Evil', slug: `evil-${Date.now()}` })
        .expect(403);
    });
  });

  describe('request bodies', () => {
    const big = { name: 'x', padding: 'a'.repeat(2 * 1024 * 1024) };

    it('cap JSON bodies on Better Auth routes', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .send(big)
        .expect(413);
      expect(res.body.message).toBe('Payload too large');
    });

    it('cap JSON bodies on API routes', async () => {
      await alice.agent.post(`/api/orgs/${orgA}/domains`).send(big).expect(413);
    });

    it('reject body types other than JSON and forms', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('Content-Type', 'text/plain')
        .send('a'.repeat(1024))
        .expect(415);
    });

    it('answer malformed JSON with a JSON 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect(res.body.message).toBe('Malformed request body');
    });
  });
});
