import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { internalSecret } from '../src/config/internal-secrets.js';
import { DATABASE, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { appPasswords, externalIdentities, sessionDisconnects, sharedMailboxMembers, user } from '../src/db/schema/index.js';
import { authOf, createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const EXTERNAL = 'urn:postarix:params:oauth:token-type:external-subject';
const ISSUER = 'https://helpdesk.example.test';

describe('Converting mailboxes to shared and back', () => {
  let app: INestApplication;
  let db: Database;
  let engine: MemoryMailEngine;
  let admin: TestUser;
  let orgId: string;
  let domainId: string;
  let other: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  type Person = { id: string; userId: string; address: string; agent: TestAgent };
  let sales: Person;
  let ann: Person;
  let ben: Person;

  const http = () => request(app.getHttpServer());
  const mailAuth = (username: string, password: string) =>
    http()
      .post('/api/internal/mail-auth')
      .type('form')
      .set('x-postarix-internal-token', internalSecret('internal-test-token-that-is-long-enough', 'mail-auth'))
      .send({ username, password, service: 'imap' });
  const person = async (localPart: string): Promise<Person> => {
    const body = (await admin.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId, localPart, password: PASSWORD }).expect(201)).body;
    return { ...body, agent: await signIn(app, body.address) };
  };
  const convert = (id: string, body: object, agent = admin.agent, org = orgId) => agent.post(`/api/orgs/${org}/mailboxes/${id}/convert`).send(body);
  const audit = async () => (await admin.agent.get(`/api/orgs/${orgId}/audit`).expect(200)).body.data as { action: string; details: Record<string, unknown> }[];

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    admin = await signUp(app, 'convert-admin');
    orgId = await createOrg(admin, 'Convert');
    const domain = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `convert-${Date.now()}.example` });
    domainId = domain.body.id;
    await admin.agent.post(`/api/orgs/${orgId}/domains/${domainId}/verify`).expect(200);
    sales = await person('sales');
    ann = await person('ann');
    ben = await person('ben');
    other = await mailboxInNewOrg(app, 'convert-other');
  });

  afterAll(async () => {
    await app.close();
  });

  it('is for the organization’s administrators in the panel only', async () => {
    // Another organization: as if the mailbox did not exist.
    await convert(sales.id, { to: 'shared' }, other.owner.agent).expect(404);
    await convert(sales.id, { to: 'shared' }, other.owner.agent, other.orgId).expect(404);
    // Not its people who do not administer it.
    await convert(sales.id, { to: 'shared' }, ann.agent).expect(403);
    // Not API keys, not even an instance administrator's.
    const email = `convert-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    const root = await signIn(app, email);
    for (const organizationIds of [[orgId], []]) {
      const key = (await root.post('/api/system/api-keys').send({ name: 'K', access: 'write', organizationIds }).expect(201)).body.key as string;
      const refused = await http().post(`/api/orgs/${orgId}/mailboxes/${sales.id}/convert`).set('Authorization', `Bearer ${key}`).send({ to: 'shared' }).expect(403);
      expect(refused.body.code).toBe('PANEL_ONLY');
    }
    // PATCH still cannot change it.
    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${sales.id}`).send({ kind: 'shared' }).expect(422);
    // Members must be people with a mailbox here, and not the account that goes.
    for (const userId of [other.owner.id, sales.userId, 'nobody']) {
      expect((await convert(sales.id, { to: 'shared', members: [{ userId, rights: 'read' }] }).expect(422)).body.code).toBe('UNKNOWN_MEMBER');
    }
    await convert(sales.id, { to: 'shared', members: [{ userId: ann.userId, rights: 'admin' }] }).expect(400);
    await convert(sales.id, { to: 'person', password: PASSWORD }).expect(422);
  });

  it('turns a person’s mailbox into a shared one, keeping its mail and taking its account away', async () => {
    // What the account has: an app password, an external identity, a connected application's token.
    await sales.agent.post('/api/me/app-passwords').send({ name: 'Phone', scopes: ['imap'] }).expect(201);
    await admin.agent.post(`/api/orgs/${orgId}/identities`).send({ mailboxId: sales.id, issuer: ISSUER, subject: 's-1' }).expect(201);
    await admin.agent.post(`/api/orgs/${orgId}/identities`).send({ mailboxId: ann.id, issuer: ISSUER, subject: 'a-1' }).expect(201);
    const client = (await admin.agent.post(`/api/orgs/${orgId}/apps`).send({ name: 'Desk', identityIssuer: ISSUER, scopes: ['mail.read'] }).expect(201)).body;
    const token = (
      await http()
        .post('/api/oauth/token')
        .type('form')
        .auth(client.clientId, client.clientSecret)
        .send({ grant_type: EXCHANGE, subject_token: 's-1', subject_token_type: EXTERNAL, scope: 'mail.read' })
        .expect(200)
    ).body.access_token as string;
    await http().get('/api/mail/identities').set('Authorization', `Bearer ${token}`).expect(200);
    const annToken = (
      await http()
        .post('/api/oauth/token')
        .type('form')
        .auth(client.clientId, client.clientSecret)
        .send({ grant_type: EXCHANGE, subject_token: 'a-1', subject_token_type: EXTERNAL, scope: 'mail.read' })
        .expect(200)
    ).body.access_token as string;
    await sales.agent.get('/api/me/app-passwords').expect(200);
    await mailAuth(sales.address, PASSWORD).expect(204);
    const mail = engine.mailboxes.get(sales.address);
    expect(mail).toBeDefined();

    const converted = await convert(sales.id, { to: 'shared', members: [{ userId: ann.userId, rights: 'send' }, { userId: ben.userId, rights: 'read' }] }).expect(201);
    expect(converted.body).toMatchObject({ id: sales.id, address: sales.address, kind: 'shared', userId: null, sharedSeen: true });

    // The mail stays where it was.
    expect(engine.mailboxes.get(sales.address)).toBe(mail);
    expect(engine.access.get(sales.address)).toEqual({
      access: [
        { grantee: ann.address, level: 'readWrite' },
        { grantee: ben.address, level: 'read' },
      ],
      sharedSeen: true,
    });
    // The account and everything of it are gone.
    expect(await db.select().from(user).where(eq(user.id, sales.userId))).toEqual([]);
    expect(await db.select().from(appPasswords).where(eq(appPasswords.userId, sales.userId))).toEqual([]);
    expect(await db.select().from(externalIdentities).where(eq(externalIdentities.userId, sales.userId))).toEqual([]);
    await mailAuth(sales.address, PASSWORD).expect(401);
    await sales.agent.get('/api/me/app-passwords').expect(401);
    await http().get('/api/mail/identities').set('Authorization', `Bearer ${token}`).expect(401);
    // Other people's tokens keep working.
    await http().get('/api/mail/identities').set('Authorization', `Bearer ${annToken}`).expect(200);
    // Its open mail sessions are ended.
    const disconnects = await db.select().from(sessionDisconnects).orderBy(desc(sessionDisconnects.id)).limit(5);
    expect(disconnects.find((d) => d.username === sales.address)?.reason).toBe('mailbox_converted');

    // The organization's API shows it as shared, with its members.
    const list = (await admin.agent.get(`/api/orgs/${orgId}/mailboxes`).expect(200)).body.data as { id: string; kind: string }[];
    expect(list.find((m) => m.id === sales.id)?.kind).toBe('shared');
    const members = (await admin.agent.get(`/api/orgs/${orgId}/mailboxes/${sales.id}/members`).expect(200)).body.data;
    expect(members.map((m: { address: string; rights: string }) => [m.address, m.rights])).toEqual([
      [ann.address, 'send'],
      [ben.address, 'read'],
    ]);

    const entry = (await audit()).find((e) => e.action === 'mailbox.converted');
    expect(entry?.details).toMatchObject({
      from: 'person',
      to: 'shared',
      sharedSeen: true,
      members: [
        { member: ann.address, rights: 'send' },
        { member: ben.address, rights: 'read' },
      ],
      removedIdentities: [{ issuer: ISSUER, subject: 's-1' }],
      removedAppPasswords: 1,
    });
    await convert(sales.id, { to: 'shared' }).expect(422);
  });

  it('turns a shared mailbox back into a person’s, with a new account', async () => {
    await convert(sales.id, { to: 'person', password: 'short' }).expect(400);
    const converted = await convert(sales.id, { to: 'person', password: PASSWORD }).expect(201);
    expect(converted.body).toMatchObject({ kind: 'person', sharedSeen: false, userId: expect.any(String) });
    expect(converted.body.userId).not.toBe(sales.userId);
    // The members lose it, in open sessions too.
    expect(engine.access.get(sales.address)).toEqual({ access: [], sharedSeen: false });
    expect(await db.select().from(sharedMailboxMembers).where(eq(sharedMailboxMembers.mailboxId, sales.id))).toEqual([]);
    const disconnects = (await db.select().from(sessionDisconnects).orderBy(desc(sessionDisconnects.id)).limit(5)).map((d) => d.username);
    expect(disconnects).toEqual(expect.arrayContaining([ann.address, ben.address]));
    // Someone signs in as it again.
    await mailAuth(sales.address, PASSWORD).expect(204);
    await signIn(app, sales.address);
    const entry = (await audit()).find((e) => e.action === 'mailbox.converted');
    expect(entry?.details).toMatchObject({ from: 'shared', to: 'person', removedMembers: [ann.address, ben.address] });
  });

  it('never takes the account of an instance administrator', async () => {
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, ben.userId));
    await convert(ben.id, { to: 'shared' }).expect(403);
    await db.update(user).set({ role: 'user' }).where(eq(user.id, ben.userId));
  });
});
