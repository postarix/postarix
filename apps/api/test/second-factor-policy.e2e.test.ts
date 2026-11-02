import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalSecret } from '../src/config/internal-secrets.js';
import { DATABASE, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { addMember, createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

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
    expect((await ann.get('/api/me/second-factor').expect(200)).body).toEqual({ required: false, enrolled: false });
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
    expect((await ann.get('/api/me/second-factor').expect(200)).body).toEqual({ required: true, enrolled: false });
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
    await member.agent.get(`/api/orgs/${orgId}/overview`).expect(200);
    await owner.agent.get(`/api/orgs/${orgId}/overview`).expect(200);
  });

  it('applies to its own organization only', async () => {
    const other = await mailboxInNewOrg(app, 'mfa-other');
    await other.agent.get('/api/mail/identities').expect(200);
    await other.owner.agent.get(`/api/orgs/${orgId}/security`).expect(404);
    await other.owner.agent.put(`/api/orgs/${orgId}/security`).send({ requireSecondFactor: false }).expect(404);
  });
});
