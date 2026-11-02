import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalSecret } from '../src/config/internal-secrets.js';
import { DATABASE, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { addMember, createOrg, mailboxInNewOrg, newAgent, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

/** RFC 6238 code for a base32 secret. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const TOKEN = internalSecret('internal-test-token-that-is-long-enough', 'mail-auth');

describe('Organizations requiring a second factor', () => {
  let app: INestApplication;
  let db: Database;
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let ann: TestAgent;
  let annAddress: string;
  let annId: string;

  const mailAuth = (username: string, password: string) =>
    request(app.getHttpServer())
      .post('/api/internal/mail-auth')
      .type('form')
      .set('x-postarix-internal-token', TOKEN)
      .send({ username, password, service: 'imap' });
  const enroll = (userId: string) => db.execute(sql`UPDATE "user" SET two_factor_enabled = true WHERE id = ${userId}`);

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    app.get<MemoryMailEngine>(MAIL_ENGINE).jmapHandler = async () => Response.json({ primaryAccounts: {} });
    owner = await signUp(app, 'mfa-owner');
    member = await signUp(app, 'mfa-member');
    orgId = await createOrg(owner, 'Strict');
    await addMember(app, orgId, member.id, 'member');
    const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `mfa-${Date.now()}.example` });
    await owner.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    const mailbox = await owner.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId: domain.body.id, localPart: 'ann', password: PASSWORD }).expect(201);
    annAddress = mailbox.body.address;
    ann = await signIn(app, annAddress);
    annId = (await ann.get('/api/auth/get-session').expect(200)).body.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is off by default', async () => {
    expect((await owner.agent.get(`/api/orgs/${orgId}/security`).expect(200)).body).toEqual({ requireSecondFactor: false });
    expect((await ann.get('/api/me/second-factor').expect(200)).body).toEqual({ required: false, enrolled: false, strongSession: false });
    await mailAuth(annAddress, PASSWORD).expect(204);
  });

  it('can only be turned on by admins who use a second factor themselves', async () => {
    await member.agent.put(`/api/orgs/${orgId}/security`).send({ requireSecondFactor: true }).expect(403);
    const refused = await owner.agent.put(`/api/orgs/${orgId}/security`).send({ requireSecondFactor: true }).expect(422);
    expect(refused.body.code).toBe('SECOND_FACTOR_NOT_SET_UP');
    await enroll(owner.id);
    await owner.agent.put(`/api/orgs/${orgId}/security`).send({ requireSecondFactor: true }).expect(200);
    const audit = await owner.agent.get(`/api/orgs/${orgId}/audit`).expect(200);
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain('organization.second_factor_required');
  });

  it('blocks people without one, except what they need to set it up', async () => {
    expect((await ann.get('/api/me/second-factor').expect(200)).body).toEqual({ required: true, enrolled: false, strongSession: false });
    const blocked = await ann.get('/api/mail/identities').expect(403);
    expect(blocked.body.code).toBe('SECOND_FACTOR_REQUIRED');
    expect((await ann.get('/api/jmap/').expect(403)).body.code).toBe('SECOND_FACTOR_REQUIRED');
    await ann.post('/api/me/app-passwords').send({ name: 'Phone', scopes: ['imap'] }).expect(403);
    await member.agent.get(`/api/orgs/${orgId}/overview`).expect(403);
    // Still reachable: the session, their organizations, Better Auth's security settings.
    await ann.get('/api/auth/get-session').expect(200);
    await ann.get('/api/me/organizations').expect(200);
    // Mail apps: no account password under the rule.
    await mailAuth(annAddress, PASSWORD).expect(401);
  });

  it('lets them in once they have an authenticator app or a passkey', async () => {
    await enroll(annId);
    await ann.get('/api/mail/identities').expect(200);
    await db.execute(sql`
      INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up, created_at)
      VALUES (${crypto.randomUUID()}, 'key', ${member.id}, ${crypto.randomUUID()}, 0, 'singleDevice', false, now())
    `);
    // A passkey does not help a session opened with the password only…
    await member.agent.get(`/api/orgs/${orgId}/overview`).expect(403);
    expect((await member.agent.get('/api/me/second-factor').expect(200)).body).toEqual({ required: true, enrolled: true, strongSession: false });
    // …but a session opened with it does.
    const sessionId = (await member.agent.get('/api/auth/get-session').expect(200)).body.session.id as string;
    await db.execute(sql`INSERT INTO session_factors (session_id, method) VALUES (${sessionId}, 'passkey')`);
    await member.agent.get(`/api/orgs/${orgId}/overview`).expect(200);
    await owner.agent.get(`/api/orgs/${orgId}/overview`).expect(200);
  });

  it('keeps the account password out of mail apps once a passkey is set up', async () => {
    const other = await mailboxInNewOrg(app, 'mfa-passkey');
    await mailAuth(other.address, PASSWORD).expect(204);
    const userId = (await other.agent.get('/api/auth/get-session').expect(200)).body.user.id as string;
    await db.execute(sql`
      INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up, created_at)
      VALUES (${crypto.randomUUID()}, 'key', ${userId}, ${crypto.randomUUID()}, 0, 'singleDevice', false, now())
    `);
    await mailAuth(other.address, PASSWORD).expect(401);
  });

  it('applies to its own organization only', async () => {
    const other = await mailboxInNewOrg(app, 'mfa-other');
    await other.agent.get('/api/mail/identities').expect(200);
    await other.owner.agent.get(`/api/orgs/${orgId}/security`).expect(404);
    await other.owner.agent.put(`/api/orgs/${orgId}/security`).send({ requireSecondFactor: false }).expect(404);
  });

  it('counts sessions opened with an authenticator code as strong', async () => {
    const person = await mailboxInNewOrg(app, 'mfa-totp');
    const enabled = await person.agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const secret = new URL(enabled.body.totpURI as string).searchParams.get('secret')!;
    await person.agent.post('/api/auth/two-factor/verify-totp').send({ code: totp(secret) }).expect(200);

    // A new sign-in: password, then the code.
    const agent = newAgent(app);
    const first = await agent.post('/api/auth/sign-in/email').send({ email: person.address, password: PASSWORD }).expect(200);
    expect(first.body.twoFactorRedirect).toBe(true);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: totp(secret) }).expect(200);
    const sessionId = (await agent.get('/api/auth/get-session').expect(200)).body.session.id as string;
    const result = await db.execute<{ method: string }>(sql`SELECT method FROM session_factors WHERE session_id = ${sessionId}`);
    expect(result.rows).toEqual([{ method: 'two_factor' }]);
  });

  it('limits failed sign-ins per account, whatever the address they come from', async () => {
    const person = await mailboxInNewOrg(app, 'mfa-guess');
    for (let i = 0; i < 10; i++) {
      await newAgent(app).post('/api/auth/sign-in/email').send({ email: person.address, password: `wrong password ${i}` }).expect(401);
    }
    const blocked = await newAgent(app).post('/api/auth/sign-in/email').send({ email: person.address, password: PASSWORD });
    expect(blocked.status).toBe(429);
  });
});
