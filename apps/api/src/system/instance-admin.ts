import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
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
import { and, asc, eq, ilike, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Auth } from '../auth/auth.js';
import { hasInstanceAdminRole, INSTANCE_ADMIN_ROLE, parseRoles } from '../auth/roles.js';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import type { DnsResolver } from '../core/dns.js';
import { AUTH, DATABASE, DNS_RESOLVER, ENV, SYSTEM_MAILER } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { dkimKeys, domains, mailboxes, organization, session as sessions, user } from '../db/schema/index.js';
import { decryptPrivateKey, importDkimKey, publicKeyBits } from '../dkim/dkim-crypto.js';
import { DkimModule } from '../dkim/dkim.module.js';
import { DkimService } from '../dkim/dkim.service.js';
import type { SystemMailer } from '../mail/system-mailer.js';
import { loadInstanceSettings, passwordProblem } from '../settings/instance-settings.js';

function actorOf(session: AuthSession, req: Request) {
  return { userId: session.user.id, userEmail: session.user.email, ipAddress: req.ip ?? null };
}

// --- Instance administrators ---------------------------------------------------------

export interface InstanceAdminDto {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  banned: boolean;
  createdAt: string;
}

export const addAdminSchema = z.strictObject({
  email: z.email().trim().toLowerCase().max(320),
  /** For a new account; an existing one keeps its own. */
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(1).max(256).optional(),
});

@Injectable()
export class InstanceAdminsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async list(): Promise<InstanceAdminDto[]> {
    const rows = await this.db.select().from(user).where(ilike(user.role, `%${INSTANCE_ADMIN_ROLE}%`)).orderBy(asc(user.email));
    return rows
      .filter((r) => hasInstanceAdminRole(r.role))
      .map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        twoFactorEnabled: r.twoFactorEnabled ?? false,
        banned: r.banned ?? false,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  /** Makes an existing account an instance administrator, or creates one. Returns whether it was created. */
  async add(input: z.infer<typeof addAdminSchema>): Promise<{ id: string; created: boolean }> {
    const [existing] = await this.db.select().from(user).where(eq(user.email, input.email));
    if (existing) {
      if (hasInstanceAdminRole(existing.role)) throw new ConflictException('This account is already an instance administrator');
      const roles = parseRoles(existing.role).filter((r) => r !== 'user');
      await this.db
        .update(user)
        .set({ role: [...roles, INSTANCE_ADMIN_ROLE].join(',') })
        .where(eq(user.id, existing.id));
      // Fresh sessions carry the new role.
      await this.db.delete(sessions).where(eq(sessions.userId, existing.id));
      return { id: existing.id, created: false };
    }
    if (!input.password || !input.name) {
      throw new UnprocessableEntityException('No account has this address: give a name and a password to create one');
    }
    const problem = passwordProblem(input.password, (await loadInstanceSettings(this.db)).passwords);
    if (problem) throw new UnprocessableEntityException(problem);
    const { user: created } = await this.auth.api.createUser({
      body: { email: input.email, password: input.password, name: input.name, role: INSTANCE_ADMIN_ROLE },
    });
    return { id: created.id, created: true };
  }

  async remove(actorId: string, id: string): Promise<{ email: string }> {
    if (id === actorId) throw new UnprocessableEntityException('You cannot remove your own administrator rights');
    const [row] = await this.db.select().from(user).where(eq(user.id, id));
    if (!row || !hasInstanceAdminRole(row.role)) throw new NotFoundException();
    if ((await this.list()).length <= 1) throw new UnprocessableEntityException('The instance needs at least one administrator');
    const roles = parseRoles(row.role).filter((r) => r !== INSTANCE_ADMIN_ROLE);
    await this.db
      .update(user)
      .set({ role: roles.length ? roles.join(',') : 'user' })
      .where(eq(user.id, id));
    await this.db.delete(sessions).where(eq(sessions.userId, id));
    return { email: row.email };
  }
}

@Controller('system/admins')
@UseGuards(SuperAdminGuard)
export class InstanceAdminsController {
  constructor(
    @Inject(InstanceAdminsService) private readonly admins: InstanceAdminsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<{ data: InstanceAdminDto[] }> {
    return { data: await this.admins.list() };
  }

  @Post()
  async add(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(addAdminSchema)) body: z.infer<typeof addAdminSchema>,
  ): Promise<{ id: string; created: boolean }> {
    const result = await this.admins.add(body);
    await this.audit.recordInstance(actorOf(session, req), 'instance_admin.added', { type: 'user', id: result.id, label: body.email }, { created: result.created });
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Param('id', new ZodValidationPipe(z.string().min(1).max(100))) id: string,
  ): Promise<void> {
    const { email } = await this.admins.remove(session.user.id, id);
    await this.audit.recordInstance(actorOf(session, req), 'instance_admin.removed', { type: 'user', id, label: email });
  }
}

// --- Mail to every mailbox ---------------------------------------------------------------------

export const broadcastSchema = z.strictObject({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]*$/, 'Use a single line'),
  text: z.string().trim().min(1).max(20_000),
  /** Only the mailboxes of these organizations (empty: every organization). */
  organizationIds: z.array(z.string().min(1).max(100)).max(500).default([]),
  /** Never these addresses. */
  exclude: z.array(z.email().trim().toLowerCase()).max(1000).default([]),
  /** The sender (empty: SYSTEM_MAIL_FROM). */
  from: z.union([z.literal(''), z.email()]).default(''),
  /** Only count the recipients. */
  dryRun: z.boolean().default(false),
});
export type BroadcastInput = z.infer<typeof broadcastSchema>;

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);
  /** The last send, finished or not (for the tests and the status line). */
  last: Promise<number> = Promise.resolve(0);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
  ) {}

  async recipients(input: BroadcastInput): Promise<string[]> {
    const where = [inArray(mailboxes.status, ['active', 'no_login'] as const)];
    if (input.organizationIds.length) where.push(inArray(mailboxes.organizationId, input.organizationIds));
    const rows = await this.db
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .where(and(...where))
      .orderBy(asc(mailboxes.address));
    const excluded = new Set(input.exclude);
    return rows.map((r) => r.address).filter((a) => !excluded.has(a));
  }

  /** Sends one copy per mailbox, one after the other, in the background. */
  async send(input: BroadcastInput): Promise<number> {
    const addresses = await this.recipients(input);
    if (input.dryRun || addresses.length === 0) return addresses.length;
    this.last = (async () => {
      for (const to of addresses) {
        await this.mailer.send({ to, from: input.from || undefined, subject: input.subject, text: input.text });
      }
      this.logger.log(`Sent "${input.subject}" to ${addresses.length} mailboxes`);
      return addresses.length;
    })();
    return addresses.length;
  }
}

@Controller('system/broadcast')
@UseGuards(SuperAdminGuard)
export class BroadcastController {
  constructor(
    @Inject(BroadcastService) private readonly broadcast: BroadcastService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  async send(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(broadcastSchema)) body: BroadcastInput,
  ): Promise<{ recipients: number }> {
    const recipients = await this.broadcast.send(body);
    if (!body.dryRun) {
      await this.audit.recordInstance(actorOf(session, req), 'instance.mail_sent', { type: 'instance', label: body.subject }, {
        recipients,
        organizationIds: body.organizationIds,
      });
    }
    return { recipients };
  }
}

// --- DKIM keys of every domain ---------------------------------------------------------------

export interface DkimOverviewDto {
  domainId: string;
  domain: string;
  domainStatus: string;
  organizationId: string;
  organization: string;
  selector: string | null;
  bits: number | null;
  createdAt: string | null;
  /** What DNS holds at <selector>._domainkey.<domain>: the key, another key, or nothing. */
  dns: 'ok' | 'different' | 'missing' | 'unknown';
}

export const duplicateDkimSchema = z.strictObject({ fromDomainId: z.uuid(), toDomainId: z.uuid() });

@Injectable()
export class DkimOverviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(DkimService) private readonly dkim: DkimService,
  ) {}

  private async dnsState(name: string, publicKey: string): Promise<DkimOverviewDto['dns']> {
    try {
      const records = (await this.dns.resolveTxt(name)).map((parts) => parts.join(''));
      const published = records.find((r) => /(^|;)\s*p=/i.test(r));
      if (!published) return 'missing';
      return published.replace(/\s+/g, '').includes(`p=${publicKey}`) ? 'ok' : 'different';
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'missing' : 'unknown';
    }
  }

  async list(checkDns: boolean): Promise<DkimOverviewDto[]> {
    const rows = await this.db
      .select({
        domainId: domains.id,
        domain: domains.name,
        domainStatus: domains.status,
        organizationId: domains.organizationId,
        organization: organization.name,
        selector: dkimKeys.selector,
        publicKey: dkimKeys.publicKey,
        createdAt: dkimKeys.createdAt,
      })
      .from(domains)
      .innerJoin(organization, eq(organization.id, domains.organizationId))
      .leftJoin(dkimKeys, and(eq(dkimKeys.domainId, domains.id), eq(dkimKeys.status, 'active')))
      .orderBy(asc(domains.name));
    const out: DkimOverviewDto[] = [];
    // A few lookups at a time.
    for (let i = 0; i < rows.length; i += 10) {
      out.push(
        ...(await Promise.all(
          rows.slice(i, i + 10).map(async (r) => ({
            domainId: r.domainId,
            domain: r.domain,
            domainStatus: r.domainStatus,
            organizationId: r.organizationId,
            organization: r.organization,
            selector: r.selector,
            bits: r.publicKey ? publicKeyBits(r.publicKey) : null,
            createdAt: r.createdAt?.toISOString() ?? null,
            dns: (checkDns && r.selector && r.publicKey
              ? await this.dnsState(`${r.selector}._domainkey.${r.domain}`, r.publicKey)
              : 'unknown') as DkimOverviewDto['dns'],
          })),
        )),
      );
    }
    return out;
  }

  /** Gives `to` the same key (and selector) as `from`, e.g. for domains that share one DNS record. */
  async duplicate(fromDomainId: string, toDomainId: string): Promise<{ from: string; to: string; selector: string }> {
    if (fromDomainId === toDomainId) throw new UnprocessableEntityException('Choose two different domains');
    const [from] = await this.db.select().from(domains).where(eq(domains.id, fromDomainId));
    const [to] = await this.db.select().from(domains).where(eq(domains.id, toDomainId));
    if (!from || !to) throw new NotFoundException('Domain not found');
    const key = await this.dkim.activeKey(from.id);
    if (!key) throw new UnprocessableEntityException(`${from.name} has no DKIM key`);
    const imported = importDkimKey(decryptPrivateKey(key.privateKeyEncrypted, this.env.AUTH_SECRET));
    if (!imported) throw new UnprocessableEntityException(`The DKIM key of ${from.name} cannot be read`);
    await this.dkim.replace(to, key.selector, imported);
    return { from: from.name, to: to.name, selector: key.selector };
  }
}

@Controller('system/dkim')
@UseGuards(SuperAdminGuard)
export class DkimOverviewController {
  constructor(
    @Inject(DkimOverviewService) private readonly overview: DkimOverviewService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() req: Request): Promise<{ data: DkimOverviewDto[] }> {
    return { data: await this.overview.list(req.query.dns !== '0') };
  }

  @Post('duplicate')
  async duplicate(
    @CurrentSession() session: AuthSession,
    @Req() req: Request,
    @Body(new ZodValidationPipe(duplicateDkimSchema)) body: z.infer<typeof duplicateDkimSchema>,
  ): Promise<{ selector: string }> {
    const result = await this.overview.duplicate(body.fromDomainId, body.toDomainId);
    await this.audit.recordInstance(actorOf(session, req), 'domain.dkim_duplicated', { type: 'domain', id: body.toDomainId, label: `${result.from} → ${result.to}` }, { selector: result.selector });
    return { selector: result.selector };
  }
}

@Module({
  imports: [DkimModule],
  controllers: [InstanceAdminsController, BroadcastController, DkimOverviewController],
  providers: [InstanceAdminsService, BroadcastService, DkimOverviewService],
})
export class InstanceAdminModule {}
