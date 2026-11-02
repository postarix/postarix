import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

interface Grant {
  claims: Record<string, unknown>;
  nonce: string | undefined;
}

/**
 * A minimal OpenID Connect identity provider for tests. Tests decide who the
 * provider asserts by issuing an authorization code for a set of claims.
 */
export class FakeOidcProvider {
  readonly clientId = 'postarix-test-client';
  readonly clientSecret = 'postarix-test-secret';
  private server!: Server;
  private privateKey!: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  private jwk!: JWK;
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, Record<string, unknown>>();
  issuer = '';

  async start(): Promise<void> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = pair.privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Simulates the user signing in at the provider: returns the code the provider would redirect back with. */
  issueCode(authorizationUrl: string, claims: Record<string, unknown>): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const code = crypto.randomUUID();
    this.grants.set(code, { claims, nonce: url.searchParams.get('nonce') ?? undefined });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [this.jwk] });
    if (url.pathname === '/userinfo') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const claims = this.tokens.get(token);
      return claims ? json(200, claims) : json(401, { error: 'invalid_token' });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = (req.headers.authorization ?? '').replace(/^Basic /, '');
      const [id, secret] = basic
        ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent)
        : [form.get('client_id'), form.get('client_secret')];
      if (id !== this.clientId || secret !== this.clientSecret) return json(401, { error: 'invalid_client' });
      const grant = this.grants.get(form.get('code') ?? '');
      if (!grant) return json(400, { error: 'invalid_grant' });
      this.grants.delete(form.get('code')!);
      const accessToken = crypto.randomUUID();
      this.tokens.set(accessToken, grant.claims);
      const idToken = await new SignJWT({ ...grant.claims, ...(grant.nonce ? { nonce: grant.nonce } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(this.issuer)
        .setAudience(this.clientId)
        .setSubject(String(grant.claims.sub))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.privateKey);
      return json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, { error: 'not_found' });
  }
}
