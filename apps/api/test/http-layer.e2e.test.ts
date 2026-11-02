import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, signUp, startApp, type TestUser } from './helpers.js';

describe('HTTP layer', () => {
  let app: INestApplication;
  let alice: TestUser;
  let bob: TestUser;
  let orgA: string;
  let orgA2: string;
  let orgB: string;

  beforeAll(async () => {
    app = await startApp();
    alice = await signUp(app, 'http-alice');
    bob = await signUp(app, 'http-bob');
    orgA = await createOrg(alice, 'Alpha');
    orgA2 = await createOrg(alice, 'AlphaTwo'); // becomes Alice's active organization
    orgB = await createOrg(bob, 'Beta');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Better Auth routes', () => {
    it('keep the query string intact', async () => {
      const res = await alice.agent
        .get('/api/auth/organization/get-full-organization')
        .query({ organizationId: orgA })
        .expect(200);
      // If the query were dropped, Better Auth would fall back to the active org (orgA2).
      expect(res.body.id).toBe(orgA);
      expect(res.body.id).not.toBe(orgA2);
    });

    it('do not serve an organization the caller does not belong to', async () => {
      const res = await alice.agent
        .get('/api/auth/organization/get-full-organization')
        .query({ organizationId: orgB });
      expect(res.status).toBe(403);
      expect(res.body?.id).toBeUndefined();
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
