import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { internalSecret } from '../src/config/internal-secrets.js';
import { authOf, createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

const MASTER = 'internal-test-token-that-is-long-enough';
const TOKEN = internalSecret(MASTER, 'reports');

describe('System status, logs and mail queue', () => {
  let app: INestApplication;
  let root: TestAgent;
  let owner: TestUser;

  const report = (path: string, body: string, token: string | null = TOKEN, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer()).post(`/api/internal/reports/${path}`).set('Content-Type', 'text/plain');
    if (token !== null) req.set('x-postarix-internal-token', token);
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req.send(body);
  };

  beforeAll(async () => {
    app = await startApp();
    const email = `sys-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    owner = await signUp(app, 'sys-owner');
    await createOrg(owner, 'System');
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts reports only with the reports secret, and never through a proxy', async () => {
    await report('postfix', 'line').expect(204);
    await report('postfix', 'line', null).expect(401);
    await report('postfix', 'line', internalSecret(MASTER, 'mail-auth')).expect(401);
    await report('postfix', 'line', TOKEN, { 'X-Forwarded-For': '203.0.113.9' }).expect(404);
    await report('unknown', 'line').expect(400);
  });

  it('keeps the reported log lines, cleaned, for instance administrators', async () => {
    await report('cyrus', 'first line\r\nsecond \u001b[31mred\u001b[0m line\n\nthird line with ann@example.test\n', TOKEN, {
      'x-postarix-version': 'Cyrus 3.12',
      'x-postarix-host': 'mail-1',
      'x-postarix-disk': '/var/spool/cyrus 1000 4000',
    }).expect(204);
    const res = await root.get('/api/system/logs/cyrus').expect(200);
    expect(res.body.data.slice(-3)).toEqual(['first line', 'second [31mred[0m line', 'third line with ann@example.test']);
    const filtered = await root.get('/api/system/logs/cyrus?filter=ANN@').expect(200);
    expect(filtered.body.data).toEqual(['third line with ann@example.test']);

    const status = await root.get('/api/system/status').expect(200);
    const cyrus = status.body.data.find((s: { name: string }) => s.name === 'cyrus');
    expect(cyrus).toMatchObject({ state: 'ok', version: 'Cyrus 3.12', disk: { path: '/var/spool/cyrus', usedBytes: 1000, totalBytes: 4000 } });
    expect(status.body.data.find((s: { name: string }) => s.name === 'postgres')).toMatchObject({ state: 'ok' });
  });

  it('shows the mail queue and hands queue actions to Postfix once', async () => {
    const queued = JSON.stringify({
      queue_name: 'deferred',
      queue_id: 'ABC123DEF',
      arrival_time: 1793700000,
      message_size: 2048,
      sender: 'ann@example.test',
      recipients: [{ address: 'bob@outside.example', delay_reason: 'connect to mx.outside.example: Connection timed out' }],
    });
    const empty = await report('postfix/queue', `${queued}\n{"truncated`).expect(200);
    expect(empty.text).toBe('');
    const queue = await root.get('/api/system/queue').expect(200);
    expect(queue.body.items).toEqual([
      {
        id: 'ABC123DEF',
        queue: 'deferred',
        arrivedAt: new Date(1793700000 * 1000).toISOString(),
        sizeBytes: 2048,
        sender: 'ann@example.test',
        recipients: [{ address: 'bob@outside.example', reason: 'connect to mx.outside.example: Connection timed out' }],
      },
    ]);

    await root.post('/api/system/queue').send({ action: 'deliver', ids: ['ABC123DEF'] }).expect(202);
    await root.post('/api/system/queue').send({ action: 'flush' }).expect(202);
    await root.post('/api/system/queue').send({ action: 'delete', ids: ['bad id; rm -rf /'] }).expect(400);
    await root.post('/api/system/queue').send({ action: 'shutdown' }).expect(400);
    const actions = await report('postfix/queue', queued).expect(200);
    expect(actions.text).toBe('deliver ABC123DEF\nflush\n');
    expect((await report('postfix/queue', queued).expect(200)).text).toBe('');
  });

  it('is for instance administrators only', async () => {
    await owner.agent.get('/api/system/status').expect(404);
    await owner.agent.get('/api/system/logs/postfix').expect(404);
    await owner.agent.get('/api/system/queue').expect(404);
    await owner.agent.post('/api/system/queue').send({ action: 'flush' }).expect(404);
    await request(app.getHttpServer()).get('/api/system/status').expect(401);
  });
});
