import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, or } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { normalizeAddress } from '../common/addresses.js';
import { isUniqueViolation } from '../common/pg-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { bccDirections, type BccRuleRow, bccRules, domains, recipientMaps, type RecipientMapRow } from '../db/schema/index.js';
import { normalizeDomainName } from '../domains/domain-name.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';

/** An address or "@domain" (every address of the domain). */
const addressOrDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .transform((value, ctx) => {
    const raw = value.startsWith('*@') ? value.slice(1) : value;
    const normalized = raw.startsWith('@')
      ? (() => {
          const d = normalizeDomainName(raw.slice(1));
          return d ? `@${d}` : null;
        })()
      : normalizeAddress(raw);
    if (!normalized || normalized.includes(',')) {
      ctx.addIssue({ code: 'custom', message: 'Use an address, or @domain for all of its addresses' });
      return z.NEVER;
    }
    return normalized;
  });
const addressSchema = z
  .string()
  .trim()
  .max(320)
  .transform((value, ctx) => {
    const normalized = normalizeAddress(value);
    if (!normalized || normalized.includes(',')) {
      ctx.addIssue({ code: 'custom', message: 'Expected an email address' });
      return z.NEVER;
    }
    return normalized;
  });
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
const idPipe = new ZodValidationPipe(z.uuid());

// --- BCC rules (organization admins) --------------------------------------------

const bccRuleSchema = z.strictObject({
  address: addressOrDomainSchema,
  direction: z.enum(bccDirections),
  destination: addressSchema,
  enabled: z.boolean().default(true),
});
const bccRuleUpdateSchema = z.strictObject({ enabled: z.boolean() });

export interface BccRuleDto {
  id: string;
  domainId: string;
  address: string;
  direction: BccRuleRow['direction'];
  destination: string;
  enabled: boolean;
  createdAt: string;
}
const bccDto = (r: BccRuleRow): BccRuleDto => ({
  id: r.id,
  domainId: r.domainId,
  address: r.address,
  direction: r.direction,
  destination: r.destination,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Automatic blind copies of the organization's mail: everything an address
 * (or a whole domain) sends or receives is also delivered to another address.
 * Postfix adds them (mail.bcc_targets, next to the archive's copies).
 */
@Injectable()
export class BccRulesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private scope(ctx: TenantContext) {
    return eq(bccRules.organizationId, ctx.organizationId);
  }

  async list(ctx: TenantContext): Promise<BccRuleDto[]> {
    return (await this.db.select().from(bccRules).where(this.scope(ctx)).orderBy(asc(bccRules.address), asc(bccRules.destination))).map(bccDto);
  }

  async create(ctx: TenantContext, input: z.infer<typeof bccRuleSchema>): Promise<BccRuleDto> {
    const [domain] = await this.db
      .select({ id: domains.id, aliasOf: domains.aliasOfDomainId, backupMx: domains.backupMx })
      .from(domains)
      .where(and(eq(domains.organizationId, ctx.organizationId), eq(domains.name, domainOf(input.address))))
      .limit(1);
    if (!domain) throw new UnprocessableEntityException('Use an address of one of your domains');
    if (domain.aliasOf) throw new UnprocessableEntityException('Set the rule on the domain this alias domain repeats');
    if (domain.backupMx) throw new UnprocessableEntityException('This domain is a backup MX: its mail is hosted on its primary server');
    if (input.destination === input.address) throw new UnprocessableEntityException('The copy would go to the same address');
    try {
      const [row] = await this.db
        .insert(bccRules)
        .values({ ...input, organizationId: ctx.organizationId, domainId: domain.id })
        .returning();
      return bccDto(row!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This rule exists already');
      throw error;
    }
  }

  async update(ctx: TenantContext, id: string, input: z.infer<typeof bccRuleUpdateSchema>): Promise<BccRuleDto> {
    const [row] = await this.db.update(bccRules).set(input).where(and(this.scope(ctx), eq(bccRules.id, id))).returning();
    if (!row) throw new NotFoundException('Rule not found');
    return bccDto(row);
  }

  async remove(ctx: TenantContext, id: string): Promise<BccRuleDto> {
    const [row] = await this.db.delete(bccRules).where(and(this.scope(ctx), eq(bccRules.id, id))).returning();
    if (!row) throw new NotFoundException('Rule not found');
    return bccDto(row);
  }
}

const bccLabel = (r: BccRuleDto) => `${r.direction === 'sender' ? 'from' : 'to'} ${r.address} → ${r.destination}`;

@Controller('orgs/:orgId/bcc-rules')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class BccRulesController {
  constructor(
    @Inject(BccRulesService) private readonly rules: BccRulesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Tenant() ctx: TenantContext): Promise<{ data: BccRuleDto[] }> {
    return { data: await this.rules.list(ctx) };
  }

  @Post()
  async create(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(bccRuleSchema)) body: z.infer<typeof bccRuleSchema>): Promise<BccRuleDto> {
    const rule = await this.rules.create(ctx, body);
    await this.audit.record(ctx, 'bcc_rule.created', { type: 'bcc_rule', id: rule.id, label: bccLabel(rule) });
    return rule;
  }

  @Patch(':id')
  async update(
    @Tenant() ctx: TenantContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(bccRuleUpdateSchema)) body: z.infer<typeof bccRuleUpdateSchema>,
  ): Promise<BccRuleDto> {
    const rule = await this.rules.update(ctx, id, body);
    await this.audit.record(ctx, rule.enabled ? 'bcc_rule.enabled' : 'bcc_rule.disabled', { type: 'bcc_rule', id, label: bccLabel(rule) });
    return rule;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    const rule = await this.rules.remove(ctx, id);
    await this.audit.record(ctx, 'bcc_rule.deleted', { type: 'bcc_rule', id, label: bccLabel(rule) });
  }
}

// --- Recipient maps (instance administrators) -----------------------------------

const recipientMapSchema = z.strictObject({
  address: addressOrDomainSchema,
  destination: addressSchema,
  enabled: z.boolean().default(true),
});
const recipientMapUpdateSchema = z
  .strictObject({ destination: addressSchema.optional(), enabled: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface RecipientMapDto {
  id: string;
  address: string;
  destination: string;
  enabled: boolean;
  createdAt: string;
}
const mapDto = (r: RecipientMapRow): RecipientMapDto => ({
  id: r.id,
  address: r.address,
  destination: r.destination,
  enabled: r.enabled,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Server-wide recipient rewriting: mail for an address (here or anywhere
 * else, e.g. a partner's old address) goes to another one instead. It wins
 * over mailboxes and aliases.
 */
@Injectable()
export class RecipientMapsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<RecipientMapDto[]> {
    return (await this.db.select().from(recipientMaps).orderBy(asc(recipientMaps.address))).map(mapDto);
  }

  /** A destination that is itself rewritten would chain (or loop) rewrites. */
  private async assertNoChain(address: string, destination: string, id?: string): Promise<void> {
    if (address === destination) throw new UnprocessableEntityException('The address would be rewritten to itself');
    const chained = await this.db
      .select({ id: recipientMaps.id, address: recipientMaps.address, destination: recipientMaps.destination })
      .from(recipientMaps)
      .where(or(eq(recipientMaps.address, destination), eq(recipientMaps.address, `@${domainOf(destination)}`), eq(recipientMaps.destination, address)));
    if (chained.some((r) => r.id !== id)) {
      throw new UnprocessableEntityException('The destination is rewritten too (or rewritten to this address); point it to the final address');
    }
  }

  async create(input: z.infer<typeof recipientMapSchema>): Promise<RecipientMapDto> {
    await this.assertNoChain(input.address, input.destination);
    try {
      const [row] = await this.db.insert(recipientMaps).values(input).returning();
      return mapDto(row!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('This address is rewritten already');
      throw error;
    }
  }

  async update(id: string, input: z.infer<typeof recipientMapUpdateSchema>): Promise<RecipientMapDto> {
    const [current] = await this.db.select().from(recipientMaps).where(eq(recipientMaps.id, id));
    if (!current) throw new NotFoundException('Rewrite not found');
    if (input.destination) await this.assertNoChain(current.address, input.destination, id);
    const [row] = await this.db.update(recipientMaps).set(input).where(eq(recipientMaps.id, id)).returning();
    return mapDto(row!);
  }

  async remove(id: string): Promise<RecipientMapDto> {
    const [row] = await this.db.delete(recipientMaps).where(eq(recipientMaps.id, id)).returning();
    if (!row) throw new NotFoundException('Rewrite not found');
    return mapDto(row);
  }
}

@Controller('system/recipient-maps')
@UseGuards(SuperAdminGuard)
export class RecipientMapsController {
  constructor(
    @Inject(RecipientMapsService) private readonly maps: RecipientMapsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private record(session: AuthSession, req: Request, action: string, map: RecipientMapDto): Promise<void> {
    return this.audit.recordInstance(
      { userId: session.user.id, userEmail: session.user.email, ipAddress: req.ip ?? null },
      action,
      { type: 'recipient_map', id: map.id, label: `${map.address} → ${map.destination}` },
    );
  }

  @Get()
  async list(): Promise<{ data: RecipientMapDto[] }> {
    return { data: await this.maps.list() };
  }

  @Post()
  async create(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(recipientMapSchema)) body: z.infer<typeof recipientMapSchema>,
  ): Promise<RecipientMapDto> {
    const map = await this.maps.create(body);
    await this.record(session, req, 'recipient_map.created', map);
    return map;
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(recipientMapUpdateSchema)) body: z.infer<typeof recipientMapUpdateSchema>,
  ): Promise<RecipientMapDto> {
    const map = await this.maps.update(id, body);
    await this.record(session, req, 'recipient_map.updated', map);
    return map;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() session: AuthSession, @Req() req: Request, @Param('id', idPipe) id: string): Promise<void> {
    const map = await this.maps.remove(id);
    await this.record(session, req, 'recipient_map.deleted', map);
  }
}

@Module({
  controllers: [BccRulesController, RecipientMapsController],
  providers: [BccRulesService, RecipientMapsService, OrgAccessGuard],
})
export class RulesModule {}
