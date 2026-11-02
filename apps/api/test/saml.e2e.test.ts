import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import * as samlify from 'samlify';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, newAgent, signUp, startApp, type TestUser } from './helpers.js';

const KEY = readFileSync(new URL('./fixtures/saml-idp-key.pem', import.meta.url), 'utf8');
const CERT = readFileSync(new URL('./fixtures/saml-idp-cert.pem', import.meta.url), 'utf8');
const IDP_ENTITY = 'https://idp.example/saml';
const SSO_URL = 'https://idp.example/saml/sso';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

describe('Single sign-on with SAML 2.0', () => {
  let app: INestApplication;
  let owner: TestUser;
  let other: TestUser;
  let orgId: string;
  let otherOrg: string;
  let domain: { id: string; name: string };
  let provider: { id: string; providerId: string; callbackUrl: string; entityId: string; type: string };
  let address: string;
  let foreignAddress: string;

  const idp = (key = KEY, cert = CERT) =>
    samlify.IdentityProvider({
      entityID: IDP_ENTITY,
      privateKey: key,
      signingCert: cert,
      singleSignOnService: [{ Binding: REDIRECT, Location: SSO_URL }],
      nameIDFormat: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
    });
  const sp = () =>
    samlify.ServiceProvider({
      entityID: provider.entityId,
      assertionConsumerService: [{ Binding: POST, Location: provider.callbackUrl }],
      wantAssertionsSigned: true,
    });

  /** Starts a sign-in, has the identity provider assert `email`, and posts its answer back. */
  async function samlSignIn(email: string, options: { identityProvider?: samlify.IdentityProviderInstance; unsolicited?: boolean } = {}) {
    const agent: TestAgent = newAgent(app);
    const start = await agent.post('/api/auth/sign-in/sso').send({ providerId: provider.providerId, callbackURL: 'http://localhost:3000/' }).expect(200);
    const url = new URL(start.body.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(SSO_URL);
    const identityProvider = options.identityProvider ?? idp();
    // The request's ID, which the answer must refer to (InResponseTo).
    const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    const requestId = /\bID="([^"]+)"/.exec(xml)![1]!;
    const requestInfo = { extract: { request: { id: options.unsolicited ? '' : requestId } } };
    const response = (await identityProvider.createLoginResponse(sp(), requestInfo, 'post', { email }, undefined, false, url.searchParams.get('RelayState') ?? undefined)) as {
      context: string;
      relayState?: string;
    };
    const back = await agent
      .post(`/api/auth/sso/saml2/sp/acs/${provider.providerId}`)
      .type('form')
      .send({ SAMLResponse: response.context, ...(response.relayState ? { RelayState: response.relayState } : {}) });
    const session = await agent.get('/api/auth/get-session');
    return { back, email: (session.body?.user?.email as string | undefined) ?? null };
  }

  beforeAll(async () => {
    app = await startApp();
    owner = await signUp(app, 'saml-owner');
    other = await signUp(app, 'saml-other');
    orgId = await createOrg(owner, 'Saml');
    otherOrg = await createOrg(other, 'SamlOther');
    const name = `saml-${Date.now()}.example`;
    const created = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name }).expect(201);
    await owner.agent.post(`/api/orgs/${orgId}/domains/${created.body.id}/verify`).expect(200);
    domain = { id: created.body.id, name };
    address = (
      await owner.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId: domain.id, localPart: 'sara', password: 'a long mailbox password' }).expect(201)
    ).body.address;
    const otherDomain = await other.agent.post(`/api/orgs/${otherOrg}/domains`).send({ name: `saml-other-${Date.now()}.example` }).expect(201);
    await other.agent.post(`/api/orgs/${otherOrg}/domains/${otherDomain.body.id}/verify`).expect(200);
    foreignAddress = (
      await other.agent.post(`/api/orgs/${otherOrg}/mailboxes`).send({ domainId: otherDomain.body.id, localPart: 'boss', password: 'a long mailbox password' }).expect(201)
    ).body.address;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is set up by an organization admin with the identity provider’s details', async () => {
    await owner.agent
      .post(`/api/orgs/${orgId}/sso`)
      .send({ type: 'saml', domainId: domain.id, entityId: IDP_ENTITY, ssoUrl: SSO_URL, certificate: 'not a certificate at all, but long enough to pass the length check'.repeat(2) })
      .expect(422);
    const res = await owner.agent
      .post(`/api/orgs/${orgId}/sso`)
      .send({ type: 'saml', domainId: domain.id, entityId: IDP_ENTITY, ssoUrl: SSO_URL, certificate: CERT })
      .expect(201);
    provider = res.body;
    expect(provider).toMatchObject({ type: 'saml', domain: domain.name, issuer: IDP_ENTITY, clientId: '' });
    expect(provider.callbackUrl).toMatch(new RegExp(`/api/auth/sso/saml2/sp/acs/${provider.providerId}$`));
    expect(provider.entityId).toContain(`/api/auth/sso/saml2/sp/metadata?providerId=${provider.providerId}`);
    expect(res.body.certificateExpiresAt).toMatch(/^2\d{3}-/);
    // Another organization cannot see or use it.
    expect((await other.agent.get(`/api/orgs/${orgId}/sso`)).status).toBe(404);
  });

  it('publishes Postarix’ metadata for the identity provider', async () => {
    const res = await newAgent(app).get('/api/auth/sso/saml2/sp/metadata').query({ providerId: provider.providerId }).expect(200);
    expect(res.text).toContain('EntityDescriptor');
    expect(res.text).toContain(provider.callbackUrl);
  });

  it('signs in the owner of a mailbox of the organization', async () => {
    const { back, email } = await samlSignIn(address);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe('http://localhost:3000/');
    expect(email).toBe(address);
  });

  it('never signs in accounts of another organization', async () => {
    const { email } = await samlSignIn(foreignAddress);
    expect(email).toBeNull();
  });

  it('refuses responses signed by anyone else', async () => {
    const forged = await import('node:crypto').then(({ generateKeyPairSync }) =>
      generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }),
    );
    const { email } = await samlSignIn(address, { identityProvider: idp(forged.privateKey, CERT) });
    expect(email).toBeNull();
  });

  it('refuses responses it did not ask for', async () => {
    const { email } = await samlSignIn(address, { unsolicited: true });
    expect(email).toBeNull();
  });
});
