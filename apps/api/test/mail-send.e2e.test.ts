import type { INestApplication } from '@nestjs/common';
import { type MemoryMailEngine } from '@postarix/mail-engine';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

interface FakeDraft {
  from: { email: string }[];
  to: { email: string }[];
  cc?: { email: string }[];
  bcc?: { email: string }[];
  sender?: { email: string }[];
  keywords: Record<string, boolean>;
}

// Validation of webmail sending. Delivery itself is covered by the integration
// tests; here the submission port points nowhere, so a draft that passes every
// check ends with 503 instead of being sent.
describe('Webmail sending rules', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let admin: TestUser;
  let ann: TestAgent;
  let annAddress: string;
  let domainName: string;
  let draft: FakeDraft;
  const saved = { host: process.env.SUBMISSION_HOST, port: process.env.SUBMISSION_PORT };

  beforeAll(async () => {
    process.env.SUBMISSION_HOST = '127.0.0.1';
    process.env.SUBMISSION_PORT = '9'; // discard: nothing listens
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    admin = await signUp(app, 'send-admin');
    const orgId = await createOrg(admin, 'Send');
    const domain = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `send-${Date.now()}.example` });
    domainName = domain.body.name;
    await admin.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    const mailbox = await admin.agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId: domain.body.id, localPart: 'ann', password: PASSWORD })
      .expect(201);
    annAddress = mailbox.body.address;
    await admin.agent
      .post(`/api/orgs/${orgId}/aliases`)
      .send({ domainId: domain.body.id, localPart: 'sales', destinations: [annAddress] })
      .expect(201);
    ann = await signIn(app, annAddress);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
    Object.assign(process.env, { SUBMISSION_HOST: saved.host, SUBMISSION_PORT: saved.port });
  });

  beforeEach(() => {
    draft = { from: [{ email: annAddress }], to: [{ email: 'bob@outside.example' }], keywords: { $draft: true } };
    engine.jmapHandler = async (_address, req) => {
      if (req.method === 'GET' && req.path === '') {
        return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct' } });
      }
      if (req.method === 'GET' && req.path.startsWith('download/')) {
        return new Response(`From: ${draft.from[0]?.email}\r\nTo: bob@outside.example\r\nSubject: hi\r\n\r\nHello\r\n`);
      }
      const body = JSON.parse(Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString()) as {
        methodCalls: [string, { ids?: string[] }, string][];
      };
      const [name, args] = body.methodCalls[0]!;
      if (name === 'Email/get') {
        const list = args.ids?.[0] === 'missing' ? [] : [{ id: args.ids?.[0], blobId: 'B1', size: 100, ...draft }];
        return Response.json({ methodResponses: [['Email/get', { list }, '0']] });
      }
      return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    };
  });

  const send = (emailId = 'M1') => ann.post('/api/mail/send').send({ emailId });

  it('sends a valid draft (reaching the submission step)', async () => {
    await send().expect(503);
  });

  it('lets the user send as an alias of their organization that delivers to them', async () => {
    draft.from = [{ email: `sales@${domainName}` }];
    await send().expect(503);
  });

  it('refuses From addresses the user does not own', async () => {
    for (const email of [`boss@${domainName}`, 'ceo@other.example']) {
      draft.from = [{ email }];
      const res = await send().expect(403);
      expect(res.body.message).toContain(email);
    }
  });

  it('refuses ambiguous senders', async () => {
    draft.from = [{ email: annAddress }, { email: `sales@${domainName}` }];
    await send().expect(422);
    draft.from = [{ email: annAddress }];
    draft.sender = [{ email: 'someone@else.example' }];
    await send().expect(422);
  });

  it('only sends drafts, with valid and not too many recipients', async () => {
    await send('missing').expect(404);
    draft.keywords = {};
    await send().expect(422);
    draft.keywords = { $draft: true };
    draft.to = [];
    await send().expect(422);
    draft.to = [{ email: 'not an address' }];
    await send().expect(422);
    draft.to = Array.from({ length: 101 }, (_, i) => ({ email: `r${i}@outside.example` }));
    await send().expect(422);
  });

  it('lists the addresses the user may send as, own address first', async () => {
    const res = await ann.get('/api/mail/identities').expect(200);
    expect(res.body).toEqual({ address: annAddress, addresses: [annAddress, `sales@${domainName}`] });
    await admin.agent.get('/api/mail/identities').expect(404);
  });

  it('refuses users without a mailbox and malformed ids', async () => {
    await admin.agent.post('/api/mail/send').send({ emailId: 'M1' }).expect(404);
    await send('../etc').expect(400);
  });
});
