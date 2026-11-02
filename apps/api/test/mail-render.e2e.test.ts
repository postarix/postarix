import type { INestApplication } from '@nestjs/common';
import { type JmapRequest, type MemoryMailEngine } from '@postarix/mail-engine';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { proxiedImageUrl } from '../src/mail/image-proxy.js';
import { createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('Message rendering for the webmail', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let admin: TestUser;
  let ann: TestAgent;
  let annAddress: string;
  let seenAddresses: string[];

  const readJson = async (body: JmapRequest['body']) =>
    JSON.parse(Buffer.from(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString()) as {
      methodCalls: [string, { ids?: string[] }, string][];
    };

  beforeAll(async () => {
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    admin = await signUp(app, 'render-admin');
    const orgId = await createOrg(admin, 'Render');
    const domain = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `render-${Date.now()}.example` });
    await admin.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    const mailbox = await admin.agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId: domain.body.id, localPart: 'ann', password: PASSWORD })
      .expect(201);
    annAddress = mailbox.body.address;
    ann = await signIn(app, annAddress);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  beforeEach(() => {
    seenAddresses = [];
    engine.jmapHandler = async (address, req) => {
      seenAddresses.push(address);
      if (req.method === 'GET' && req.path === '') return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct' } });
      if (req.method === 'GET' && req.path.startsWith('download/')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      const { methodCalls } = await readJson(req.body);
      const id = methodCalls[0]![1].ids?.[0];
      // M1 exists in Ann's mailbox only.
      if (id !== 'M1' || address !== annAddress) return Response.json({ methodResponses: [['Email/get', { list: [] }, '0']] });
      return Response.json({
        methodResponses: [
          [
            'Email/get',
            {
              list: [
                {
                  id: 'M1',
                  threadId: 'T1',
                  mailboxIds: { inbox: true },
                  keywords: {},
                  subject: 'Hello',
                  from: [{ name: 'Bob', email: 'bob@outside.example' }],
                  to: [{ email: annAddress }],
                  cc: null,
                  bcc: null,
                  replyTo: null,
                  sentAt: '2026-11-01T10:00:00Z',
                  receivedAt: '2026-11-01T10:00:01Z',
                  messageId: ['abc@outside.example'],
                  inReplyTo: null,
                  references: null,
                  htmlBody: [{ partId: '1', type: 'text/html', size: 100 }],
                  textBody: [{ partId: '2', type: 'text/plain', size: 10 }],
                  attachments: [
                    { partId: '3', blobId: 'Blogo', type: 'image/png', size: 16, cid: '<logo@x>', name: 'logo.png' },
                    { partId: '4', blobId: 'Bpdf', type: 'application/pdf', size: 1000, name: 'invoice.pdf' },
                  ],
                  bodyValues: {
                    '1': {
                      value:
                        '<p onclick="steal()">Hi <b>Ann</b></p><script>alert(1)</script><img src="cid:logo@x"><img src="https://tracker.example/open.gif">',
                    },
                    '2': { value: 'Hi Ann' },
                  },
                },
              ],
            },
            '0',
          ],
        ],
      });
    };
  });

  it('renders sanitized HTML with inline images and blocked remote images', async () => {
    const res = await ann.get('/api/mail/messages/M1').expect(200);
    expect(res.body).toMatchObject({ id: 'M1', subject: 'Hello', text: 'Hi Ann', blockedImages: 1 });
    expect(res.body.html).toContain('<b>Ann</b>');
    expect(res.body.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    expect(res.body.html).not.toMatch(/script|onclick|tracker\.example/);
    // The inline logo is not listed as an attachment; the PDF is.
    expect(res.body.attachments).toEqual([{ blobId: 'Bpdf', name: 'invoice.pdf', type: 'application/pdf', size: 1000 }]);
    expect(new Set(seenAddresses)).toEqual(new Set([annAddress]));
  });

  it('loads remote images through signed proxy links only when asked', async () => {
    const res = await ann.get('/api/mail/messages/M1?remoteImages=1').expect(200);
    expect(res.body.blockedImages).toBe(0);
    const src = /src="(http:\/\/localhost:3000\/api\/mail\/image\?[^"]+)"/.exec(res.body.html)?.[1];
    expect(src).toBeDefined();
    const url = new URL(src!.replace(/&amp;/g, '&'));
    expect(url.searchParams.get('u')).toBe('https://tracker.example/open.gif');
  });

  it('never shows a message of another organization’s mailbox', async () => {
    const other = await mailboxInNewOrg(app, 'render-other');
    seenAddresses = [];
    await other.agent.get('/api/mail/messages/M1').expect(404);
    expect(seenAddresses.length).toBeGreaterThan(0);
    expect(new Set(seenAddresses)).toEqual(new Set([other.address]));
  });

  it('answers 404 for unknown messages and users without a mailbox', async () => {
    await ann.get('/api/mail/messages/nope').expect(404);
    await admin.agent.get('/api/mail/messages/M1').expect(404);
    await request(app.getHttpServer()).get('/api/mail/messages/M1').expect(401);
  });

  it('serves proxied images only for valid signatures, and never from internal addresses', async () => {
    const server = request(app.getHttpServer());
    await server.get('/api/mail/image').query({ u: 'https://example.com/a.png', e: '9999999999', s: 'forged' }).expect(403);
    const signed = new URL(proxiedImageUrl(process.env.AUTH_SECRET!, 'http://localhost:3000/api/mail/image', 'http://169.254.169.254/latest/meta-data'));
    const res = await server.get(`/api/mail/image${signed.search}`).expect(403);
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });
});
