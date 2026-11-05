import type { INestApplication } from '@nestjs/common';
import { type JmapRequest, type MemoryMailEngine } from '@postarix/mail-engine';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

describe('JMAP proxy for the webmail', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let admin: TestUser;
  let ann: TestAgent;
  let ben: TestAgent;
  let annAddress: string;
  let benAddress: string;
  let calls: { address: string; request: JmapRequest; body: string }[];

  const readBody = async (body: JmapRequest['body']) =>
    body ? Buffer.from(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString('utf8') : '';

  beforeAll(async () => {
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    admin = await signUp(app, 'jmap-admin');
    const orgId = await createOrg(admin, 'Jmap');
    const domain = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `jmap-${Date.now()}.example` });
    await admin.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    const create = async (localPart: string) =>
      (
        await admin.agent
          .post(`/api/orgs/${orgId}/mailboxes`)
          .send({ domainId: domain.body.id, localPart, password: PASSWORD })
          .expect(201)
      ).body.address as string;
    annAddress = await create('ann');
    benAddress = await create('ben');
    ann = await signIn(app, annAddress);
    ben = await signIn(app, benAddress);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  beforeEach(() => {
    calls = [];
    engine.jmapHandler = async (address, req) => {
      calls.push({ address, request: req, body: await readBody(req.body) });
      if (req.method === 'GET' && req.path === '') {
        return Response.json({
          apiUrl: '/jmap/',
          downloadUrl: 'http://cyrus:8008/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
          uploadUrl: '/jmap/upload/{accountId}/',
          eventSourceUrl: '/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
          username: address,
        });
      }
      if (req.path.startsWith('download/')) {
        const type = req.path.endsWith('.png') ? 'image/png' : 'text/html';
        return new Response('<script>alert(1)</script>', { headers: { 'content-type': type } });
      }
      return Response.json({ methodResponses: [], sessionState: 's1' });
    };
  });

  it('serves the session with URLs pointing at the proxy', async () => {
    const res = await ann.get('/api/jmap/').expect(200);
    expect(res.body).toMatchObject({
      apiUrl: '/api/jmap/',
      downloadUrl: '/api/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
      uploadUrl: '/api/jmap/upload/{accountId}/',
      eventSourceUrl: '/api/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
    });
    expect(calls[0]?.address).toBe(annAddress);
  });

  it('always acts as the signed-in user, whatever the request says', async () => {
    await ben
      .post('/api/jmap/')
      .set('authorization', `Basic ${Buffer.from(`${annAddress}:x`).toString('base64')}`)
      .set('authorize-as', annAddress)
      .send({ using: ['urn:ietf:params:jmap:core'], methodCalls: [] })
      .expect(200);
    expect(calls.map((c) => c.address)).toEqual([benAddress]);
    expect(calls[0]?.body).toContain('urn:ietf:params:jmap:core');
  });

  it('refuses anonymous users, users without a mailbox and untrusted origins', async () => {
    await request(app.getHttpServer()).get('/api/jmap/').expect(401);
    await admin.agent.get('/api/jmap/').expect(404);
    await ann.post('/api/jmap/').set('origin', 'https://evil.example').send({}).expect(403);
    expect(calls).toEqual([]);
  });

  it('only exposes the JMAP resources the webmail needs', async () => {
    for (const path of ['/api/jmap/../admin', '/api/jmap/%2e%2e/x', '/api/jmap/foo', '/api/jmap/upload/a/b/c']) {
      await ann.get(path).expect((res) => expect([404, 400]).toContain(res.status));
    }
    await ann.delete('/api/jmap/').expect(405);
    await ann.post('/api/jmap/download/a/b/c').send({}).expect(404);
    expect(calls).toEqual([]);
  });

  it('serves downloads as attachments, except plain images, and never lets them run', async () => {
    const html = await ann.get(`/api/jmap/download/${annAddress}/B1/page.html?accept=text/html`).expect(200);
    expect(html.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''page\.html$/);
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    const png = await ann.get(`/api/jmap/download/${annAddress}/B2/photo.png`).expect(200);
    expect(png.headers['content-disposition']).toMatch(/^inline;/);
    expect(calls.map((c) => c.request.query)).toEqual(['accept=text/html', '']);
  });

  it('streams uploads up to the limit and refuses larger ones', async () => {
    await ann
      .post(`/api/jmap/upload/${annAddress}/`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(1024, 1))
      .expect(200);
    expect(calls[0]?.body.length).toBe(1024);
    await ann
      .post(`/api/jmap/upload/${annAddress}/`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(51 * 1024 * 1024, 1))
      .expect(413);
  });

  it('reports an unavailable mail server as 503', async () => {
    engine.jmapHandler = null;
    await ann.get('/api/jmap/').expect(503);
  });

  it('only lets through the capabilities and methods the webmail uses', async () => {
    const call = (using: string[], methodCalls: unknown[]) => ann.post('/api/jmap/').send({ using, methodCalls });
    const core = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    for (const name of ['EmailSubmission/set', 'Identity/get', 'SieveScript/set', 'VacationResponse/set', 'Backup/restoreMail', 'Admin/rewriteCalEventPrivacy']) {
      await call(core, [[name, {}, 'c0']]).expect(403);
    }
    for (const capability of ['urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:sieve', 'https://cyrusimap.org/ns/jmap/backup']) {
      await call([...core, capability], [['Email/get', {}, 'c0']]).expect(403);
    }
    // One forbidden call spoils the whole request.
    await call(core, [['Email/get', {}, 'c0'], ['EmailSubmission/set', {}, 'c1']]).expect(403);
    await ann.post('/api/jmap/').set('content-type', 'application/json').send('{not json').expect(400);
    expect(calls).toEqual([]);

    await call(core, [['Email/query', {}, 'c0'], ['Email/get', {}, 'c1'], ['Mailbox/get', {}, 'c2']]).expect(200);
    expect(JSON.parse(calls[0]!.body)).toEqual({ using: core, methodCalls: [['Email/query', {}, 'c0'], ['Email/get', {}, 'c1'], ['Mailbox/get', {}, 'c2']] });
  });

  it('advertises only the capabilities it lets through', async () => {
    const full = {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
      'https://cyrusimap.org/ns/jmap/backup': {},
    };
    engine.jmapHandler = async () =>
      Response.json({
        apiUrl: '/jmap/',
        capabilities: full,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': annAddress, 'urn:ietf:params:jmap:submission': annAddress },
        accounts: { [annAddress]: { name: annAddress, accountCapabilities: full } },
      });
    const res = await ann.get('/api/jmap/').expect(200);
    const kept = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    expect(Object.keys(res.body.capabilities)).toEqual(kept);
    expect(Object.keys(res.body.primaryAccounts)).toEqual(['urn:ietf:params:jmap:mail']);
    expect(Object.keys(res.body.accounts[annAddress].accountCapabilities)).toEqual(kept);
  });

  it('answers a malformed download name without an error', async () => {
    const res = await ann.get(`/api/jmap/download/${annAddress}/B1/%E0%A4`).expect(200);
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''download");
  });

  it('keeps people of other organizations on their own mailbox', async () => {
    const other = await mailboxInNewOrg(app, 'jmap-other');
    await other.agent.get('/api/jmap/').expect(200);
    // Naming someone else's account is refused before reaching the mail server.
    await other.agent
      .post('/api/jmap/')
      .set('authorize-as', annAddress)
      .send({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [['Email/get', { accountId: annAddress }, 'c0']] })
      .expect(403);
    await other.agent.get(`/api/jmap/download/${annAddress}/B1/x.png`).expect(404);
    await other.agent
      .post('/api/jmap/')
      .set('authorize-as', annAddress)
      .send({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [['Email/get', {}, 'c0']] })
      .expect(200);
    expect(calls.map((c) => c.address)).toEqual([other.address, other.address]);
  });
});
