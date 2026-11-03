import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { and, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { hasInstanceAdminRole } from '../auth/roles.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { apiKeys, type ApiKeyRow, organization, user } from '../db/schema/index.js';

export const API_KEY_PREFIX = 'px_';
const LOOKUP_LENGTH = 12;

/** An address or network: "203.0.113.7", "203.0.113.0/24", "2001:db8::/32". */
const networkSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => {
    const [address, bits] = value.split('/');
    const version = isIP(address ?? '');
    if (!version) return false;
    if (bits === undefined) return true;
    const n = Number(bits);
    return Number.isInteger(n) && n >= 0 && n <= (version === 4 ? 32 : 128);
  }, 'Use an IP address or a network such as 203.0.113.0/24');

export const createApiKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  access: z.enum(['read', 'write']),
  allowedIps: z.array(networkSchema).max(50).default([]),
  /** Days until it stops working; omitted: never. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /** Only these organizations (empty: the whole instance). */
  organizationIds: z.array(z.string().min(1).max(100)).max(100).default([]),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export interface ApiKeyDto {
  id: string;
  name: string;
  access: ApiKeyRow['access'];
  allowedIps: string[];
  /** Empty: the whole instance. */
  organizations: { id: string; name: string | null }[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const toDto = (row: ApiKeyRow, names: Map<string, string> = new Map()): ApiKeyDto => ({
  id: row.id,
  name: row.name,
  access: row.access,
  allowedIps: row.allowedIps,
  organizations: row.organizationIds.map((id) => ({ id, name: names.get(id) ?? null })),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

function allows(networks: string[], ip: string | undefined): boolean {
  if (networks.length === 0) return true;
  if (!ip) return false;
  const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  const list = new BlockList();
  for (const network of networks) {
    const [base, bits] = network.split('/');
    const baseFamily = isIP(base!) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(base!, baseFamily);
    else list.addSubnet(base!, Number(bits), baseFamily);
  }
  return list.check(address, family);
}

/**
 * API keys: software (provisioning scripts, monitoring) calls the same API as
 * the admin panel with "Authorization: Bearer px_…", acting as the instance
 * administrator who created the key. Read-only keys may only read (GET).
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async orgNames(): Promise<Map<string, string>> {
    return new Map((await this.db.select({ id: organization.id, name: organization.name }).from(organization)).map((o) => [o.id, o.name]));
  }

  async list(): Promise<ApiKeyDto[]> {
    const names = await this.orgNames();
    return (await this.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt))).map((row) => toDto(row, names));
  }

  async create(session: AuthSession, ipAddress: string | null, input: CreateApiKeyInput): Promise<ApiKeyDto & { key: string }> {
    const organizationIds = [...new Set(input.organizationIds)];
    const names = await this.orgNames();
    if (organizationIds.some((id) => !names.has(id))) throw new UnprocessableEntityException('Unknown organization');
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        name: input.name,
        lookupPrefix: key.slice(0, LOOKUP_LENGTH),
        keyHash: hash(key),
        access: input.access,
        allowedIps: input.allowedIps,
        organizationIds,
        createdBy: session.user.id,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning();
    await this.audit.recordInstance(
      { userId: session.user.id, userEmail: session.user.email, ipAddress },
      'api_key.created',
      {
        type: 'api_key',
        id: row!.id,
        label: input.name,
      },
      { access: input.access, allowedIps: input.allowedIps, organizationIds },
    );
    return { ...toDto(row!, names), key };
  }

  async remove(session: AuthSession, ipAddress: string | null, id: string): Promise<void> {
    const deleted = await this.db.delete(apiKeys).where(eq(apiKeys.id, id)).returning();
    if (deleted.length === 0) throw new NotFoundException('API key not found');
    await this.audit.recordInstance({ userId: session.user.id, userEmail: session.user.email, ipAddress }, 'api_key.deleted', {
      type: 'api_key',
      id,
      label: deleted[0]!.name,
    });
  }

  /**
   * The session an API key stands for, or null if the key is unknown, expired,
   * used from an address it does not allow, read-only for a change, or its
   * creator is no longer an instance administrator. A key limited to some
   * organizations is refused anywhere but under /api/orgs/<one of them>/.
   */
  async authenticate(key: string, ip: string | undefined, method: string, path = ''): Promise<AuthSession | null> {
    if (!key.startsWith(API_KEY_PREFIX) || key.length < 20 || key.length > 200) return null;
    const candidates = await this.db
      .select({ key: apiKeys, owner: user })
      .from(apiKeys)
      .innerJoin(user, eq(user.id, apiKeys.createdBy))
      .where(eq(apiKeys.lookupPrefix, key.slice(0, LOOKUP_LENGTH)));
    const wanted = Buffer.from(hash(key));
    const match = candidates.find((c) => {
      const stored = Buffer.from(c.key.keyHash);
      return stored.length === wanted.length && timingSafeEqual(stored, wanted);
    });
    if (!match) return null;
    const { key: row, owner } = match;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    if (!hasInstanceAdminRole(owner.role) || owner.banned) return null;
    if (row.access === 'read' && method !== 'GET' && method !== 'HEAD') return null;
    if (row.organizationIds.length > 0) {
      const orgId = /^\/api\/orgs\/([^/?#]+)(?:[/?#]|$)/.exec(path)?.[1];
      if (!orgId || !row.organizationIds.includes(decodeURIComponent(orgId))) return null;
    }
    if (!allows(row.allowedIps, ip)) {
      this.logger.warn(`API key "${row.name}" used from a refused address: ${ip ?? 'unknown'}`);
      return null;
    }
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.id, row.id)))
      .catch(() => undefined);
    const now = new Date();
    return {
      user: owner,
      session: {
        id: `apikey:${row.id}`,
        userId: owner.id,
        token: '',
        expiresAt: row.expiresAt ?? new Date(now.getTime() + 3600_000),
        createdAt: row.createdAt,
        updatedAt: now,
        ipAddress: ip ?? null,
        userAgent: null,
      },
      ...(row.organizationIds.length > 0 ? { apiKeyOrganizations: row.organizationIds } : {}),
    } as unknown as AuthSession;
  }
}

@Controller('system/api-keys')
@UseGuards(SuperAdminGuard)
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get()
  async list(): Promise<{ data: ApiKeyDto[] }> {
    return { data: await this.keys.list() };
  }

  /** The key itself is in the answer, once. */
  @Post()
  create(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ): Promise<ApiKeyDto & { key: string }> {
    return this.keys.create(session, req.ip ?? null, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() session: AuthSession, @Req() req: Request, @Param('id', new ZodValidationPipe(z.uuid())) id: string): Promise<void> {
    await this.keys.remove(session, req.ip ?? null, id);
  }
}

@Global()
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
