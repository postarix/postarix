import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { networkSchema } from '../api-keys/api-keys.js';
import { AuditService } from '../audit/audit.service.js';
import { Public } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import {
  type ConnectedAppRow,
  connectedAppScopes,
  connectedApps,
  mailboxes,
  organizationMailOptions,
  organizationSupervisors,
  supervisionAccess,
  supervisionGrants,
  user,
} from '../db/schema/index.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';
import {
  AppTokensService,
  GRANT_CLIENT_CREDENTIALS,
  GRANT_TOKEN_EXCHANGE,
  newClientSecret,
  OAuthError,
} from './app-tokens.js';
import { JwksCache } from './jwks.js';
import { UnreadController, UnreadService } from './unread.js';

const jwkSchema = z.record(z.string(), z.unknown());
const appFields = {
  name: z.string().trim().min(1).max(100),
  /** The issuer of the external identities it names people by. */
  identityIssuer: z.string().trim().min(1).max(500),
  scopes: z.array(z.enum(connectedAppScopes)).min(1).max(connectedAppScopes.length).transform((list) => [...new Set(list)]),
  allowedIps: z.array(networkSchema).max(50).default([]),
  /** When it stops working; null: never. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  jwksUri: z.string().trim().max(2000).nullable().default(null),
  jwks: z.object({ keys: z.array(jwkSchema).min(1).max(20) }).nullable().default(null),
  requirePrivateKeyJwt: z.boolean().default(false),
  allowUserIdSubjects: z.boolean().default(false),
};
export const createAppSchema = z.strictObject(appFields);
export const updateAppSchema = z
  .strictObject({
    name: appFields.name.optional(),
    identityIssuer: appFields.identityIssuer.optional(),
    scopes: appFields.scopes.optional(),
    allowedIps: z.array(networkSchema).max(50).optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    jwksUri: z.string().trim().max(2000).nullable().optional(),
    jwks: z.object({ keys: z.array(jwkSchema).min(1).max(20) }).nullable().optional(),
    requirePrivateKeyJwt: z.boolean().optional(),
    allowUserIdSubjects: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface ConnectedAppDto {
  id: string;
  name: string;
  clientId: string;
  identityIssuer: string;
  scopes: string[];
  allowedIps: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  jwksUri: string | null;
  hasJwks: boolean;
  hasSecret: boolean;
  requirePrivateKeyJwt: boolean;
  allowUserIdSubjects: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

function toDto(row: ConnectedAppRow): ConnectedAppDto {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    identityIssuer: row.identityIssuer,
    scopes: row.scopes,
    allowedIps: row.allowedIps,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    jwksUri: row.jwksUri,
    hasJwks: Boolean(row.jwks),
    hasSecret: Boolean(row.secretHash),
    requirePrivateKeyJwt: row.requirePrivateKeyJwt,
    allowUserIdSubjects: row.allowUserIdSubjects,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** An organization's connected applications, its supervision rule and who may supervise. */
@Injectable()
export class ConnectedAppsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JwksCache) private readonly jwks: JwksCache,
  ) {}

  private async require(ctx: TenantContext, id: string): Promise<ConnectedAppRow> {
    const [row] = await this.db
      .select()
      .from(connectedApps)
      .where(and(eq(connectedApps.organizationId, ctx.organizationId), eq(connectedApps.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Application not found');
    return row;
  }

  private checkKeys(values: { jwksUri?: string | null | undefined; requirePrivateKeyJwt?: boolean | undefined; jwks?: unknown }, current?: ConnectedAppRow): void {
    const jwksUri = values.jwksUri !== undefined ? values.jwksUri : (current?.jwksUri ?? null);
    const jwks = values.jwks !== undefined ? values.jwks : (current?.jwks ?? null);
    const strict = values.requirePrivateKeyJwt ?? current?.requirePrivateKeyJwt ?? false;
    if (jwksUri && !this.jwks.allowsUrl(jwksUri)) {
      throw new UnprocessableEntityException('The JWKS URL must be https on a public address');
    }
    if (jwksUri && jwks) throw new UnprocessableEntityException('Give a JWKS URL or the keys, not both');
    if (strict && !jwksUri && !jwks) throw new UnprocessableEntityException('private_key_jwt needs its public keys (a JWKS URL or the keys)');
  }

  async list(ctx: TenantContext): Promise<ConnectedAppDto[]> {
    const rows = await this.db.select().from(connectedApps).where(eq(connectedApps.organizationId, ctx.organizationId)).orderBy(asc(connectedApps.name));
    return rows.map(toDto);
  }

  /** Registers an application; the secret (when it uses one) is shown here only. */
  async create(ctx: TenantContext, input: z.infer<typeof createAppSchema>): Promise<ConnectedAppDto & { clientSecret: string | null }> {
    this.checkKeys(input);
    const secret = input.requirePrivateKeyJwt ? null : newClientSecret();
    const [row] = await this.db
      .insert(connectedApps)
      .values({
        organizationId: ctx.organizationId,
        name: input.name,
        clientId: `pxapp_${randomBytes(12).toString('hex')}`,
        secretHash: secret?.hash ?? null,
        jwksUri: input.jwksUri,
        jwks: input.jwks as ConnectedAppRow['jwks'],
        requirePrivateKeyJwt: input.requirePrivateKeyJwt,
        identityIssuer: input.identityIssuer,
        allowUserIdSubjects: input.allowUserIdSubjects,
        scopes: input.scopes,
        allowedIps: input.allowedIps,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: ctx.userId,
      })
      .returning();
    await this.audit.record(ctx, 'app.created', { type: 'app', id: row!.id, label: row!.name }, { scopes: input.scopes, identityIssuer: input.identityIssuer });
    return { ...toDto(row!), clientSecret: secret?.secret ?? null };
  }

  async update(ctx: TenantContext, id: string, input: z.infer<typeof updateAppSchema>): Promise<ConnectedAppDto> {
    const current = await this.require(ctx, id);
    this.checkKeys(input, current);
    const changes: Partial<typeof connectedApps.$inferInsert> = {};
    for (const key of ['name', 'identityIssuer', 'scopes', 'allowedIps', 'jwksUri', 'requirePrivateKeyJwt', 'allowUserIdSubjects'] as const) {
      if (input[key] !== undefined) (changes as Record<string, unknown>)[key] = input[key];
    }
    if (input.jwks !== undefined) changes.jwks = input.jwks as ConnectedAppRow['jwks'];
    if (input.expiresAt !== undefined) changes.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    // Requiring private_key_jwt drops the secret.
    if (input.requirePrivateKeyJwt) changes.secretHash = null;
    const [row] = await this.db.update(connectedApps).set(changes).where(and(eq(connectedApps.organizationId, ctx.organizationId), eq(connectedApps.id, id))).returning();
    await this.audit.record(ctx, 'app.updated', { type: 'app', id, label: row!.name }, { ...input, jwks: input.jwks ? 'changed' : input.jwks });
    return toDto(row!);
  }

  async rotateSecret(ctx: TenantContext, id: string): Promise<{ clientSecret: string }> {
    const current = await this.require(ctx, id);
    if (current.requirePrivateKeyJwt) throw new UnprocessableEntityException('This application authenticates with private_key_jwt only');
    const secret = newClientSecret();
    await this.db.update(connectedApps).set({ secretHash: secret.hash }).where(eq(connectedApps.id, id));
    await this.audit.record(ctx, 'app.secret_rotated', { type: 'app', id, label: current.name });
    return { clientSecret: secret.secret };
  }

  /** Stops it at once: its tokens are checked against it on every request. */
  async revoke(ctx: TenantContext, id: string): Promise<ConnectedAppDto> {
    const current = await this.require(ctx, id);
    const [row] = await this.db.update(connectedApps).set({ revokedAt: current.revokedAt ?? new Date(), secretHash: null }).where(eq(connectedApps.id, id)).returning();
    await this.audit.record(ctx, 'app.revoked', { type: 'app', id, label: current.name });
    return toDto(row!);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const current = await this.require(ctx, id);
    await this.db.delete(connectedApps).where(eq(connectedApps.id, id));
    await this.audit.record(ctx, 'app.deleted', { type: 'app', id, label: current.name });
  }

  async supervision(ctx: TenantContext) {
    const [options] = await this.db.select().from(organizationMailOptions).where(eq(organizationMailOptions.organizationId, ctx.organizationId));
    const supervisors = await this.db
      .select({ userId: organizationSupervisors.userId, address: mailboxes.address, displayName: mailboxes.displayName, createdAt: organizationSupervisors.createdAt })
      .from(organizationSupervisors)
      .innerJoin(mailboxes, and(eq(mailboxes.userId, organizationSupervisors.userId), eq(mailboxes.organizationId, ctx.organizationId), eq(mailboxes.kind, 'person')))
      .where(eq(organizationSupervisors.organizationId, ctx.organizationId))
      .orderBy(asc(mailboxes.address));
    const recent = await this.db
      .select({
        id: supervisionGrants.id,
        supervisorId: supervisionGrants.supervisorId,
        subjectId: supervisionGrants.subjectId,
        reason: supervisionGrants.reason,
        expiresAt: supervisionGrants.expiresAt,
        createdAt: supervisionGrants.createdAt,
        app: connectedApps.name,
      })
      .from(supervisionGrants)
      .innerJoin(connectedApps, eq(connectedApps.id, supervisionGrants.appId))
      .where(eq(supervisionGrants.organizationId, ctx.organizationId))
      .orderBy(desc(supervisionGrants.createdAt))
      .limit(50);
    return {
      enabled: options?.supervisionEnabled ?? false,
      notify: options?.supervisionNotify ?? false,
      supervisors: supervisors.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
      recent: recent.map((g) => ({ ...g, expiresAt: g.expiresAt.toISOString(), createdAt: g.createdAt.toISOString() })),
    };
  }

  async setSupervision(ctx: TenantContext, input: { enabled: boolean; notify: boolean }) {
    await this.db
      .insert(organizationMailOptions)
      .values({ organizationId: ctx.organizationId, supervisionEnabled: input.enabled, supervisionNotify: input.notify })
      .onConflictDoUpdate({ target: organizationMailOptions.organizationId, set: { supervisionEnabled: input.enabled, supervisionNotify: input.notify } });
    await this.audit.record(ctx, 'organization.supervision_changed', { type: 'organization', id: ctx.organizationId, label: ctx.organizationId }, input);
    return this.supervision(ctx);
  }

  /** Gives a person of the organization the "may supervise" right (nothing else of the admin panel). */
  async addSupervisor(ctx: TenantContext, userId: string) {
    const [person] = await this.db
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, ctx.organizationId), eq(mailboxes.userId, userId), eq(mailboxes.kind, 'person')))
      .limit(1);
    if (!person) throw new NotFoundException('There is no person with a mailbox here with that id');
    await this.db.insert(organizationSupervisors).values({ organizationId: ctx.organizationId, userId, grantedBy: ctx.userId }).onConflictDoNothing();
    await this.audit.record(ctx, 'organization.supervisor_added', { type: 'mailbox', id: userId, label: person.address });
    return this.supervision(ctx);
  }

  async removeSupervisor(ctx: TenantContext, userId: string): Promise<void> {
    const [removed] = await this.db
      .delete(organizationSupervisors)
      .where(and(eq(organizationSupervisors.organizationId, ctx.organizationId), eq(organizationSupervisors.userId, userId)))
      .returning();
    if (!removed) throw new NotFoundException('Not a supervisor');
    const [person] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    await this.audit.record(ctx, 'organization.supervisor_removed', { type: 'mailbox', id: userId, label: person?.email ?? userId });
  }

  /** The requests made under one supervision grant (which methods, when). */
  async supervisionLog(ctx: TenantContext, grantId: string) {
    const [grant] = await this.db
      .select({ id: supervisionGrants.id })
      .from(supervisionGrants)
      .where(and(eq(supervisionGrants.organizationId, ctx.organizationId), eq(supervisionGrants.id, grantId)));
    if (!grant) throw new NotFoundException('Not found');
    const rows = await this.db.select().from(supervisionAccess).where(eq(supervisionAccess.grantId, grantId)).orderBy(asc(supervisionAccess.id)).limit(1000);
    return rows.map((r) => ({ request: r.request, at: r.createdAt.toISOString() }));
  }
}

const idPipe = new ZodValidationPipe(z.uuid());
const userIdPipe = new ZodValidationPipe(z.string().min(1).max(100));

/** Connected applications: owners register and change them (administrators may look). */
@Controller('orgs/:orgId/apps')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class ConnectedAppsController {
  constructor(@Inject(ConnectedAppsService) private readonly apps: ConnectedAppsService) {}

  @Get()
  async list(@Tenant() ctx: TenantContext) {
    return { data: await this.apps.list(ctx) };
  }

  @Post()
  @RequireOrgRole('owner')
  create(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(createAppSchema)) body: z.infer<typeof createAppSchema>) {
    return this.apps.create(ctx, body);
  }

  @Patch(':id')
  @RequireOrgRole('owner')
  update(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(updateAppSchema)) body: z.infer<typeof updateAppSchema>) {
    return this.apps.update(ctx, id, body);
  }

  @Post(':id/secret')
  @RequireOrgRole('owner')
  @HttpCode(200)
  rotate(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string) {
    return this.apps.rotateSecret(ctx, id);
  }

  @Post(':id/revoke')
  @RequireOrgRole('owner')
  @HttpCode(200)
  revoke(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string) {
    return this.apps.revoke(ctx, id);
  }

  @Delete(':id')
  @RequireOrgRole('owner')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    await this.apps.remove(ctx, id);
  }
}

const supervisionBody = z.strictObject({ enabled: z.boolean(), notify: z.boolean() });

/** Supervision through connected applications: off by default; who may supervise. */
@Controller('orgs/:orgId/supervision')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class SupervisionController {
  constructor(@Inject(ConnectedAppsService) private readonly apps: ConnectedAppsService) {}

  @Get()
  get(@Tenant() ctx: TenantContext) {
    return this.apps.supervision(ctx);
  }

  @Put()
  @RequireOrgRole('owner')
  set(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(supervisionBody)) body: z.infer<typeof supervisionBody>) {
    return this.apps.setSupervision(ctx, body);
  }

  @Put('supervisors/:userId')
  @RequireOrgRole('owner')
  add(@Tenant() ctx: TenantContext, @Param('userId', userIdPipe) userId: string) {
    return this.apps.addSupervisor(ctx, userId);
  }

  @Delete('supervisors/:userId')
  @RequireOrgRole('owner')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('userId', userIdPipe) userId: string): Promise<void> {
    await this.apps.removeSupervisor(ctx, userId);
  }

  @Get('grants/:grantId/requests')
  async log(@Tenant() ctx: TenantContext, @Param('grantId', idPipe) grantId: string) {
    return { data: await this.apps.supervisionLog(ctx, grantId) };
  }
}

/** Splits "Basic base64(id:secret)" (RFC 6749 §2.3.1: both form-urlencoded). */
function basicCredentials(header: string | undefined): { id: string; secret: string } | undefined {
  if (!header || !/^Basic\s+/i.test(header)) return undefined;
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  try {
    return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')) };
  } catch {
    return undefined;
  }
}

/**
 * The token endpoint for connected applications (a public contract):
 * OAuth 2.0 Token Exchange (RFC 8693) and client credentials, with client
 * authentication by secret or private_key_jwt (RFC 7523).
 */
@Controller('oauth')
@Public()
export class OAuthTokenController {
  constructor(@Inject(AppTokensService) private readonly tokens: AppTokensService) {}

  @Post('token')
  @HttpCode(200)
  async token(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    const body = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    try {
      if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers['content-type'] ?? ''))) {
        throw new OAuthError('invalid_request', 'Send the request as application/x-www-form-urlencoded');
      }
      const app = await this.tokens.authenticateClient({ basic: basicCredentials(req.headers.authorization), body, ip: req.ip });
      if (body.grant_type === GRANT_TOKEN_EXCHANGE) return await this.tokens.exchange(app, body, req.ip);
      if (body.grant_type === GRANT_CLIENT_CREDENTIALS) return await this.tokens.clientCredentials(app, body);
      throw new OAuthError('unsupported_grant_type', 'Use token exchange or client credentials');
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      res.status(error.status);
      if (error.status === 401) res.setHeader('www-authenticate', 'Basic realm="postarix"');
      return { error: error.error, error_description: error.description };
    }
  }
}

@Global()
@Module({
  controllers: [ConnectedAppsController, SupervisionController, OAuthTokenController, UnreadController],
  providers: [ConnectedAppsService, AppTokensService, JwksCache, UnreadService, OrgAccessGuard],
  exports: [AppTokensService],
})
export class ConnectedAppsModule {}
