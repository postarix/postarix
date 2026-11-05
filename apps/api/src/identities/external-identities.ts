import { ApiDoc } from '../openapi/openapi.js';
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
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { hasInstanceAdminRole } from '../auth/roles.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { externalIdentities, mailboxes, user } from '../db/schema/index.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { RequireOrgRole, Tenant, type TenantContext } from '../tenancy/tenant-context.js';

const text = (max: number) => z.string().trim().min(1).max(max);

export const linkIdentitySchema = z
  .strictObject({
    /** The person, by their mailbox or their account. */
    mailboxId: z.uuid().optional(),
    userId: z.string().min(1).max(100).optional(),
    /** An identity provider's issuer URL, or any stable name an application uses for itself. */
    issuer: text(500),
    /** The person's id there (an OpenID Connect "sub", a SAML NameID, an application's user id). */
    subject: text(500),
    label: z.string().trim().max(200).default(''),
  })
  .refine((v) => (v.mailboxId ? 1 : 0) + (v.userId ? 1 : 0) === 1, { message: 'Give either mailboxId or userId' });
export type LinkIdentityInput = z.infer<typeof linkIdentitySchema>;

export interface ExternalIdentityDto {
  id: string;
  userId: string;
  /** The person's mailbox in this organization. */
  address: string;
  issuer: string;
  subject: string;
  label: string;
  createdAt: string;
}

@Injectable()
export class ExternalIdentitiesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  list(ctx: TenantContext, filter: { userId?: string | undefined; issuer?: string | undefined }) {
    const where = [eq(externalIdentities.organizationId, ctx.organizationId)];
    if (filter.userId) where.push(eq(externalIdentities.userId, filter.userId));
    if (filter.issuer) where.push(eq(externalIdentities.issuer, filter.issuer));
    return this.db
      .select({
        id: externalIdentities.id,
        userId: externalIdentities.userId,
        address: mailboxes.address,
        issuer: externalIdentities.issuer,
        subject: externalIdentities.subject,
        label: externalIdentities.label,
        createdAt: externalIdentities.createdAt,
      })
      .from(externalIdentities)
      .innerJoin(mailboxes, and(eq(mailboxes.userId, externalIdentities.userId), eq(mailboxes.organizationId, ctx.organizationId)))
      .where(and(...where))
      .orderBy(asc(mailboxes.address), asc(externalIdentities.issuer), asc(externalIdentities.subject))
      .limit(1000);
  }

  /** The organization's person mailbox for a user or a mailbox id, with the owner's role. */
  async person(ctx: TenantContext, who: { mailboxId?: string | undefined; userId?: string | undefined }) {
    const [row] = await this.db
      .select({ mailboxId: mailboxes.id, userId: mailboxes.userId, address: mailboxes.address, kind: mailboxes.kind, status: mailboxes.status, role: user.role })
      .from(mailboxes)
      .innerJoin(user, eq(user.id, mailboxes.userId))
      .where(
        and(
          eq(mailboxes.organizationId, ctx.organizationId),
          who.mailboxId ? eq(mailboxes.id, who.mailboxId) : eq(mailboxes.userId, who.userId ?? ''),
        ),
      )
      .limit(1);
    return row;
  }

  async insert(ctx: TenantContext, values: { userId: string; issuer: string; subject: string; label: string }) {
    const [row] = await this.db
      .insert(externalIdentities)
      .values({ ...values, organizationId: ctx.organizationId, createdBy: ctx.userId })
      .onConflictDoNothing()
      .returning();
    return row;
  }

  async delete(ctx: TenantContext, id: string) {
    const [row] = await this.db
      .delete(externalIdentities)
      .where(and(eq(externalIdentities.organizationId, ctx.organizationId), eq(externalIdentities.id, id)))
      .returning();
    return row;
  }
}

function toDto(row: { id: string; userId: string; address: string; issuer: string; subject: string; label: string; createdAt: Date }): ExternalIdentityDto {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

@Injectable()
export class ExternalIdentitiesService {
  constructor(
    @Inject(ExternalIdentitiesRepository) private readonly repository: ExternalIdentitiesRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext, filter: { userId?: string | undefined; issuer?: string | undefined }): Promise<ExternalIdentityDto[]> {
    return (await this.repository.list(ctx, filter)).map(toDto);
  }

  /**
   * Links a person of the organization (the owner of one of its person
   * mailboxes) to an identity elsewhere. Never an instance administrator.
   */
  async link(ctx: TenantContext, input: LinkIdentityInput): Promise<ExternalIdentityDto> {
    const person = await this.repository.person(ctx, input);
    if (!person?.userId) throw new NotFoundException('Mailbox not found');
    if (person.kind !== 'person') throw new UnprocessableEntityException('Only the owner of a person mailbox can be linked');
    if (hasInstanceAdminRole(person.role)) throw new UnprocessableEntityException('Instance administrators cannot be linked to other identities');
    const row = await this.repository.insert(ctx, { userId: person.userId, issuer: input.issuer, subject: input.subject, label: input.label });
    if (!row) throw new ConflictException('This identity is already linked to someone in this organization');
    await this.audit.record(ctx, 'identity.linked', { type: 'mailbox', id: person.mailboxId, label: person.address }, { issuer: input.issuer, subject: input.subject });
    return toDto({ ...row, address: person.address });
  }

  async unlink(ctx: TenantContext, id: string): Promise<void> {
    const row = await this.repository.delete(ctx, id);
    if (!row) throw new NotFoundException('Identity not found');
    const person = await this.repository.person(ctx, { userId: row.userId });
    await this.audit.record(
      ctx,
      'identity.unlinked',
      { type: 'mailbox', id: person?.mailboxId ?? row.userId, label: person?.address ?? row.userId },
      { issuer: row.issuer, subject: row.subject },
    );
  }
}

const listQuery = z.object({ userId: z.string().min(1).max(100).optional(), issuer: z.string().min(1).max(500).optional() });

/** An organization's external identities: its owners and administrators (or an API key limited to it). */
@Controller('orgs/:orgId/identities')
@UseGuards(OrgAccessGuard)
@RequireOrgRole('admin')
export class ExternalIdentitiesController {
  constructor(@Inject(ExternalIdentitiesService) private readonly identities: ExternalIdentitiesService) {}

  @ApiDoc({ summary: 'List external identities', description: 'Who the organization\'s people are elsewhere: (issuer, subject) pairs used by single sign-on and connected applications.' })
  @Get()
  async list(@Tenant() ctx: TenantContext, @Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return { data: await this.identities.list(ctx, query) };
  }

  @ApiDoc({ summary: 'Link a person to an external identity', description: 'By `mailboxId` or `userId` (a person mailbox of the organization; never an instance administrator). One person per pair in an organization.' })
  @Post()
  link(@Tenant() ctx: TenantContext, @Body(new ZodValidationPipe(linkIdentitySchema)) body: LinkIdentityInput) {
    return this.identities.link(ctx, body);
  }

  @ApiDoc({ summary: 'Unlink an external identity' })
  @Delete(':id')
  @HttpCode(204)
  async unlink(@Tenant() ctx: TenantContext, @Param('id', new ZodValidationPipe(z.uuid())) id: string): Promise<void> {
    await this.identities.unlink(ctx, id);
  }
}

@Module({
  controllers: [ExternalIdentitiesController],
  providers: [ExternalIdentitiesRepository, ExternalIdentitiesService, OrgAccessGuard],
  exports: [ExternalIdentitiesService],
})
export class ExternalIdentitiesModule {}
