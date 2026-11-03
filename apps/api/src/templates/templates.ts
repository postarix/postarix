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
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { isUniqueViolation } from '../common/pg-errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailProtocols, mtaStsModes, quarantineNotifyIntervals, type TemplateKind, type TemplateRow, templates } from '../db/schema/index.js';
import { rateLimitSchema } from '../rate-limits/rate-limits.js';
import { spamScoresSchema } from '../spam/spam.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';

const quota = z
  .number()
  .int()
  .min(1024 * 1024)
  .max(1024 ** 5)
  .nullable();
const count = z.number().int().min(0).max(1_000_000).nullable();

/** What a domain template sets on new domains (each field optional: absent, untouched). */
export const domainTemplateSettingsSchema = z.strictObject({
  defaultMailboxQuotaBytes: quota.optional(),
  maxMailboxes: count.optional(),
  maxAliases: count.optional(),
  maxMailboxQuotaBytes: quota.optional(),
  totalQuotaBytes: quota.optional(),
  rateLimit: rateLimitSchema.optional(),
  spamScores: spamScoresSchema.optional(),
  mtaStsMode: z.enum(mtaStsModes).nullable().optional(),
}).refine(
  // As for a domain (assertLimitsHold): with a quota limit, new mailboxes need a default quota within it.
  (v) => {
    const fallback = v.defaultMailboxQuotaBytes ?? null;
    const caps = [v.maxMailboxQuotaBytes, v.totalQuotaBytes].filter((c): c is number => typeof c === 'number');
    return caps.every((cap) => fallback !== null && fallback <= cap);
  },
  { message: 'With a quota limit, the default mailbox quota must be set, and fit within it', path: ['defaultMailboxQuotaBytes'] },
);
export type DomainTemplateSettings = z.infer<typeof domainTemplateSettingsSchema>;

/** What a mailbox template sets on new mailboxes. */
export const mailboxTemplateSettingsSchema = z.strictObject({
  quotaBytes: quota.optional(),
  allowedProtocols: z
    .array(z.enum(mailProtocols))
    .max(mailProtocols.length)
    .transform((list) => [...new Set(list)])
    .optional(),
  tlsRequiredIn: z.boolean().optional(),
  tlsRequiredOut: z.boolean().optional(),
  rateLimit: rateLimitSchema.optional(),
  spamScores: spamScoresSchema.optional(),
  quarantineNotify: z.enum(quarantineNotifyIntervals).optional(),
});
export type MailboxTemplateSettings = z.infer<typeof mailboxTemplateSettingsSchema>;

const nameSchema = z.string().trim().min(1).max(100);
const domainTemplateSchema = z.strictObject({ name: nameSchema, isDefault: z.boolean().default(false), settings: domainTemplateSettingsSchema });
const domainTemplateUpdateSchema = z
  .strictObject({ name: nameSchema.optional(), isDefault: z.boolean().optional(), settings: domainTemplateSettingsSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const mailboxTemplateSchema = z.strictObject({ name: nameSchema, isDefault: z.boolean().default(false), settings: mailboxTemplateSettingsSchema });
const mailboxTemplateUpdateSchema = z
  .strictObject({ name: nameSchema.optional(), isDefault: z.boolean().optional(), settings: mailboxTemplateSettingsSchema.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface TemplateDto<S> {
  id: string;
  name: string;
  isDefault: boolean;
  settings: S;
  createdAt: string;
}
const toDto = <S>(row: TemplateRow): TemplateDto<S> => ({
  id: row.id,
  name: row.name,
  isDefault: row.isDefault,
  settings: row.settings as S,
  createdAt: row.createdAt.toISOString(),
});

type Scope = { kind: 'domain' } | { kind: 'mailbox'; ctx: TenantContext };

/**
 * Templates for new domains (instance-wide) and new mailboxes (per
 * organization). Settings are re-checked when read, so a template saved by an
 * older version never applies something invalid.
 */
@Injectable()
export class TemplatesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private where(scope: Scope): SQL {
    return scope.kind === 'domain'
      ? and(eq(templates.kind, 'domain'), isNull(templates.organizationId))!
      : and(eq(templates.kind, 'mailbox'), eq(templates.organizationId, scope.ctx.organizationId))!;
  }

  async list<S>(scope: Scope): Promise<TemplateDto<S>[]> {
    return (await this.db.select().from(templates).where(this.where(scope)).orderBy(asc(templates.name))).map((r) => toDto<S>(r));
  }

  async create<S>(scope: Scope, input: { name: string; isDefault: boolean; settings: object }): Promise<TemplateDto<S>> {
    return this.save(() =>
      this.db.transaction(async (tx) => {
        if (input.isDefault) await tx.update(templates).set({ isDefault: false }).where(this.where(scope));
        const [row] = await tx
          .insert(templates)
          .values({
            kind: scope.kind,
            organizationId: scope.kind === 'mailbox' ? scope.ctx.organizationId : null,
            name: input.name,
            isDefault: input.isDefault,
            settings: input.settings as Record<string, unknown>,
          })
          .returning();
        return toDto<S>(row!);
      }),
    );
  }

  async update<S>(scope: Scope, id: string, input: { name?: string | undefined; isDefault?: boolean | undefined; settings?: object | undefined }): Promise<TemplateDto<S>> {
    return this.save(() =>
      this.db.transaction(async (tx) => {
        if (input.isDefault) await tx.update(templates).set({ isDefault: false }).where(this.where(scope));
        const [row] = await tx
          .update(templates)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
            ...(input.settings !== undefined ? { settings: input.settings as Record<string, unknown> } : {}),
          })
          .where(and(this.where(scope), eq(templates.id, id)))
          .returning();
        if (!row) throw new NotFoundException('Template not found');
        return toDto<S>(row);
      }),
    );
  }

  async remove<S>(scope: Scope, id: string): Promise<TemplateDto<S>> {
    const [row] = await this.db
      .delete(templates)
      .where(and(this.where(scope), eq(templates.id, id)))
      .returning();
    if (!row) throw new NotFoundException('Template not found');
    return toDto<S>(row);
  }

  private async save<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('There is already a template with this name');
      throw error;
    }
  }

  /** The chosen template's settings, else the default one's, else none. */
  private async settingsFor(scope: Scope, templateId: string | null | undefined): Promise<Record<string, unknown>> {
    if (templateId === null) return {};
    const [row] = await this.db
      .select()
      .from(templates)
      .where(and(this.where(scope), templateId ? eq(templates.id, templateId) : eq(templates.isDefault, true)))
      .limit(1);
    if (!row && templateId) throw new UnprocessableEntityException({ message: 'Unknown template', code: 'UNKNOWN_TEMPLATE' });
    return row?.settings ?? {};
  }

  async domainSettings(templateId?: string | null): Promise<DomainTemplateSettings> {
    const parsed = domainTemplateSettingsSchema.safeParse(await this.settingsFor({ kind: 'domain' }, templateId));
    return parsed.success ? parsed.data : {};
  }

  async mailboxSettings(ctx: TenantContext, templateId?: string | null): Promise<MailboxTemplateSettings> {
    const parsed = mailboxTemplateSettingsSchema.safeParse(await this.settingsFor({ kind: 'mailbox', ctx }, templateId));
    return parsed.success ? parsed.data : {};
  }
}

const idPipe = new ZodValidationPipe(z.uuid());

/** Instance administrators: templates for new domains (limits included). */
@Controller('system/domain-templates')
@UseGuards(SuperAdminGuard)
export class DomainTemplatesController {
  constructor(
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private record(session: AuthSession, req: Request, action: string, template: { id: string; name: string }): Promise<void> {
    return this.audit.recordInstance(
      { userId: session.user.id, userEmail: session.user.email, ipAddress: req.ip ?? null },
      action,
      { type: 'template', id: template.id, label: template.name },
    );
  }

  @Get()
  async list(): Promise<{ data: TemplateDto<DomainTemplateSettings>[] }> {
    return { data: await this.templates.list({ kind: 'domain' }) };
  }

  @Post()
  async create(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(domainTemplateSchema)) body: z.infer<typeof domainTemplateSchema>,
  ): Promise<TemplateDto<DomainTemplateSettings>> {
    const template = await this.templates.create<DomainTemplateSettings>({ kind: 'domain' }, body);
    await this.record(session, req, 'domain_template.created', template);
    return template;
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(domainTemplateUpdateSchema)) body: z.infer<typeof domainTemplateUpdateSchema>,
  ): Promise<TemplateDto<DomainTemplateSettings>> {
    const template = await this.templates.update<DomainTemplateSettings>({ kind: 'domain' }, id, body);
    await this.record(session, req, 'domain_template.updated', template);
    return template;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() session: AuthSession, @Req() req: Request, @Param('id', idPipe) id: string): Promise<void> {
    const template = await this.templates.remove({ kind: 'domain' }, id);
    await this.record(session, req, 'domain_template.deleted', template);
  }
}

/** Organization admins: templates for their new mailboxes. */
@Controller('orgs/:orgId/mailbox-templates')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class MailboxTemplatesController {
  constructor(
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Tenant() ctx: TenantContext): Promise<{ data: TemplateDto<MailboxTemplateSettings>[] }> {
    return { data: await this.templates.list({ kind: 'mailbox', ctx }) };
  }

  @Post()
  async create(
    @Tenant() ctx: TenantContext,
    @Body(new ZodValidationPipe(mailboxTemplateSchema)) body: z.infer<typeof mailboxTemplateSchema>,
  ): Promise<TemplateDto<MailboxTemplateSettings>> {
    const template = await this.templates.create<MailboxTemplateSettings>({ kind: 'mailbox', ctx }, body);
    await this.audit.record(ctx, 'mailbox_template.created', { type: 'template', id: template.id, label: template.name });
    return template;
  }

  @Patch(':id')
  async update(
    @Tenant() ctx: TenantContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(mailboxTemplateUpdateSchema)) body: z.infer<typeof mailboxTemplateUpdateSchema>,
  ): Promise<TemplateDto<MailboxTemplateSettings>> {
    const template = await this.templates.update<MailboxTemplateSettings>({ kind: 'mailbox', ctx }, id, body);
    await this.audit.record(ctx, 'mailbox_template.updated', { type: 'template', id, label: template.name });
    return template;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Tenant() ctx: TenantContext, @Param('id', idPipe) id: string): Promise<void> {
    const template = await this.templates.remove({ kind: 'mailbox', ctx }, id);
    await this.audit.record(ctx, 'mailbox_template.deleted', { type: 'template', id, label: template.name });
  }
}

@Module({
  controllers: [DomainTemplatesController, MailboxTemplatesController],
  providers: [TemplatesService, OrgAccessGuard],
  exports: [TemplatesService],
})
export class TemplatesModule {}

export type { TemplateKind };
