import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { type MailEngine, MailEngineError } from '@postarix/mail-engine';
import { AccountsService } from '../accounts/accounts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AddressRegistry } from '../common/address-registry.js';
import { engineErrorToHttp } from '../common/engine-errors.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/pg-errors.js';
import { MAIL_ENGINE } from '../core/tokens.js';
import type { MailboxRow } from '../db/schema/index.js';
import { aliasDomainRefusal, assertMayAddMailbox, assertQuotaFits } from '../domains/domain-limits.js';
import { DomainsRepository } from '../domains/domains.repository.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  type CreateMailboxInput,
  type MailboxDto,
  toMailboxDto,
  type UpdateMailboxInput,
} from './mailboxes.dto.js';
import { rateColumns, RateLimitsService, toRateLimit } from '../rate-limits/rate-limits.js';
import { TemplatesService } from '../templates/templates.js';
import { SpamService } from '../spam/spam.js';
import { ArchivingService } from './archiving.js';
import { MailboxCollectionsService } from './mailbox-collections.service.js';
import { SharedMailboxesService } from './shared-mailboxes.js';
import { type MailboxChanges, MailboxesRepository } from './mailboxes.repository.js';

export interface MailboxUsageDto {
  usedBytes: number | null;
  quotaBytes: number | null;
}

@Injectable()
export class MailboxesService {
  private readonly logger = new Logger(MailboxesService.name);

  constructor(
    @Inject(MailboxesRepository) private readonly repository: MailboxesRepository,
    @Inject(DomainsRepository) private readonly domains: DomainsRepository,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AddressRegistry) private readonly addresses: AddressRegistry,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailboxCollectionsService) private readonly collections: MailboxCollectionsService,
    @Inject(ArchivingService) private readonly archiving: ArchivingService,
    @Inject(RateLimitsService) private readonly rateLimits: RateLimitsService,
    @Inject(SpamService) private readonly spam: SpamService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(SharedMailboxesService) private readonly shared: SharedMailboxesService,
  ) {}

  async list(ctx: TenantContext): Promise<MailboxDto[]> {
    return (await this.repository.list(ctx)).map(toMailboxDto);
  }

  /** Addresses of the organization's mailboxes whose accounts administer the instance. */
  async instanceAdminAddresses(ctx: TenantContext): Promise<string[]> {
    const out: string[] = [];
    for (const row of await this.repository.list(ctx)) {
      if (row.userId && (await this.accounts.find(row.userId))?.instanceAdmin) out.push(row.address);
    }
    return out;
  }

  async get(ctx: TenantContext, id: string): Promise<MailboxDto> {
    return toMailboxDto(await this.require(ctx, id));
  }

  /**
   * Creates the user account, the mailbox row and the engine mailbox. Each step
   * is undone if a later one fails, so no half-provisioned mailbox remains.
   */
  async create(ctx: TenantContext, input: CreateMailboxInput): Promise<MailboxDto> {
    const domain = await this.domains.findById(ctx, input.domainId);
    if (!domain) {
      throw new UnprocessableEntityException({ message: 'Unknown domain', code: 'UNKNOWN_DOMAIN' });
    }
    if (domain.status !== 'active') {
      throw new UnprocessableEntityException({
        message: 'Verify the domain before adding mailboxes',
        code: 'DOMAIN_NOT_VERIFIED',
      });
    }

    if (domain.aliasOfDomainId) throw aliasDomainRefusal();
    const address = `${input.localPart}@${domain.name}`;
    if (await this.addresses.isTaken(address)) {
      throw new ConflictException('This address is already in use');
    }
    const { quotaBytes: templateQuota, ...templateSettings } = await this.templates.mailboxSettings(ctx, input.templateId);
    // Without a choice, the template's quota, else the domain's default.
    const quotaBytes = input.quotaBytes !== undefined ? input.quotaBytes : templateQuota !== undefined ? templateQuota : domain.defaultMailboxQuotaBytes;
    const checkLimits = (locked: typeof domain, usage: Parameters<typeof assertMayAddMailbox>[1]) => {
      assertMayAddMailbox(locked, usage);
      assertQuotaFits(locked, usage, quotaBytes);
    };
    // Checked once before creating the account (cheap refusal), and again,
    // under a lock, when the mailbox is inserted.
    const usage = await this.domains.usage(ctx, domain.id);
    if (usage) checkLimits(domain, usage);

    // A shared mailbox has no account: nobody signs in as it, its members use their own.
    const isShared = input.kind === 'shared';
    const userId = isShared
      ? null
      : await this.accounts.create({
          email: address,
          password: input.password ?? '',
          name: input.displayName || address,
        });
    const dropAccount = () => (userId ? this.undo(`account of ${address}`, () => this.accounts.delete(userId)) : Promise.resolve());

    let row: MailboxRow;
    try {
      row = await this.repository.create(ctx, {
        domainId: domain.id,
        userId,
        localPart: input.localPart,
        address,
        displayName: input.displayName,
        quotaBytes,
        kind: input.kind,
        // Nobody signs in as it, so it never gets calendars to make private.
        ...(isShared ? { sharedSeen: input.sharedSeen ?? true, collectionsRestrictedAt: new Date() } : {}),
      }, checkLimits);
    } catch (error) {
      await dropAccount();
      if (isUniqueViolation(error)) throw new ConflictException('This address is already in use');
      throw error;
    }

    try {
      await this.engine.createMailbox(address, { quotaBytes });
    } catch (error) {
      // The engine removes a mailbox it created only partly; undo our side.
      await this.undo(`mailbox row of ${address}`, () => this.repository.delete(ctx, row.id));
      await dropAccount();
      if (error instanceof MailEngineError && error.code === 'already_exists') {
        this.logger.error(`The mail server already has a mailbox for ${address} with no matching record`);
        throw new ConflictException({
          message: 'The mail server already has a mailbox for this address. An instance administrator must remove it.',
          code: 'ENGINE_MAILBOX_EXISTS',
        });
      }
      throw engineErrorToHttp(error);
    }
    if (isShared) {
      // Its seen-state mode (and no members yet) on the mail server.
      await this.shared.apply(row).catch((error: unknown) => this.logger.warn(`Could not set up the shared mailbox ${address}: ${String(error)}`));
    } else {
      // Calendars must not be readable by everyone (Cyrus' default for free/busy).
      // Not fatal: the background check retries mailboxes it missed.
      await this.collections.restrict(address);
    }

    await this.audit.record(
      ctx,
      'mailbox.created',
      { type: 'mailbox', id: row.id, label: address },
      { quotaBytes },
    );
    if (Object.keys(templateSettings).length > 0) return this.update(ctx, row.id, templateSettings);
    return toMailboxDto(row);
  }

  async update(ctx: TenantContext, id: string, input: UpdateMailboxInput): Promise<MailboxDto> {
    const current = await this.require(ctx, id);
    if (input.relayHostId !== undefined && !ctx.instanceAdmin) {
      throw new ForbiddenException('Only an instance administrator can choose the smart host of a mailbox');
    }
    const losesSignIn = input.status !== undefined && input.status !== 'active';
    if (current.userId) await this.assertMayManage(ctx, current.userId, { removing: losesSignIn });
    if (input.status === 'disabled' && current.status !== 'disabled') await this.archiving.assertMayRemove(ctx, id);

    if (input.kind !== undefined && (input.kind === 'shared') !== (current.kind === 'shared')) {
      throw new UnprocessableEntityException('A mailbox cannot become shared, or stop being shared: create a new one');
    }
    if (input.sharedSeen !== undefined && current.kind !== 'shared') {
      throw new UnprocessableEntityException('Only shared mailboxes have a shared read state');
    }
    const quotaChanges = input.quotaBytes !== undefined && input.quotaBytes !== current.quotaBytes;
    const changes: MailboxChanges = {};
    if (input.displayName !== undefined) changes.displayName = input.displayName;
    if (input.quotaBytes !== undefined) changes.quotaBytes = input.quotaBytes;
    if (input.status !== undefined) changes.status = input.status;
    if (input.kind !== undefined) changes.kind = input.kind;
    if (input.allowedProtocols !== undefined) changes.allowedProtocols = input.allowedProtocols;
    if (input.tlsRequiredIn !== undefined) changes.tlsRequiredIn = input.tlsRequiredIn;
    if (input.tlsRequiredOut !== undefined) changes.tlsRequiredOut = input.tlsRequiredOut;
    if (input.rateLimit !== undefined) Object.assign(changes, rateColumns(input.rateLimit));
    if (input.relayHostId !== undefined) changes.relayHostId = input.relayHostId;
    if (input.quarantineNotify !== undefined) changes.quarantineNotify = input.quarantineNotify;
    if (input.sharedSeen !== undefined) changes.sharedSeen = input.sharedSeen;
    if (input.spamScores !== undefined) {
      changes.spamJunkScore = input.spamScores.junkScore;
      changes.spamRejectScore = input.spamScores.rejectScore;
    }

    // A new quota must fit the domain's limits; the mail server gets it while
    // the domain is locked, so two changes cannot both take the last space.
    const row = await this.repository
      .update(
        ctx,
        id,
        changes,
      quotaChanges
        ? async (domain, usage) => {
            const quota = input.quotaBytes ?? null;
            assertQuotaFits(domain, usage, quota, current.quotaBytes);
            try {
              await this.engine.setQuota(current.address, quota);
            } catch (error) {
              throw engineErrorToHttp(error);
            }
          }
        : undefined,
      )
      .catch((error: unknown) => {
        if (isForeignKeyViolation(error)) {
          throw new UnprocessableEntityException({ message: 'Unknown smart host', code: 'UNKNOWN_RELAY_HOST' });
        }
        throw error;
      });
    if (!row) throw new NotFoundException('Mailbox not found');
    if (input.displayName !== undefined && row.userId) {
      await this.accounts.rename(row.userId, input.displayName || row.address);
    }
    if (input.rateLimit !== undefined) await this.rateLimits.publish(row.address, toRateLimit(row));
    if (input.spamScores !== undefined) await this.spam.publishScores(row.address, row);
    if (row.kind === 'shared') {
      if (input.sharedSeen !== undefined && input.sharedSeen !== current.sharedSeen) await this.shared.apply(row);
      // Members use it until it is disabled; then they lose it in their open sessions too.
      if (input.status === 'disabled' && current.status !== 'disabled') await this.shared.signOutMembers(row.id);
    }
    // Nobody may stay signed in to a mailbox that can no longer sign in.
    if (losesSignIn && current.status === 'active' && row.userId) {
      await this.accounts.signOutEverywhere(row.userId, 'mailbox_disabled');
    }
    await this.audit.record(ctx, 'mailbox.updated', { type: 'mailbox', id: row.id, label: row.address }, changes);
    return toMailboxDto(row);
  }

  async sendAs(ctx: TenantContext, id: string): Promise<{ senders: string[] }> {
    await this.require(ctx, id);
    return { senders: await this.repository.sendAs(ctx, id) };
  }

  /**
   * Sets the further addresses (or whole domains, as "@domain") the mailbox
   * may send as. Only the organization's own domains: an organization must
   * never send as another's addresses.
   */
  async setSendAs(ctx: TenantContext, id: string, senders: string[]): Promise<{ senders: string[] }> {
    const mailbox = await this.require(ctx, id);
    const domainOf = (sender: string) => sender.slice(sender.lastIndexOf('@') + 1);
    const own = await this.repository.ownDomains(ctx, [...new Set(senders.map(domainOf))]);
    const foreign = senders.filter((sender) => !own.has(domainOf(sender)));
    if (foreign.length > 0) {
      throw new UnprocessableEntityException({
        message: `Only addresses on this organization's domains: ${foreign.join(', ')}`,
        code: 'SEND_AS_FOREIGN_DOMAIN',
      });
    }
    const list = senders.filter((sender) => sender !== mailbox.address);
    await this.repository.setSendAs(
      ctx,
      id,
      list.map((sender) => ({ sender, domainId: own.get(domainOf(sender)) as string })),
    );
    await this.audit.record(ctx, 'mailbox.send_as_changed', { type: 'mailbox', id, label: mailbox.address }, { senders: list });
    return { senders: await this.repository.sendAs(ctx, id) };
  }

  async setPassword(ctx: TenantContext, id: string, password: string): Promise<void> {
    const mailbox = await this.require(ctx, id);
    if (!mailbox.userId) throw new NotFoundException('This mailbox has no account');
    await this.assertMayManage(ctx, mailbox.userId, { removing: false });
    await this.accounts.setPassword(mailbox.userId, password);
    await this.audit.record(ctx, 'mailbox.password_reset', {
      type: 'mailbox',
      id: mailbox.id,
      label: mailbox.address,
    });
  }

  async usage(ctx: TenantContext, id: string): Promise<MailboxUsageDto> {
    const mailbox = await this.require(ctx, id);
    try {
      return await this.engine.getUsage(mailbox.address);
    } catch (error) {
      throw engineErrorToHttp(error);
    }
  }

  /** Deletes the engine mailbox (and all its mail), the row and the user account. */
  async remove(ctx: TenantContext, id: string): Promise<void> {
    const mailbox = await this.require(ctx, id);
    if (mailbox.userId) await this.assertMayManage(ctx, mailbox.userId, { removing: true });
    await this.archiving.assertMayRemove(ctx, id);
    try {
      await this.engine.deleteMailbox(mailbox.address);
    } catch (error) {
      // Already gone on the mail server: finish cleaning up our side.
      if (!(error instanceof MailEngineError && error.code === 'not_found')) {
        throw engineErrorToHttp(error);
      }
      this.logger.warn(`Mailbox ${mailbox.address} was missing on the mail server during deletion`);
    }
    if (mailbox.kind === 'shared') await this.shared.signOutMembers(mailbox.id);
    // The shared mailboxes they belonged to stop naming their address (someone
    // given the address later must not inherit the access).
    const memberships = mailbox.userId ? await this.shared.membershipsOf(mailbox.userId) : [];
    // The account goes before the row: if a step fails, the row is still there
    // (and visible) so the deletion can simply be retried.
    if (mailbox.userId) await this.accounts.delete(mailbox.userId);
    await this.repository.delete(ctx, id);
    await this.audit.record(ctx, 'mailbox.deleted', { type: 'mailbox', id: mailbox.id, label: mailbox.address });
    for (const shared of memberships) {
      await this.shared.apply(shared).catch((error: unknown) => this.logger.warn(`Could not update the members of ${shared.address}: ${String(error)}`));
    }
    // Colleagues' calendars and contacts shared with it are no longer shared
    // with the address (someone given it later must not inherit them).
    void this.forgetShares(ctx, mailbox.address);
  }

  private async forgetShares(ctx: TenantContext, address: string): Promise<void> {
    for (const other of await this.repository.list(ctx)) {
      try {
        await this.engine.removeGrantee(other.address, address);
      } catch (error) {
        this.logger.warn(`Could not stop sharing ${other.address}'s calendars with ${address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * An organization manages its mailboxes' accounts, within limits:
   * - an account that also administers the instance is out of its reach
   *   (resetting its password or deleting it would hand over, or remove, the
   *   whole instance);
   * - only owners may change the account of an admin or an owner (otherwise an
   *   admin could reset an owner's password, sign in as them and promote
   *   themselves);
   * - the last owner's mailbox cannot be disabled or deleted.
   */
  private async assertMayManage(ctx: TenantContext, userId: string, { removing }: { removing: boolean }): Promise<void> {
    if (ctx.viaSuperAdmin) return;
    const account = await this.accounts.find(userId);
    if (account?.instanceAdmin) {
      throw new ForbiddenException('This account administers the instance; only an instance administrator can change it');
    }
    const role = await this.repository.roleOf(ctx, userId);
    if ((role === 'owner' || role === 'admin') && ctx.role !== 'owner') {
      throw new ForbiddenException('Only an owner can change the account of an administrator or owner');
    }
    if (removing && role === 'owner' && (await this.repository.ownerCount(ctx)) <= 1) {
      throw new ConflictException('This is the organization’s only owner; make someone else owner first');
    }
  }

  /** Runs one rollback step; a failure is logged so the remaining steps still run. */
  private async undo(what: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.error(`Rollback failed for ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async require(ctx: TenantContext, id: string): Promise<MailboxRow> {
    const row = await this.repository.findById(ctx, id);
    if (!row) throw new NotFoundException('Mailbox not found');
    return row;
  }
}
