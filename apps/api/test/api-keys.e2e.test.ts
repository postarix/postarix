import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('API keys', () => {
  let app: INestApplication;
  let root: TestAgent;
  let rootId: string;
  let org: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  const asKey = (key: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${key}`),
    post: (path: string) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${key}`),
  });

  beforeAll(async () => {
    app = await startApp();
    const email = `keys-root-${Date.now()}@example.test`;
    rootId = (await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' })).id;
    root = await signIn(app, email);
    org = await mailboxInNewOrg(app, 'keys');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a key shown once, and lists keys without it', async () => {
    const created = await root.post('/api/system/api-keys').send({ name: 'Provisioning', access: 'write' }).expect(201);
    expect(created.body.key).toMatch(/^px_[A-Za-z0-9_-]{40,}$/);
    const list = await root.get('/api/system/api-keys').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(created.body.key);
    expect(list.body.data[0]).toMatchObject({ name: 'Provisioning', access: 'write', allowedIps: [] });
    await org.owner.agent.get('/api/system/api-keys').expect(404);
    await org.owner.agent.post('/api/system/api-keys').send({ name: 'x', access: 'write' }).expect(404);
  });

  it('acts as an instance administrator on the same API', async () => {
    const { body } = await root.post('/api/system/api-keys').send({ name: 'Writer', access: 'write' }).expect(201);
    const key = asKey(body.key);
    const mailboxes = await key.get(`/api/orgs/${org.orgId}/mailboxes`).expect(200);
    expect(mailboxes.body.data).toHaveLength(1);
    await key
      .post(`/api/orgs/${org.orgId}/mailboxes`)
      .send({ domainId: org.domainId, localPart: 'byscript', password: PASSWORD })
      .expect(201);
  });

  it('only reads with a read-only key', async () => {
    const { body } = await root.post('/api/system/api-keys').send({ name: 'Monitoring', access: 'read' }).expect(201);
    const key = asKey(body.key);
    await key.get('/api/system/status').expect(200);
    await key.post(`/api/orgs/${org.orgId}/mailboxes`).send({ domainId: org.domainId, localPart: 'nope', password: PASSWORD }).expect(401);
  });

  it('works only from the allowed addresses', async () => {
    const { body } = await root
      .post('/api/system/api-keys')
      .send({ name: 'Office only', access: 'read', allowedIps: ['203.0.113.0/24'] })
      .expect(201);
    await asKey(body.key).get('/api/system/status').expect(401);
    const local = await root
      .post('/api/system/api-keys')
      .send({ name: 'Localhost', access: 'read', allowedIps: ['127.0.0.1', '::1'] })
      .expect(201);
    await asKey(local.body.key).get('/api/system/status').expect(200);
    await root.post('/api/system/api-keys').send({ name: 'Bad', access: 'read', allowedIps: ['999.1.1.1'] }).expect(400);
  });

  it('refuses unknown, expired and revoked keys, and keys of former administrators', async () => {
    await asKey('px_' + 'x'.repeat(43)).get('/api/system/status').expect(401);
    const { body } = await root.post('/api/system/api-keys').send({ name: 'Temporary', access: 'read' }).expect(201);
    const db = app.get<Database>(DATABASE);
    await db.execute(sql`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = ${body.id}`);
    await asKey(body.key).get('/api/system/status').expect(401);

    const kept = await root.post('/api/system/api-keys').send({ name: 'Revoked', access: 'read' }).expect(201);
    await asKey(kept.body.key).get('/api/system/status').expect(200);
    await root.delete(`/api/system/api-keys/${kept.body.id}`).expect(204);
    await asKey(kept.body.key).get('/api/system/status').expect(401);

    const demoted = await root.post('/api/system/api-keys').send({ name: 'Demoted', access: 'read' }).expect(201);
    await db.execute(sql`UPDATE "user" SET role = 'user' WHERE id = ${rootId}`);
    await asKey(demoted.body.key).get('/api/system/status').expect(401);
    await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE id = ${rootId}`);
  });
});
