import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from 'jose';
import { allows } from '../api-keys/api-keys.js';
import { AuditService } from '../audit/audit.service.js';
import { hasInstanceAdminRole } from '../auth/roles.js';
import type { CounterStore } from '../core/counter-store.js';
import type { Env } from '../config/env.js';
import { COUNTER_STORE, DATABASE, ENV, SYSTEM_MAILER } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import {
  type ConnectedAppRow,
  type ConnectedAppScope,
  connectedApps,
  domains,
  mailboxes,
  organizationMailOptions,
  organizationSupervisors,
  supervisionAccess,
  supervisionGrants,
  user,
} from '../db/schema/index.js';
import { resolveExternalIdentity } from '../identities/resolve-identity.js';
import type { SystemMailer } from '../mail/system-mailer.js';
import { JwksCache } from './jwks.js';

/** RFC 8693 / RFC 6749 names. */
export const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const GRANT_CLIENT_CREDENTIALS = 'client_credentials';
export const ASSERTION_JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const TOKEN_TYPE_ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
export const SUBJECT_EXTERNAL = 'urn:postarix:params:oauth:token-type:external-subject';
export const SUBJECT_USER_ID = 'urn:postarix:params:oauth:token-type:user-id';

/** Access tokens live this long (at most). */
export const ACCESS_TOKEN_SECONDS = 300;
/** A supervision grant lasts at most this long. */
export const SUPERVISION_MINUTES = 60;
/** Client assertions (private_key_jwt) may live this long at most. */
const ASSERTION_MAX_SECONDS = 60;
/** Requests per minute an application may make with its tokens (all people), and per person. */
export const APP_REQUESTS_PER_MINUTE = 1200;
export const APP_USER_REQUESTS_PER_MINUTE = 240;
/** Token requests per minute per application. */
const TOKEN_REQUESTS_PER_MINUTE = 600;

const TOKEN_PREFIX = 'pxt_';
const STORE_PREFIX = 'apptoken:';

/** An error in RFC 6749 §5.2 form. */
export class OAuthError extends Error {
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope' | 'access_denied',
    readonly description: string,
    readonly status = error === 'invalid_client' ? 401 : 400,
  ) {
    super(description);
  }
}

/** What an access token stands for. */
export interface AppTokenGrant {
  appId: string;
  organizationId: string;
  /** The person it acts as; null for an application-level token (unread counts only). */
  userId: string | null;
  scopes: ConnectedAppScope[];
  /** Supervision: who reads, under which grant. */
  supervisorId?: string;
  supervisionGrantId?: string;
  expiresAt: number;
}

export interface TokenResponse {
  access_token: string;
  issued_token_type?: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** A new client secret and the hash to keep. */
export function newClientSecret(): { secret: string; hash: string } {
  const secret = `pxs_${randomBytes(32).toString('base64url')}`;
  return { secret, hash: sha256(secret) };
}

export interface ClientCredentials {
  /** From HTTP Basic (RFC 6749 §2.3.1), already split. */
  basic?: { id: string; secret: string } | undefined;
  body: Record<string, string | undefined>;
  ip: string | undefined;
}

/**
 * Connected applications' tokens: authenticates the client (secret or
 * private_key_jwt), exchanges for short-lived opaque tokens that act as one
 * person of the application's organization (RFC 8693), and checks those
 * tokens on every request (the application, the person and any supervision
 * grant are checked again each time, so revocation applies at once).
 */
@Injectable()
export class AppTokensService {
  private readonly logger = new Logger(AppTokensService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(COUNTER_STORE) private readonly counters: CounterStore,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
    @Inject(JwksCache) private readonly jwks: JwksCache,
  ) {}

  /** The token endpoint's own URL: the audience of client assertions. */
  get tokenEndpoint(): string {
    return new URL('/api/oauth/token', this.env.AUTH_URL).href;
  }

  private usable(app: ConnectedAppRow | undefined): app is ConnectedAppRow {
    return Boolean(app && !app.revokedAt && (!app.expiresAt || app.expiresAt.getTime() > Date.now()));
  }

  /** RFC 6749 §2.3 / RFC 7523 §2.2: who is asking. */
  async authenticateClient(credentials: ClientCredentials): Promise<ConnectedAppRow> {
    const { body, basic } = credentials;
    const assertion = body.client_assertion;
    let app: ConnectedAppRow | undefined;
    if (assertion !== undefined || body.client_assertion_type !== undefined) {
      if (body.client_assertion_type !== ASSERTION_JWT_BEARER || !assertion) throw new OAuthError('invalid_client', 'Unsupported client assertion');
      app = await this.verifyAssertion(assertion, body.client_id);
    } else {
      const id = basic?.id ?? body.client_id;
      const secret = basic?.secret ?? body.client_secret;
      if (!id || !secret) throw new OAuthError('invalid_client', 'Client authentication is required');
      [app] = await this.db.select().from(connectedApps).where(eq(connectedApps.clientId, id)).limit(1);
      if (!app?.secretHash || !equalHex(app.secretHash, sha256(secret))) throw new OAuthError('invalid_client', 'Unknown client or wrong secret');
      if (app.requirePrivateKeyJwt) throw new OAuthError('invalid_client', 'This client must authenticate with private_key_jwt');
    }
    if (!this.usable(app)) throw new OAuthError('invalid_client', 'This client is revoked or expired');
    if (!allows(app.allowedIps, credentials.ip)) {
      this.logger.warn(`Connected application "${app.name}" asked from a refused address: ${credentials.ip ?? 'unknown'}`);
      throw new OAuthError('invalid_client', 'Not allowed from this address');
    }
    if (!(await this.counters.tryAdd(`ratelimit:apptoken:${app.id}`, 1, TOKEN_REQUESTS_PER_MINUTE, 60_000))) {
      throw new OAuthError('invalid_request', 'Too many token requests; slow down', 429);
    }
    return app;
  }

  private async verifyAssertion(assertion: string, claimedId: string | undefined): Promise<ConnectedAppRow> {
    let clientId: string | undefined;
    try {
      const [, payload] = assertion.split('.');
      clientId = (JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { iss?: unknown }).iss as string | undefined;
      decodeProtectedHeader(assertion);
    } catch {
      throw new OAuthError('invalid_client', 'Malformed client assertion');
    }
    if (typeof clientId !== 'string' || (claimedId && claimedId !== clientId)) throw new OAuthError('invalid_client', 'Malformed client assertion');
    const [app] = await this.db.select().from(connectedApps).where(eq(connectedApps.clientId, clientId)).limit(1);
    if (!app || (!app.jwks && !app.jwksUri)) throw new OAuthError('invalid_client', 'Unknown client, or it has no keys');
    const keys = app.jwks ? createLocalJWKSet(app.jwks as JSONWebKeySet) : this.jwks.keySet(app.jwksUri!);
    let claims: { jti?: unknown; exp?: unknown; iat?: unknown };
    try {
      ({ payload: claims } = await jwtVerify(assertion, keys, {
        issuer: clientId,
        subject: clientId,
        audience: this.tokenEndpoint,
        algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'],
        requiredClaims: ['exp', 'jti'],
        clockTolerance: 5,
      }));
    } catch (error) {
      throw new OAuthError('invalid_client', `Client assertion refused: ${error instanceof Error ? error.message : 'invalid'}`);
    }
    const exp = Number(claims.exp);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(exp) || exp - now > ASSERTION_MAX_SECONDS) throw new OAuthError('invalid_client', `Client assertions may live ${ASSERTION_MAX_SECONDS} seconds at most`);
    const jti = String(claims.jti);
    if (jti.length > 200) throw new OAuthError('invalid_client', 'Malformed client assertion');
    // Single use while it is valid.
    if ((await this.counters.increment(`appjti:${app.id}:${sha256(jti)}`, Math.max(1, exp - now + 10) * 1000)) > 1) {
      throw new OAuthError('invalid_client', 'This client assertion was already used');
    }
    return app;
  }

  private requestedScopes(app: ConnectedAppRow, scope: string | undefined): ConnectedAppScope[] {
    const wanted = (scope ?? '').split(/\s+/).filter(Boolean);
    if (wanted.length === 0) throw new OAuthError('invalid_scope', 'Ask for at least one scope');
    for (const s of wanted) {
      if (!(app.scopes as string[]).includes(s)) throw new OAuthError('invalid_scope', `This client may not ask for ${s}`);
    }
    return [...new Set(wanted)] as ConnectedAppScope[];
  }

  /** A person of the app's organization named by the app (an external identity of its issuer, or a user id if allowed). */
  private async person(app: ConnectedAppRow, token: string | undefined, type: string | undefined, what: 'subject' | 'actor'): Promise<string> {
    if (!token || !type) throw new OAuthError('invalid_request', `The ${what} is missing`);
    if (token.length > 500) throw new OAuthError('invalid_request', `The ${what} is too long`);
    if (type === SUBJECT_EXTERNAL) {
      const found = await resolveExternalIdentity(this.db, app.organizationId, app.identityIssuer, token);
      if (!found) throw new OAuthError('invalid_grant', `Unknown ${what}, or they cannot use mail now`);
      return found.userId;
    }
    if (type === SUBJECT_USER_ID && app.allowUserIdSubjects) {
      const [row] = await this.db
        .select({ userId: mailboxes.userId, status: mailboxes.status, kind: mailboxes.kind, domainStatus: domains.status, role: user.role, banned: user.banned })
        .from(mailboxes)
        .innerJoin(domains, eq(domains.id, mailboxes.domainId))
        .innerJoin(user, eq(user.id, mailboxes.userId))
        .where(and(eq(mailboxes.organizationId, app.organizationId), eq(mailboxes.userId, token)))
        .limit(1);
      if (!row?.userId || row.kind !== 'person' || row.status !== 'active' || row.domainStatus !== 'active' || row.banned || hasInstanceAdminRole(row.role)) {
        throw new OAuthError('invalid_grant', `Unknown ${what}, or they cannot use mail now`);
      }
      return row.userId;
    }
    throw new OAuthError('invalid_request', `Unsupported ${what}_token_type`);
  }

  /** RFC 8693: a token acting as the subject (or, with mail.supervise, the actor reading the subject's mailbox). */
  async exchange(app: ConnectedAppRow, body: Record<string, string | undefined>, ip: string | undefined): Promise<TokenResponse> {
    if (body.requested_token_type && body.requested_token_type !== TOKEN_TYPE_ACCESS) {
      throw new OAuthError('invalid_request', 'Only access tokens are issued');
    }
    const scopes = this.requestedScopes(app, body.scope);
    const subjectId = await this.person(app, body.subject_token, body.subject_token_type, 'subject');

    if (scopes.includes('mail.supervise')) {
      if (scopes.length > 1) throw new OAuthError('invalid_scope', 'mail.supervise is asked for alone (it is read-only)');
      return this.supervise(app, subjectId, body, ip);
    }
    if (body.actor_token) throw new OAuthError('invalid_request', 'An actor is only for mail.supervise');
    const expiresAt = Date.now() + ACCESS_TOKEN_SECONDS * 1000;
    const token = await this.store({ appId: app.id, organizationId: app.organizationId, userId: subjectId, scopes, expiresAt });
    await this.noteIssued(app, subjectId, scopes, ip);
    return { access_token: token, issued_token_type: TOKEN_TYPE_ACCESS, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, scope: scopes.join(' ') };
  }

  private async supervise(app: ConnectedAppRow, subjectId: string, body: Record<string, string | undefined>, ip: string | undefined): Promise<TokenResponse> {
    const [options] = await this.db.select().from(organizationMailOptions).where(eq(organizationMailOptions.organizationId, app.organizationId));
    if (!options?.supervisionEnabled) throw new OAuthError('access_denied', 'Supervision is turned off in this organization');
    const reason = (body.reason ?? '').trim();
    if (reason.length < 5 || reason.length > 500) throw new OAuthError('invalid_request', 'Supervision needs a reason (5 to 500 characters)');
    const supervisorId = await this.person(app, body.actor_token, body.actor_token_type, 'actor');
    if (supervisorId === subjectId) throw new OAuthError('invalid_grant', 'Supervising yourself is not supervision');
    const [allowed] = await this.db
      .select({ userId: organizationSupervisors.userId })
      .from(organizationSupervisors)
      .where(and(eq(organizationSupervisors.organizationId, app.organizationId), eq(organizationSupervisors.userId, supervisorId)))
      .limit(1);
    if (!allowed) throw new OAuthError('access_denied', 'This person may not supervise mailboxes');

    // A grant lasts an hour at most; tokens follow it.
    const now = new Date();
    let [grant] = await this.db
      .select()
      .from(supervisionGrants)
      .where(
        and(
          eq(supervisionGrants.appId, app.id),
          eq(supervisionGrants.supervisorId, supervisorId),
          eq(supervisionGrants.subjectId, subjectId),
          gt(supervisionGrants.expiresAt, now),
        ),
      )
      .limit(1);
    if (!grant) {
      [grant] = await this.db
        .insert(supervisionGrants)
        .values({
          organizationId: app.organizationId,
          appId: app.id,
          supervisorId,
          subjectId,
          reason,
          expiresAt: new Date(now.getTime() + SUPERVISION_MINUTES * 60_000),
        })
        .returning();
      await this.recordSupervision(app, grant!, ip, options.supervisionNotify);
    }
    const expiresAt = Math.min(Date.now() + ACCESS_TOKEN_SECONDS * 1000, grant!.expiresAt.getTime());
    const token = await this.store({
      appId: app.id,
      organizationId: app.organizationId,
      userId: subjectId,
      scopes: ['mail.supervise'],
      supervisorId,
      supervisionGrantId: grant!.id,
      expiresAt,
    });
    const seconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    return { access_token: token, issued_token_type: TOKEN_TYPE_ACCESS, token_type: 'Bearer', expires_in: seconds, scope: 'mail.supervise' };
  }

  private async recordSupervision(app: ConnectedAppRow, grant: typeof supervisionGrants.$inferSelect, ip: string | undefined, notify: boolean): Promise<void> {
    const people = await this.db
      .select({ id: user.id, email: user.email, address: mailboxes.address, mailboxId: mailboxes.id })
      .from(user)
      .innerJoin(mailboxes, and(eq(mailboxes.userId, user.id), eq(mailboxes.organizationId, app.organizationId)))
      .where(eq(user.id, grant.subjectId));
    const [subject] = people;
    const [supervisor] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, grant.supervisorId));
    const actor = {
      organizationId: app.organizationId,
      userId: grant.supervisorId,
      userEmail: supervisor?.email ?? grant.supervisorId,
      ipAddress: ip ?? null,
      role: 'member' as const,
      viaSuperAdmin: false,
      instanceAdmin: false,
    };
    const details = { app: app.name, appId: app.id, reason: grant.reason, until: grant.expiresAt.toISOString(), grantId: grant.id };
    const target = { type: 'mailbox', id: subject?.mailboxId ?? grant.subjectId, label: subject?.address ?? grant.subjectId };
    await this.audit.record(actor, 'mailbox.supervision_started', target, details);
    await this.audit.recordInstance(actor, 'mailbox.supervision_started', target, { ...details, organizationId: app.organizationId });
    if (notify && subject?.address) {
      await this.mailer.send({
        to: subject.address,
        subject: 'Your mailbox was opened for review',
        text: [
          `${supervisor?.email ?? 'An administrator'} opened your mailbox ${subject.address} for review through ${app.name}, until ${grant.expiresAt.toUTCString()}.`,
          '',
          `Reason given: ${grant.reason}`,
          '',
          'Nothing was changed or sent. Ask your organization if you have questions.',
        ].join('\n'),
      });
    }
  }

  /** An application-level token, for unread counts only. */
  async clientCredentials(app: ConnectedAppRow, body: Record<string, string | undefined>): Promise<TokenResponse> {
    const scopes = this.requestedScopes(app, body.scope ?? 'mail.read');
    if (scopes.length !== 1 || scopes[0] !== 'mail.read') throw new OAuthError('invalid_scope', 'Application tokens are for mail.read (unread counts) only');
    const expiresAt = Date.now() + ACCESS_TOKEN_SECONDS * 1000;
    const token = await this.store({ appId: app.id, organizationId: app.organizationId, userId: null, scopes, expiresAt });
    return { access_token: token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, scope: 'mail.read' };
  }

  private async store(grant: AppTokenGrant): Promise<string> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    await this.counters.setValue(`${STORE_PREFIX}${sha256(token)}`, JSON.stringify(grant), Math.max(1000, grant.expiresAt - Date.now()));
    void this.db.update(connectedApps).set({ lastUsedAt: new Date() }).where(eq(connectedApps.id, grant.appId)).catch(() => undefined);
    return token;
  }

  /** One audit record per application and person per hour, not one per token. */
  private async noteIssued(app: ConnectedAppRow, userId: string, scopes: string[], ip: string | undefined): Promise<void> {
    if ((await this.counters.increment(`appissued:${app.id}:${userId}`, 60 * 60_000)) > 1) return;
    const [person] = await this.db
      .select({ address: mailboxes.address, mailboxId: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.organizationId, app.organizationId)))
      .limit(1);
    await this.audit.record(
      { organizationId: app.organizationId, userId, userEmail: person?.address ?? userId, ipAddress: ip ?? null, role: 'member', viaSuperAdmin: false, instanceAdmin: false },
      'app.token_issued',
      { type: 'mailbox', id: person?.mailboxId ?? userId, label: person?.address ?? userId },
      { app: app.name, appId: app.id, scopes },
    );
  }

  /**
   * What a bearer token stands for now, or null: unknown or expired token,
   * application revoked or expired or asking from a refused address, person
   * who can no longer use mail, supervision grant over. Also counts the
   * application's requests against its limits (`limited` when over).
   */
  async authenticate(token: string, ip: string | undefined): Promise<AppTokenGrant | 'limited' | null> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
    const raw = await this.counters.getValue(`${STORE_PREFIX}${sha256(token)}`);
    if (!raw) return null;
    const grant = JSON.parse(raw) as AppTokenGrant;
    if (grant.expiresAt <= Date.now()) return null;
    const [app] = await this.db.select().from(connectedApps).where(eq(connectedApps.id, grant.appId)).limit(1);
    if (!this.usable(app) || !allows(app.allowedIps, ip)) return null;
    // Scopes taken away since the token was issued no longer work.
    if (grant.scopes.some((s) => !(app.scopes as string[]).includes(s))) return null;
    if (grant.supervisionGrantId) {
      const [live] = await this.db
        .select({ id: supervisionGrants.id })
        .from(supervisionGrants)
        .innerJoin(organizationSupervisors, and(eq(organizationSupervisors.organizationId, supervisionGrants.organizationId), eq(organizationSupervisors.userId, supervisionGrants.supervisorId)))
        .innerJoin(organizationMailOptions, eq(organizationMailOptions.organizationId, supervisionGrants.organizationId))
        .where(and(eq(supervisionGrants.id, grant.supervisionGrantId), gt(supervisionGrants.expiresAt, new Date()), eq(organizationMailOptions.supervisionEnabled, true)))
        .limit(1);
      if (!live) return null;
    }
    if (!(await this.counters.tryAdd(`ratelimit:appreq:${app.id}`, 1, APP_REQUESTS_PER_MINUTE, 60_000))) return 'limited';
    if (grant.userId && !(await this.counters.tryAdd(`ratelimit:appreq:${app.id}:${grant.userId}`, 1, APP_USER_REQUESTS_PER_MINUTE, 60_000))) return 'limited';
    return grant;
  }

  /** Logs a request made under supervision (which methods or route, never content). */
  async logSupervision(grant: AppTokenGrant, request: string): Promise<void> {
    if (!grant.supervisionGrantId) return;
    await this.db.insert(supervisionAccess).values({ grantId: grant.supervisionGrantId, request: request.slice(0, 1000) });
  }
}
