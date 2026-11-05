import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { desc, sql } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { internalSecret } from '../src/config/internal-secrets.js';
import { DATABASE, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { sessionDisconnects } from '../src/db/schema/index.js';
import { createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

const MAIL = 'urn:ietf:params:jmap:mail';

describe('Shared mailboxes', () => {
  let app: INestApplication;
  let db: Database;
  let engine: MemoryMailEngine;
  let admin: TestUser;
  let orgId: string;
  let domainId: string;
  let domainName: string;
  let team: { id: string; address: string };
  let ann: { id: string; userId: string; address: string; agent: TestAgent };
  let ben: { id: string; userId: string; address: string; agent: TestAgent };
  let other: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let calls: { address: string; path: string; body: string }[];

  const person = async (localPart: string) => {
    const body = (
      await admin.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId, localPart, password: PASSWORD }).expect(201)
    ).body as { id: string; userId: string; address: string };
    return { ...body, agent: await signIn(app, body.address) };
  };
  const members = () => admin.agent.get(`/api/orgs/${orgId}/mailboxes/${team.id}/members`).expect(200);
  const setMember = (userId: string, rights: string) => admin.agent.put(`/api/orgs/${orgId}/mailboxes/${team.id}/members/${userId}`).send({ rights });
  const lastDisconnects = async (n = 5) => (await db.select().from(sessionDisconnects).orderBy(desc(sessionDisconnects.id)).limit(n)).map((r) => r.username);

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    admin = await signUp(app, 'shared-admin');
    orgId = await createOrg(admin, 'Shared');
    domainName = `shared-${Date.now()}.example`;
    const domain = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: domainName });
    domainId = domain.body.id;
    await admin.agent.post(`/api/orgs/${orgId}/domains/${domainId}/verify`).expect(200);
    ann = await person('ann');
    ben = await person('ben');
    other = await mailboxInNewOrg(app, 'shared-other');
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  beforeEach(() => {
    calls = [];
    engine.jmapHandler = async (address, req) => {
      const body = req.body ? Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString('utf8') : '';
      calls.push({ address, path: req.path, body });
      if (req.method === 'GET' && req.path === '') {
        return Response.json({
          apiUrl: '/jmap/',
          primaryAccounts: { [MAIL]: address },
          accounts: {
            [address]: { name: address, isPersonal: true, accountCapabilities: { [MAIL]: {}, 'urn:ietf:params:jmap:calendars': {} } },
            [team.address]: { name: team.address, isPersonal: false, isReadOnly: false, accountCapabilities: { [MAIL]: {} } },
            [`colleague@${domainName}`]: { name: 'c', isPersonal: false, accountCapabilities: { [MAIL]: {}, 'urn:ietf:params:jmap:calendars': {} } },
          },
        });
      }
      return Response.json({ methodResponses: [], sessionState: 's1' });
    };
  });

  it('is created without a password or an account, and nobody signs in as it', async () => {
    await admin.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId, localPart: 'nope', kind: 'shared', password: PASSWORD }).expect(400);
    await admin.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId, localPart: 'nope' }).expect(400);
    const created = await admin.agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId, localPart: 'team', kind: 'shared', displayName: 'Support team' })
      .expect(201);
    team = created.body;
    expect(created.body).toMatchObject({ kind: 'shared', userId: null, sharedSeen: true });
    expect(engine.access.get(team.address)).toEqual({ access: [], sharedSeen: true });

    const token = internalSecret('internal-test-token-that-is-long-enough', 'mail-auth');
    await request(app.getHttpServer())
      .post('/api/internal/mail-auth')
      .type('form')
      .set('x-postarix-internal-token', token)
      .send({ username: team.address, password: PASSWORD, service: 'imap' })
      .expect(401);
    await admin.agent.post(`/api/orgs/${orgId}/mailboxes/${team.id}/password`).send({ password: PASSWORD }).expect(404);
    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${team.id}`).send({ kind: 'person' }).expect(422);
    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${ann.id}`).send({ sharedSeen: true }).expect(422);
  });

  it('has members with rights, set on the mail server', async () => {
    expect((await setMember(ann.userId, 'send').expect(200)).body.data).toMatchObject([{ userId: ann.userId, address: ann.address, rights: 'send' }]);
    await setMember(ben.userId, 'read').expect(200);
    expect(engine.access.get(team.address)).toEqual({
      access: [
        { grantee: ann.address, level: 'readWrite' },
        { grantee: ben.address, level: 'read' },
      ],
      sharedSeen: true,
    });
    expect((await members()).body.data.map((m: { rights: string }) => m.rights)).toEqual(['send', 'read']);
    // Only people of the organization with a person mailbox.
    await setMember(other.owner.id, 'read').expect(404);
    await setMember('no-such-user', 'read').expect(404);
    await setMember(ann.userId, 'admin').expect(400);
    // A person mailbox has no members.
    await admin.agent.get(`/api/orgs/${orgId}/mailboxes/${ann.id}/members`).expect(422);
    const audit = (await admin.agent.get(`/api/orgs/${orgId}/audit`).expect(200)).body.data as { action: string; details: unknown }[];
    expect(audit.find((e) => e.action === 'shared_mailbox.member_set')?.details).toMatchObject({ member: ben.address, rights: 'read' });
  });

  it('stays inside its organization', async () => {
    await other.owner.agent.get(`/api/orgs/${orgId}/mailboxes/${team.id}/members`).expect(404);
    await other.owner.agent.get(`/api/orgs/${other.orgId}/mailboxes/${team.id}/members`).expect(404);
    await other.owner.agent.put(`/api/orgs/${other.orgId}/mailboxes/${team.id}/members/${other.owner.id}`).send({ rights: 'send' }).expect(404);
    await other.owner.agent.delete(`/api/orgs/${other.orgId}/mailboxes/${team.id}/members/${ann.userId}`).expect(404);
    await other.owner.agent.post(`/api/orgs/${other.orgId}/mailboxes/${team.id}/access/reconcile`).expect(404);
    await other.owner.agent.put(`/api/orgs/${orgId}/mail-options`).send({ sharedSenderHeader: true }).expect(404);
    // Members are not administrators.
    await ann.agent.get(`/api/orgs/${orgId}/mailboxes/${team.id}/members`).expect(403);
    await ann.agent.put(`/api/orgs/${orgId}/mailboxes/${team.id}/members/${ann.userId}`).send({ rights: 'send' }).expect(403);
    // Other people see none of it.
    calls = [];
    const session = await other.agent.get('/api/jmap/').expect(200);
    expect(Object.keys(session.body.accounts)).not.toContain(team.address);
  });

  it('shows members only their own and their shared mailboxes in JMAP, read-only for readers', async () => {
    const session = await ann.agent.get('/api/jmap/').expect(200);
    expect(session.body.accounts[team.address]).toMatchObject({ name: 'Support team', isReadOnly: false, accountCapabilities: { [MAIL]: {} } });
    // A colleague's calendar shared with Ann keeps its account, without mail.
    expect(session.body.accounts[`colleague@${domainName}`].accountCapabilities).toEqual({ 'urn:ietf:params:jmap:calendars': {} });
    const benSession = await ben.agent.get('/api/jmap/').expect(200);
    expect(benSession.body.accounts[team.address].isReadOnly).toBe(true);

    await ann.agent.post('/api/jmap/').send({ using: ['urn:ietf:params:jmap:core', MAIL], methodCalls: [['Email/query', { accountId: team.address }, 'c']] }).expect(200);
    await ann.agent
      .post('/api/jmap/')
      .send({ using: ['urn:ietf:params:jmap:core', MAIL], methodCalls: [['Email/query', { accountId: `colleague@${domainName}` }, 'c']] })
      .expect(403);
    await ann.agent.get(`/api/jmap/download/${encodeURIComponent(team.address)}/B1/x.png`).expect(200);
    await ann.agent.get(`/api/jmap/download/${encodeURIComponent(`colleague@${domainName}`)}/B1/x.png`).expect(404);
    // Non-members get nothing of it.
    await other.agent.post('/api/jmap/').send({ using: ['urn:ietf:params:jmap:core', MAIL], methodCalls: [['Email/get', { accountId: team.address }, 'c']] }).expect(403);
  });

  it('lists the shared mailboxes a person may send from among their identities', async () => {
    const annIds = (await ann.agent.get('/api/mail/identities').expect(200)).body;
    expect(annIds.shared).toEqual([{ address: team.address, name: 'Support team', accountId: team.address }]);
    expect(annIds.addresses).not.toContain(team.address);
    expect((await ben.agent.get('/api/mail/identities').expect(200)).body.shared).toEqual([]);
    // Mail apps too (Postfix checks the same view): Ann may send as it, Ben may not.
    const may = async (login: string) =>
      (await db.execute(sql`SELECT 1 FROM mail.sender_logins WHERE login = ${login} AND sender = ${team.address}`)).rows.length > 0;
    expect(await may(ann.address)).toBe(true);
    expect(await may(ben.address)).toBe(false);
  });

  it('takes access away at once: fewer rights, removal, a disabled shared mailbox', async () => {
    await setMember(ann.userId, 'read').expect(200);
    expect(await lastDisconnects(1)).toEqual([ann.address]);
    await admin.agent.delete(`/api/orgs/${orgId}/mailboxes/${team.id}/members/${ben.userId}`).expect(204);
    expect(await lastDisconnects(1)).toEqual([ben.address]);
    expect(engine.access.get(team.address)?.access).toEqual([{ grantee: ann.address, level: 'read' }]);
    expect(Object.keys((await ben.agent.get('/api/jmap/').expect(200)).body.accounts)).not.toContain(team.address);

    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${team.id}`).send({ sharedSeen: false }).expect(200);
    expect(engine.access.get(team.address)?.sharedSeen).toBe(false);

    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${team.id}`).send({ status: 'disabled' }).expect(200);
    expect(await lastDisconnects(1)).toEqual([ann.address]);
    expect(Object.keys((await ann.agent.get('/api/jmap/').expect(200)).body.accounts)).not.toContain(team.address);
    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${team.id}`).send({ status: 'active' }).expect(200);
  });

  it("forgets a member whose mailbox is deleted, so the address's next owner does not inherit it", async () => {
    const cat = await person('cat');
    await setMember(cat.userId, 'readWrite').expect(200);
    await admin.agent.delete(`/api/orgs/${orgId}/mailboxes/${cat.id}`).expect(204);
    expect(engine.access.get(team.address)?.access.map((a) => a.grantee)).not.toContain(cat.address);
  });

  it('sends from the shared mailbox only with "send", from its own account and address', async () => {
    const draft = { from: [{ email: team.address }], to: [{ email: 'x@outside.example' }], keywords: { $draft: true } };
    engine.jmapHandler = async (address, req) => {
      const body = req.body ? Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString('utf8') : '';
      calls.push({ address, path: req.path, body });
      if (req.method === 'GET' && req.path.startsWith('download/')) return new Response(`From: ${draft.from[0]!.email}\r\nSubject: hi\r\n\r\nHello\r\n`);
      const [name, args] = (JSON.parse(body) as { methodCalls: [string, { ids?: string[] }, string][] }).methodCalls[0]!;
      if (name === 'Email/get') return Response.json({ methodResponses: [['Email/get', { list: [{ id: args.ids?.[0], blobId: 'B1', size: 100, ...draft }] }, '0']] });
      return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    };
    // Ann reads only now.
    await ann.agent.post('/api/mail/send').send({ emailId: 'M1', accountId: team.address }).expect(403);
    await setMember(ann.userId, 'send').expect(200);
    // No submission server here: passing every check ends in 503.
    await ann.agent.post('/api/mail/send').send({ emailId: 'M1', accountId: team.address }).expect(503);
    const get = calls.find((c) => c.body.includes('Email/get'));
    expect(get?.address).toBe(ann.address);
    expect(JSON.parse(get!.body).methodCalls[0][1].accountId).toBe(team.address);
    // From must be the shared mailbox (or what it may send as), not someone else.
    draft.from = [{ email: ben.address }];
    await ann.agent.post('/api/mail/send').send({ emailId: 'M1', accountId: team.address }).expect(403);
    // Not a member: as if it did not exist.
    await ben.agent.post('/api/mail/send').send({ emailId: 'M1', accountId: team.address }).expect(404);
    await other.agent.post('/api/mail/send').send({ emailId: 'M1', accountId: team.address }).expect(404);
  });

  it('lets organization admins choose whether mail from shared mailboxes names its sender', async () => {
    expect((await admin.agent.get(`/api/orgs/${orgId}/mail-options`).expect(200)).body).toEqual({ sharedSenderHeader: false });
    expect((await admin.agent.put(`/api/orgs/${orgId}/mail-options`).send({ sharedSenderHeader: true }).expect(200)).body).toEqual({ sharedSenderHeader: true });
    await ann.agent.get(`/api/orgs/${orgId}/mail-options`).expect(403);
  });
});
