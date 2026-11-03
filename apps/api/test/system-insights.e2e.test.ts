import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { SYSTEM_STORE } from '../src/core/tokens.js';
import type { SystemStore } from '../src/system/system-store.js';
import { SystemService } from '../src/system/system.service.js';
import { authOf, mailboxInNewOrg, newAgent, PASSWORD, signIn, startApp } from './helpers.js';

describe('System insights: logs of every service, the dashboard, Rspamd', () => {
  let app: INestApplication;
  let rspamd: Server;
  let root: TestAgent;
  let org: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  const seen: { method: string; url: string; password: string | undefined; body: string }[] = [];
  const saved = {
    url: process.env.RSPAMD_CONTROLLER_URL,
    password: process.env.RSPAMD_CONTROLLER_PASSWORD,
    enable: process.env.RSPAMD_CONTROLLER_ENABLE_PASSWORD,
  };
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    rspamd = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', password: req.headers.password as string | undefined, body });
        if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Rspamd</html>');
        if (req.url === '/stat') {
          return res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ version: '3.12.1', uptime: 3600, scanned: 42, learned: 3, actions: { reject: 2, 'no action': 40 } }));
        }
        if (req.url?.startsWith('/history')) {
          const rows = [
            { unix_time: now - 60, 'message-id': 'h1', sender_smtp: 'x@outside.example', rcpt_smtp: ['ann@a.example'], subject: 'Hi', action: 'no action', score: 1 },
            { unix_time: now - 120, 'message-id': 'h2', sender_smtp: 'spam@bad.example', rcpt_smtp: ['ann@a.example'], subject: 'Win', action: 'reject', score: 20, symbols: { BAYES_SPAM: { score: 5 } } },
            { unix_time: now - 180, 'message-id': 'h3', sender_smtp: 'ann@a.example', rcpt_smtp: ['bob@outside.example'], subject: 'Out', action: 'no action', score: 0, user: 'ann@a.example' },
            { unix_time: now - 3 * 86400, 'message-id': 'old', sender_smtp: 'x@y.example', rcpt_smtp: ['z@a.example'], subject: 'Old', action: 'add header', score: 9 },
          ];
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rows }));
        }
        if (req.url === '/learnspam' && req.method === 'POST') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => rspamd.listen(0, '127.0.0.1', resolve));
    process.env.RSPAMD_CONTROLLER_URL = `http://127.0.0.1:${(rspamd.address() as AddressInfo).port}`;
    process.env.RSPAMD_CONTROLLER_PASSWORD = 'read-only-secret';
    process.env.RSPAMD_CONTROLLER_ENABLE_PASSWORD = 'enable-secret';
    app = await startApp();
    const email = `insights-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    org = await mailboxInNewOrg(app, 'insights');
  });

  afterAll(async () => {
    await app.close();
    rspamd.close();
    Object.assign(process.env, {
      RSPAMD_CONTROLLER_URL: saved.url,
      RSPAMD_CONTROLLER_PASSWORD: saved.password,
      RSPAMD_CONTROLLER_ENABLE_PASSWORD: saved.enable ?? '',
    });
  });

  it('parses the logs of every service, filtered by level and text, the API’s own included', async () => {
    const store = app.get<SystemStore>(SYSTEM_STORE);
    await store.appendLog('rspamd', [
      '2026-11-03 12:25:03 #41(rspamd_proxy) <33c412>; proxy; scanned message',
      '2026-11-03 12:25:04 #41(rspamd_proxy) <33c413>; lua; cannot connect to redis',
    ]);
    const all = await root.get('/api/system/log-entries/rspamd').expect(200);
    expect(all.body.data).toEqual([
      { time: '2026-11-03T12:25:03.000Z', level: 'info', source: 'rspamd_proxy/proxy', message: 'scanned message' },
      { time: '2026-11-03T12:25:04.000Z', level: 'error', source: 'rspamd_proxy/lua', message: 'cannot connect to redis' },
    ]);
    const errors = await root.get('/api/system/log-entries/rspamd?level=warning').expect(200);
    expect(errors.body.data.map((e: { message: string }) => e.message)).toEqual(['cannot connect to redis']);
    const filtered = await root.get('/api/system/log-entries/rspamd?filter=SCANNED').expect(200);
    expect(filtered.body.data).toHaveLength(1);

    // What the API prints is kept as its log.
    const system = app.get(SystemService);
    system.captureApiOutput('[Nest] 1  - 11/03/2026, 1:16:51 PM   WARN [Quarantine] could not file\n\u001b[32mhalf');
    system.captureApiOutput(' a line\n');
    const api = await root.get('/api/system/log-entries/api').expect(200);
    expect(api.body.data.slice(-2)).toEqual([
      expect.objectContaining({ level: 'warning', source: 'Quarantine', message: 'could not file' }),
      expect.objectContaining({ level: 'info', message: 'half a line' }),
    ]);

    await root.get('/api/system/log-entries/nginx').expect(400);
    await root.get('/api/system/log-entries/rspamd?level=loud').expect(400);
    await org.owner.agent.get('/api/system/log-entries/rspamd').expect(404);
    await newAgent(app).get('/api/system/log-entries/rspamd').expect(401);
  });

  it('accepts reports from the new services, with the reports secret only', async () => {
    await request(app.getHttpServer()).post('/api/internal/reports/unbound').set('content-type', 'text/plain').send('x').expect(401);
  });

  it('sums the instance up for the dashboard', async () => {
    const res = await root.get('/api/system/overview').expect(200);
    expect(res.body.counts.organizations).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.mailboxes).toBeGreaterThanOrEqual(1);
    expect(res.body).toMatchObject({ queue: { messages: expect.any(Number) }, services: { ok: expect.any(Number) } });
    await org.owner.agent.get('/api/system/overview').expect(404);
  });

  it('shows Rspamd’s statistics, its whole history and the last day per hour', async () => {
    const stats = await root.get('/api/system/rspamd/stats').expect(200);
    expect(stats.body).toMatchObject({ version: '3.12.1', scanned: 42, actions: { reject: 2 } });
    expect(seen.at(-1)?.password).toBe('read-only-secret');

    const history = await root.get('/api/system/rspamd/history?limit=2').expect(200);
    expect(history.body.data.map((s: { id: string; outcome: string }) => [s.id, s.outcome])).toEqual([
      ['h1', 'delivered'],
      ['h2', 'rejected'],
    ]);
    const search = await root.get('/api/system/rspamd/history?filter=bob@').expect(200);
    expect(search.body.data.map((s: { id: string; user: string }) => [s.id, s.user])).toEqual([['h3', 'ann@a.example']]);

    const traffic = await root.get('/api/system/rspamd/traffic').expect(200);
    expect(traffic.body.hours).toHaveLength(24);
    expect(traffic.body.totals).toEqual({ delivered: 1, spam: 0, rejected: 1, greylisted: 0, outgoing: 1 });
    await org.owner.agent.get('/api/system/rspamd/history').expect(404);
  });

  it('opens Rspamd’s web interface to instance administrators only, with the server’s password', async () => {
    await root.get('/api/rspamd-ui').expect(308).expect('location', '/api/rspamd-ui/');
    const page = await root.get('/api/rspamd-ui/').set('password', 'guess').expect(200);
    expect(page.text).toContain('Rspamd');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(seen.at(-1)).toMatchObject({ url: '/', password: 'enable-secret' });

    // Learning goes through (with the enable password), from the panel's origin only.
    await root.post('/api/rspamd-ui/learnspam').set('content-type', 'text/plain').send('Subject: x\r\n\r\nspam').expect(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/learnspam', password: 'enable-secret', body: 'Subject: x\r\n\r\nspam' });
    await root.post('/api/rspamd-ui/learnspam').set('origin', 'https://evil.example').send('x').expect(403);

    const before = seen.length;
    await org.owner.agent.get('/api/rspamd-ui/').expect(404);
    await org.agent.get('/api/rspamd-ui/stat').expect(404);
    await newAgent(app).get('/api/rspamd-ui/').expect(404);
    expect(seen.length).toBe(before);
  });
});
