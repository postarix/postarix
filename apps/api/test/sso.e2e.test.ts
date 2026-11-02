import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createOrg, newAgent, signUp, startApp, type TestUser } from './helpers.js';
import { FakeOidcProvider } from './fake-oidc-provider.js';

describe('Single sign-on', () => {
  let app: INestApplication;
  const idp = new FakeOidcProvider();
  let alice: TestUser; // owner of A
  let bob: TestUser; // owner of B
  let dave: TestUser; // member of A
  let orgA: string;
  let orgB: string;
  let domainA: { id: string; name: string };
  let domainB: { id: string; name: string };
  let providerA: { id: string; providerId: string; callbackUrl: string };
  const originalTrustedOrigins = process.env.TRUSTED_ORIGINS;

  const verifiedDomain = async (owner: TestUser, orgId: string, prefix: string) => {
    const name = `${prefix}-${Date.now()}.example`;
    const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name }).expect(201);
    await owner.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    return { id: domain.body.id as string, name };
  };
  const mailbox = async (owner: TestUser, orgId: string, domainId: string, localPart: string) =>
    (
      await owner.agent
        .post(`/api/orgs/${orgId}/mailboxes`)
        .send({ domainId, localPart, password: 'a long mailbox password' })
        .expect(201)
    ).body as { id: string; address: string };

  /** Runs the whole browser round trip: start, sign in at the provider, come back. */
  const ssoSignIn = async (email: string, claims: Record<string, unknown>) => {
    const agent = newAgent(app);
    const start = await agent.post('/api/auth/sign-in/sso').send({ email, callbackURL: 'http://localhost:3000/' }).expect(200);
    expect(start.body.url).toMatch(new RegExp(`^${idp.issuer}/authorize\\?`));
    const { code, state } = idp.issueCode(start.body.url, claims);
    const back = await agent.get(`/api/auth/sso/callback/${providerA.providerId}`).query({ code, state });
    const session = await agent.get('/api/auth/get-session');
    return { agent, back, sessionEmail: (session.body?.user?.email as string | undefined) ?? null };
  };

  beforeAll(async () => {
    await idp.start();
    // An identity provider on a private address must be allowed explicitly by the operator.
    process.env.TRUSTED_ORIGINS = idp.issuer;
    app = await startApp();
    alice = await signUp(app, 'sso-alice');
    bob = await signUp(app, 'sso-bob');
    dave = await signUp(app, 'sso-dave');
    orgA = await createOrg(alice, 'SsoA');
    orgB = await createOrg(bob, 'SsoB');
    await addMember(app, orgA, dave.id, 'member');
    domainA = await verifiedDomain(alice, orgA, 'sso-a');
    domainB = await verifiedDomain(bob, orgB, 'sso-b');
  });

  afterAll(async () => {
    process.env.TRUSTED_ORIGINS = originalTrustedOrigins;
    await app.close();
    await idp.stop();
  });

  describe('providers', () => {
    it('are set up by organization admins for a verified domain, without echoing the secret', async () => {
      const res = await alice.agent
        .post(`/api/orgs/${orgA}/sso`)
        .send({ domainId: domainA.id, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret })
        .expect(201);
      expect(res.body).toMatchObject({ domain: domainA.name, issuer: idp.issuer, clientId: idp.clientId });
      expect(res.body.callbackUrl).toBe(`http://localhost:3000/api/auth/sso/callback/${res.body.providerId}`);
      expect(JSON.stringify(res.body)).not.toContain(idp.clientSecret);
      providerA = res.body;

      const list = await alice.agent.get(`/api/orgs/${orgA}/sso`).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(idp.clientSecret);
    });

    it('are invisible to members and to other organizations', async () => {
      await dave.agent.get(`/api/orgs/${orgA}/sso`).expect(403);
      await bob.agent.get(`/api/orgs/${orgA}/sso`).expect(404);
      await bob.agent.delete(`/api/orgs/${orgA}/sso/${providerA.id}`).expect(404);
      await bob.agent.delete(`/api/orgs/${orgB}/sso/${providerA.id}`).expect(404);
      expect((await bob.agent.get(`/api/orgs/${orgB}/sso`).expect(200)).body.data).toEqual([]);
      // Another organization cannot attach a provider to a domain it does not own.
      await bob.agent
        .post(`/api/orgs/${orgB}/sso`)
        .send({ domainId: domainA.id, issuer: idp.issuer, clientId: 'x', clientSecret: 'y' })
        .expect(404);
    });

    it('refuses unverified domains, a second provider per domain and private issuers', async () => {
      const pending = await alice.agent.post(`/api/orgs/${orgA}/domains`).send({ name: `sso-pending-${Date.now()}.example` }).expect(201);
      await alice.agent
        .post(`/api/orgs/${orgA}/sso`)
        .send({ domainId: pending.body.id, issuer: idp.issuer, clientId: 'x', clientSecret: 'y' })
        .expect(422);
      await alice.agent
        .post(`/api/orgs/${orgA}/sso`)
        .send({ domainId: domainA.id, issuer: idp.issuer, clientId: 'x', clientSecret: 'y' })
        .expect(409);
      const internal = await bob.agent
        .post(`/api/orgs/${orgB}/sso`)
        .send({ domainId: domainB.id, issuer: 'http://169.254.169.254', clientId: 'x', clientSecret: 'y' })
        .expect(422);
      expect(internal.body.code).toBe('SSO_ISSUER_NOT_ALLOWED');
    });

    it('cannot be managed through Better Auth’s own endpoints', async () => {
      const body = { providerId: 'evil', issuer: idp.issuer, domain: domainB.name, oidcConfig: { clientId: 'x', clientSecret: 'y' } };
      await bob.agent.post('/api/auth/sso/register').send(body).expect(404);
      await bob.agent.get('/api/auth/sso/providers').expect(404);
      await bob.agent.post('/api/auth/sso/delete-provider').send({ providerId: providerA.providerId }).expect(404);
      await bob.agent.post('/api/auth/sso/update-provider').send({ providerId: providerA.providerId }).expect(404);
    });
  });

  describe('signing in', () => {
    let info: { id: string; address: string };

    beforeAll(async () => {
      info = await mailbox(alice, orgA, domainA.id, 'info');
      await mailbox(bob, orgB, domainB.id, 'boss');
    });

    it('signs in the owner of a mailbox of the organization', async () => {
      const { back, sessionEmail } = await ssoSignIn(info.address, { sub: 'idp-user-1', email: info.address, email_verified: true, name: 'Info' });
      expect(back.status).toBe(302);
      expect(back.headers.location).toBe('http://localhost:3000/');
      expect(sessionEmail).toBe(info.address);
    });

    it('never signs in accounts of another organization, whatever the provider asserts', async () => {
      const { back, sessionEmail } = await ssoSignIn(info.address, { sub: 'idp-user-2', email: `boss@${domainB.name}`, email_verified: true });
      expect(sessionEmail).toBeNull();
      expect(back.headers.location).toContain('error=NO_MAILBOX');
    });

    it('never creates accounts and never signs in instance administrators or organization members without a mailbox', async () => {
      const unknown = await ssoSignIn(info.address, { sub: 'idp-user-3', email: `nobody@${domainA.name}`, email_verified: true });
      expect(unknown.sessionEmail).toBeNull();
      expect(unknown.back.headers.location).toContain('error=NO_MAILBOX');
      // Dave is a member of A but has no mailbox there.
      const member = await ssoSignIn(info.address, { sub: 'idp-user-4', email: dave.email, email_verified: true });
      expect(member.sessionEmail).toBeNull();
      expect(member.back.headers.location).toContain('error=NO_MAILBOX');
    });

    it('stops working once the mailbox is disabled', async () => {
      await alice.agent.patch(`/api/orgs/${orgA}/mailboxes/${info.id}`).send({ status: 'disabled' }).expect(200);
      const { back, sessionEmail } = await ssoSignIn(info.address, { sub: 'idp-user-1', email: info.address, email_verified: true });
      expect(sessionEmail).toBeNull();
      expect(back.headers.location).toContain('error=NO_MAILBOX');
      await alice.agent.patch(`/api/orgs/${orgA}/mailboxes/${info.id}`).send({ status: 'active' }).expect(200);
    });

    it('stops working once the provider is removed', async () => {
      await alice.agent.delete(`/api/orgs/${orgA}/sso/${providerA.id}`).expect(204);
      const agent = newAgent(app);
      const start = await agent.post('/api/auth/sign-in/sso').send({ email: info.address, callbackURL: 'http://localhost:3000/' });
      expect(start.status).toBeGreaterThanOrEqual(400);
      const audit = await alice.agent.get(`/api/orgs/${orgA}/audit`).expect(200);
      const actions = audit.body.data.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['sign_in_provider.added', 'sign_in_provider.removed']));
    });
  });
});
