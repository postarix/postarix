import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE, MAIL_ENGINE, SYSTEM_MAILER } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { supervisionAccess, user } from '../src/db/schema/index.js';
import type { MemorySystemMailer } from '../src/mail/system-mailer.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const EXTERNAL = 'urn:postarix:params:oauth:token-type:external-subject';
const USER_ID = 'urn:postarix:params:oauth:token-type:user-id';
const ISSUER = 'https://shop.example.test';
const MAIL = 'urn:ietf:params:jmap:mail';
const USING = ['urn:ietf:params:jmap:core', MAIL];

type Org = Awaited<ReturnType<typeof mailboxInNewOrg>>;

describe('Connected applications', () => {
  let app: INestApplication;
  let db: Database;
  let engine: MemoryMailEngine;
  let a: Org;
  let b: Org;
  let aUser: { id: string; userId: string; address: string };
  let boss: { id: string; userId: string; address: string };
  let client: { id: string; clientId: string; clientSecret: string };
  let calls: { address: string; body: string }[];

  const http = () => request(app.getHttpServer());
  const token = (fields: Record<string, string>, auth?: { id: string; secret: string }) => {
    const req = http().post('/api/oauth/token').type('form');
    if (auth) req.auth(auth.id, auth.secret);
    return req.send(fields);
  };
  const exchange = (subject: string, scope: string, extra: Record<string, string> = {}, c = client) =>
    token({ grant_type: EXCHANGE, subject_token: subject, subject_token_type: EXTERNAL, scope, ...extra }, { id: c.clientId, secret: c.clientSecret });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const jmap = (t: string, methodCalls: unknown[]) => http().post('/api/jmap/').set(bearer(t)).send({ using: USING, methodCalls });

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    a = await mailboxInNewOrg(app, 'capp-a');
    b = await mailboxInNewOrg(app, 'capp-b');
    const list = (await a.owner.agent.get(`/api/orgs/${a.orgId}/mailboxes`).expect(200)).body.data;
    aUser = list[0];
    boss = (await a.owner.agent.post(`/api/orgs/${a.orgId}/mailboxes`).send({ domainId: a.domainId, localPart: 'boss', password: PASSWORD }).expect(201)).body;
    await a.owner.agent.post(`/api/orgs/${a.orgId}/identities`).send({ mailboxId: aUser.id, issuer: ISSUER, subject: 'u-1' }).expect(201);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/identities`).send({ mailboxId: boss.id, issuer: ISSUER, subject: 'boss-1' }).expect(201);
    // The same subject in another organization.
    const bMailbox = (await b.owner.agent.get(`/api/orgs/${b.orgId}/mailboxes`).expect(200)).body.data[0];
    await b.owner.agent.post(`/api/orgs/${b.orgId}/identities`).send({ mailboxId: bMailbox.id, issuer: ISSUER, subject: 'b-1' }).expect(201);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  beforeEach(() => {
    calls = [];
    engine.jmapHandler = async (address, req) => {
      const body = req.body ? Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString('utf8') : '';
      calls.push({ address, body });
      if (req.method === 'GET' && req.path === '') {
        return Response.json({ apiUrl: '/jmap/', primaryAccounts: { [MAIL]: address }, accounts: { [address]: { name: address, isPersonal: true, accountCapabilities: { [MAIL]: {}, 'urn:ietf:params:jmap:calendars': {} } } } });
      }
      if (body.includes('Mailbox/get')) {
        const { methodCalls } = JSON.parse(body) as { methodCalls: [string, Record<string, unknown>, string][] };
        return Response.json({
          methodResponses: methodCalls.map(([name, , id]) => [name, { list: [{ id: 'I', role: 'inbox', unreadEmails: 3 }] }, id]),
        });
      }
      if (body.includes('Email/get')) {
        return Response.json({ methodResponses: [['Email/get', { list: [] }, '0']] });
      }
      return Response.json({ methodResponses: [], sessionState: 's' });
    };
  });

  it('is registered by the organization’s owner, with its secret shown once', async () => {
    await a.agent.post(`/api/orgs/${a.orgId}/apps`).send({ name: 'Shop', identityIssuer: ISSUER, scopes: ['mail.read'] }).expect(403);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/apps`).send({ name: 'Bad', identityIssuer: ISSUER, scopes: ['mail.read'], jwksUri: 'http://keys.example.test/jwks' }).expect(422);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/apps`).send({ name: 'Bad', identityIssuer: ISSUER, scopes: ['mail.read'], jwksUri: 'https://10.0.0.5/jwks' }).expect(422);
    const created = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/apps`)
      .send({ name: 'Shop', identityIssuer: ISSUER, scopes: ['mail.read', 'mail.write', 'mail.send', 'mail.supervise'] })
      .expect(201);
    client = { id: created.body.id, clientId: created.body.clientId, clientSecret: created.body.clientSecret };
    expect(client.clientSecret).toMatch(/^pxs_/);
    const list = (await a.owner.agent.get(`/api/orgs/${a.orgId}/apps`).expect(200)).body.data;
    expect(list[0]).not.toHaveProperty('clientSecret');
    expect(list[0]).toMatchObject({ clientId: client.clientId, hasSecret: true });
  });

  it('stays inside its organization', async () => {
    await b.owner.agent.get(`/api/orgs/${a.orgId}/apps`).expect(404);
    expect((await b.owner.agent.get(`/api/orgs/${b.orgId}/apps`).expect(200)).body.data).toEqual([]);
    await b.owner.agent.patch(`/api/orgs/${b.orgId}/apps/${client.id}`).send({ name: 'mine' }).expect(404);
    await b.owner.agent.post(`/api/orgs/${b.orgId}/apps/${client.id}/secret`).expect(404);
    await b.owner.agent.post(`/api/orgs/${b.orgId}/apps/${client.id}/revoke`).expect(404);
    await b.owner.agent.delete(`/api/orgs/${b.orgId}/apps/${client.id}`).expect(404);
    await b.owner.agent.put(`/api/orgs/${a.orgId}/supervision`).send({ enabled: true, notify: false }).expect(404);
    await b.owner.agent.put(`/api/orgs/${b.orgId}/supervision/supervisors/${aUser.userId}`).expect(404);
    // An application of A gets no token for a person of B, even with B's identity of the same issuer.
    expect((await exchange('b-1', 'mail.read').expect(400)).body.error).toBe('invalid_grant');
  });

  it('exchanges its credentials for a short token acting as the person, by secret in the header or the body', async () => {
    const res = await exchange('u-1', 'mail.read mail.send').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 300, scope: 'mail.read mail.send', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
    const viaBody = await token({ grant_type: EXCHANGE, subject_token: 'u-1', subject_token_type: EXTERNAL, scope: 'mail.read', client_id: client.clientId, client_secret: client.clientSecret }).expect(200);
    const identities = await http().get('/api/mail/identities').set(bearer(viaBody.body.access_token)).expect(200);
    expect(identities.body.address).toBe(aUser.address);
    // Nothing but its mail routes.
    await http().get(`/api/orgs/${a.orgId}/mailboxes`).set(bearer(viaBody.body.access_token)).expect(403);
    await http().get('/api/me/app-passwords').set(bearer(viaBody.body.access_token)).expect(403);
    // Wrong secret, unknown client, unknown subject, unknown grant.
    expect((await token({ grant_type: EXCHANGE, subject_token: 'u-1', subject_token_type: EXTERNAL, scope: 'mail.read' }, { id: client.clientId, secret: 'nope' }).expect(401)).body.error).toBe('invalid_client');
    expect((await exchange('nobody', 'mail.read').expect(400)).body.error).toBe('invalid_grant');
    expect((await token({ grant_type: 'password' }, { id: client.clientId, secret: client.clientSecret }).expect(400)).body.error).toBe('unsupported_grant_type');
    expect((await exchange('u-1', 'mail.admin').expect(400)).body.error).toBe('invalid_scope');
    const audit = (await a.owner.agent.get(`/api/orgs/${a.orgId}/audit`).expect(200)).body.data as { action: string }[];
    expect(audit.filter((e) => e.action === 'app.token_issued')).toHaveLength(1);
  });

  it('keeps tokens to their scopes in JMAP, without cookies or an origin', async () => {
    const read = (await exchange('u-1', 'mail.read').expect(200)).body.access_token as string;
    const session = await http().get('/api/jmap/').set(bearer(read)).expect(200);
    expect(Object.keys(session.body.accounts[aUser.address].accountCapabilities)).toEqual([MAIL]);
    expect(session.body.accounts[aUser.address].isReadOnly).toBe(true);
    await jmap(read, [['Email/query', {}, 'q']]).expect(200);
    await jmap(read, [['Email/set', { update: {} }, 's']]).expect(403);
    await http().post('/api/jmap/').set(bearer(read)).send({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'], methodCalls: [['CalendarEvent/query', {}, 'c']] }).expect(403);
    await http().post(`/api/jmap/upload/${aUser.address}/`).set(bearer(read)).set('content-type', 'text/plain').send('x').expect(403);
    await http().post('/api/mail/send').set(bearer(read)).send({ emailId: 'M1' }).expect(403);
    const write = (await exchange('u-1', 'mail.read mail.write').expect(200)).body.access_token as string;
    await jmap(write, [['Email/set', { update: {} }, 's']]).expect(200);
    await http().get('/api/jmap/').set(bearer('pxt_not-a-real-token')).expect(401);
  });

  it('stops at once when the application is revoked, expired, asked from elsewhere, or the mailbox is disabled', async () => {
    const t = (await exchange('u-1', 'mail.read').expect(200)).body.access_token as string;
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/apps/${client.id}`).send({ allowedIps: ['203.0.113.0/24'] }).expect(200);
    await http().get('/api/mail/identities').set(bearer(t)).expect(401);
    expect((await exchange('u-1', 'mail.read').expect(401)).body.error).toBe('invalid_client');
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/apps/${client.id}`).send({ allowedIps: [] }).expect(200);
    await http().get('/api/mail/identities').set(bearer(t)).expect(200);

    await a.owner.agent.patch(`/api/orgs/${a.orgId}/apps/${client.id}`).send({ expiresAt: new Date(Date.now() - 1000).toISOString() }).expect(200);
    await http().get('/api/mail/identities').set(bearer(t)).expect(401);
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/apps/${client.id}`).send({ expiresAt: null }).expect(200);

    await a.owner.agent.patch(`/api/orgs/${a.orgId}/mailboxes/${aUser.id}`).send({ status: 'disabled' }).expect(200);
    await http().get('/api/mail/identities').set(bearer(t)).expect(404);
    await http().get('/api/jmap/').set(bearer(t)).expect(404);
    expect((await exchange('u-1', 'mail.read').expect(400)).body.error).toBe('invalid_grant');
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/mailboxes/${aUser.id}`).send({ status: 'active' }).expect(200);

    const other = await a.owner.agent.post(`/api/orgs/${a.orgId}/apps`).send({ name: 'Old', identityIssuer: ISSUER, scopes: ['mail.read'] }).expect(201);
    const oldClient = { id: other.body.id, clientId: other.body.clientId, clientSecret: other.body.clientSecret };
    const old = (await exchange('u-1', 'mail.read', {}, oldClient).expect(200)).body.access_token as string;
    await a.owner.agent.post(`/api/orgs/${a.orgId}/apps/${oldClient.id}/revoke`).expect(200);
    await http().get('/api/mail/identities').set(bearer(old)).expect(401);
    expect((await exchange('u-1', 'mail.read', {}, oldClient).expect(401)).body.error).toBe('invalid_client');
    const audit = (await a.owner.agent.get(`/api/orgs/${a.orgId}/audit`).expect(200)).body.data as { action: string }[];
    expect(audit.some((e) => e.action === 'app.revoked')).toBe(true);
  });

  it('never acts as an instance administrator, and names people by user id only when allowed', async () => {
    const byId = (id: string) => token({ grant_type: EXCHANGE, subject_token: id, subject_token_type: USER_ID, scope: 'mail.read' }, { id: client.clientId, secret: client.clientSecret });
    expect((await byId(aUser.userId).expect(400)).body.error).toBe('invalid_request');
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/apps/${client.id}`).send({ allowUserIdSubjects: true }).expect(200);
    await byId(aUser.userId).expect(200);
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, aUser.userId));
    try {
      expect((await byId(aUser.userId).expect(400)).body.error).toBe('invalid_grant');
      expect((await exchange('u-1', 'mail.read').expect(400)).body.error).toBe('invalid_grant');
    } finally {
      await db.update(user).set({ role: 'user' }).where(eq(user.id, aUser.userId));
    }
    // A user id of another organization is unknown here.
    const bUser = (await b.owner.agent.get(`/api/orgs/${b.orgId}/mailboxes`).expect(200)).body.data[0];
    expect((await byId(bUser.userId).expect(400)).body.error).toBe('invalid_grant');
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/apps/${client.id}`).send({ allowUserIdSubjects: false }).expect(200);
  });

  it('lets a supervisor read, never change, a person’s own mailbox, with a reason, when the organization allows it', async () => {
    const supervise = (extra: Record<string, string>) => exchange('u-1', 'mail.supervise', { actor_token: 'boss-1', actor_token_type: EXTERNAL, ...extra });
    expect((await supervise({ reason: 'Customer complaint #42' }).expect(400)).body.error).toBe('access_denied');
    // Members are not owners (Ann was signed out when her mailbox was disabled above).
    const member = await signIn(app, a.address);
    await member.put(`/api/orgs/${a.orgId}/supervision`).send({ enabled: true, notify: true }).expect(403);
    await a.owner.agent.put(`/api/orgs/${a.orgId}/supervision`).send({ enabled: true, notify: true }).expect(200);
    expect((await supervise({}).expect(400)).body.error).toBe('invalid_request');
    // Boss has not been given the right yet (being the owner would not be enough either).
    expect((await supervise({ reason: 'Customer complaint #42' }).expect(400)).body.error).toBe('access_denied');
    await a.owner.agent.put(`/api/orgs/${a.orgId}/supervision/supervisors/${boss.userId}`).expect(200);
    expect((await exchange('u-1', 'mail.supervise mail.read', { actor_token: 'boss-1', actor_token_type: EXTERNAL, reason: 'x reason' }).expect(400)).body.error).toBe('invalid_scope');
    expect((await exchange('boss-1', 'mail.supervise', { actor_token: 'boss-1', actor_token_type: EXTERNAL, reason: 'myself, why not' }).expect(400)).body.error).toBe('invalid_grant');

    const granted = await supervise({ reason: 'Customer complaint #42' }).expect(200);
    const t = granted.body.access_token as string;
    expect(granted.body.scope).toBe('mail.supervise');
    // Read-only, own mailbox only.
    await jmap(t, [['Email/get', { ids: ['M1'] }, 'g']]).expect(200);
    await jmap(t, [['Email/set', { update: { M1: { 'keywords/$seen': true } } }, 's']]).expect(403);
    await http().get('/api/mail/messages/M1').set(bearer(t)).expect((res) => expect([404, 422]).toContain(res.status));
    await http().get('/api/mail/messages/M1').query({ accountId: 'team@example.test' }).set(bearer(t)).expect(404);
    await http().post('/api/mail/send').set(bearer(t)).send({ emailId: 'M1' }).expect(403);
    await http().get('/api/mail/identities').set(bearer(t)).expect(403);
    expect(calls.some((c) => c.body.includes('Email/set'))).toBe(false);

    const audit = (await a.owner.agent.get(`/api/orgs/${a.orgId}/audit`).expect(200)).body.data as { action: string; details: Record<string, unknown> }[];
    const started = audit.find((e) => e.action === 'mailbox.supervision_started');
    expect(started?.details).toMatchObject({ app: 'Shop', reason: 'Customer complaint #42' });
    const grantId = started!.details.grantId as string;
    const logged = await db.select().from(supervisionAccess).where(eq(supervisionAccess.grantId, grantId));
    expect(logged.map((r) => r.request)).toEqual(expect.arrayContaining(['JMAP Email/get', 'GET /api/mail/messages/M1']));
    const log = (await a.owner.agent.get(`/api/orgs/${a.orgId}/supervision/grants/${grantId}/requests`).expect(200)).body.data;
    expect(log.length).toBeGreaterThan(0);
    await b.owner.agent.get(`/api/orgs/${b.orgId}/supervision/grants/${grantId}/requests`).expect(404);
    // The person was told (the organization chose to).
    const mailer = app.get<MemorySystemMailer>(SYSTEM_MAILER);
    expect(mailer.sent.some((m) => m.to === aUser.address && m.text.includes('Customer complaint #42'))).toBe(true);
    // Turning supervision off ends it at once.
    await a.owner.agent.put(`/api/orgs/${a.orgId}/supervision`).send({ enabled: false, notify: false }).expect(200);
    await jmap(t, [['Email/get', { ids: ['M1'] }, 'g']]).expect(401);
  });

  it('accepts private_key_jwt, each assertion once', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
    const created = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/apps`)
      .send({ name: 'Keys', identityIssuer: ISSUER, scopes: ['mail.read'], jwks: { keys: [jwk] }, requirePrivateKeyJwt: true })
      .expect(201);
    expect(created.body.clientSecret).toBeNull();
    const clientId = created.body.clientId as string;
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience('http://localhost:3000/api/oauth/token')
      .setIssuedAt()
      .setExpirationTime('50s')
      .setJti(`j-${Date.now()}`)
      .sign(privateKey);
    const fields = { grant_type: EXCHANGE, subject_token: 'u-1', subject_token_type: EXTERNAL, scope: 'mail.read', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion };
    await token(fields).expect(200);
    expect((await token(fields).expect(401)).body.error_description).toMatch(/already used/);
    const longLived = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(clientId).setSubject(clientId).setAudience('http://localhost:3000/api/oauth/token').setExpirationTime('10m').setJti('j-long').sign(privateKey);
    expect((await token({ ...fields, client_assertion: longLived }).expect(401)).body.error).toBe('invalid_client');
  });

  it('gives unread counts of linked people only, to the application’s own token', async () => {
    const appToken = (await token({ grant_type: 'client_credentials', scope: 'mail.read' }, { id: client.clientId, secret: client.clientSecret }).expect(200)).body.access_token as string;
    const res = await http().post('/api/mail/unread').set(bearer(appToken)).send({ subjects: ['u-1', 'b-1', 'nobody'] }).expect(200);
    expect(res.body.data).toEqual([
      { subject: 'u-1', inbox: 3, shared: [] },
      { subject: 'b-1', inbox: null, shared: [] },
      { subject: 'nobody', inbox: null, shared: [] },
    ]);
    // An application token is for this only; a person's token is not for this.
    await http().get('/api/jmap/').set(bearer(appToken)).expect(401);
    await http().get('/api/mail/identities').set(bearer(appToken)).expect(403);
    const personal = (await exchange('u-1', 'mail.read').expect(200)).body.access_token as string;
    await http().post('/api/mail/unread').set(bearer(personal)).send({ subjects: ['u-1'] }).expect(403);
  });

  it('can be managed by an instance administrator too', async () => {
    const rootEmail = `capp-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email: rootEmail, password: PASSWORD, name: 'Root' });
    const root = await signIn(app, rootEmail);
    const created = await root.post(`/api/orgs/${a.orgId}/apps`).send({ name: 'By root', identityIssuer: ISSUER, scopes: ['mail.read'] }).expect(201);
    await root.delete(`/api/orgs/${a.orgId}/apps/${created.body.id}`).expect(204);
  });
});
