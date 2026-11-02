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
import { isUniqueViolation } from '../common/pg-errors.js';
import { MAIL_ENGINE } from '../core/tokens.js';
import type { MailboxRow } from '../db/schema/index.js';
import { DomainsRepository } from '../domains/domains.repository.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  type CreateMailboxInput,
  type MailboxDto,
  toMailboxDto,
  type UpdateMailboxInput,
} from './mailboxes.dto.js';
import { MailboxCollectionsService } from './mailbox-collections.service.js';
import { MailboxesRepository } from './mailboxes.repository.js';

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

    const address = `${input.localPart}@${domain.name}`;
    if (await this.addresses.isTaken(address)) {
      throw new ConflictException('This address is already in use');
    }

    const userId = await this.accounts.create({
      email: address,
      password: input.password,
      name: input.displayName || address,
    });

    let row: MailboxRow;
    try {
      row = await this.repository.create(ctx, {
        domainId: domain.id,
        userId,
        localPart: input.localPart,
        address,
        displayName: input.displayName,
        quotaBytes: input.quotaBytes,
      });
    } catch (error) {
      await this.undo(`account of ${address}`, () => this.accounts.delete(userId));
      if (isUniqueViolation(error)) throw new ConflictException('This address is already in use');
      throw error;
    }

    try {
      await this.engine.createMailbox(address, { quotaBytes: input.quotaBytes });
    } catch (error) {
      // The engine removes a mailbox it created only partly; undo our side.
      await this.undo(`mailbox row of ${address}`, () => this.repository.delete(ctx, row.id));
      await this.undo(`account of ${address}`, () => this.accounts.delete(userId));
      if (error instanceof MailEngineError && error.code === 'already_exists') {
        this.logger.error(`The mail server already has a mailbox for ${address} with no matching record`);
        throw new ConflictException({
          message: 'The mail server already has a mailbox for this address. An instance administrator must remove it.',
          code: 'ENGINE_MAILBOX_EXISTS',
        });
      }
      throw engineErrorToHttp(error);
    }
    // Calendars must not be readable by everyone (Cyrus' default for free/busy).
    // Not fatal: the background check retries mailboxes it missed.
    await this.collections.restrict(address);

    await this.audit.record(
      ctx,
      'mailbox.created',
      { type: 'mailbox', id: row.id, label: address },
      { quotaBytes: input.quotaBytes },
    );
    return toMailboxDto(row);
  }

  async update(ctx: TenantContext, id: string, input: UpdateMailboxInput): Promise<MailboxDto> {
    const current = await this.require(ctx, id);
    if (current.userId) await this.assertNotInstanceAdmin(ctx, current.userId);

    if (input.quotaBytes !== undefined && input.quotaBytes !== current.quotaBytes) {
      try {
        await this.engine.setQuota(current.address, input.quotaBytes);
      } catch (error) {
        throw engineErrorToHttp(error);
      }
    }

    const changes: Partial<Pick<MailboxRow, 'displayName' | 'quotaBytes' | 'status'>> = {};
    if (input.displayName !== undefined) changes.displayName = input.displayName;
    if (input.quotaBytes !== undefined) changes.quotaBytes = input.quotaBytes;
    if (input.status !== undefined) changes.status = input.status;

    const row = await this.repository.update(ctx, id, changes);
    if (!row) throw new NotFoundException('Mailbox not found');
    if (input.displayName !== undefined && row.userId) {
      await this.accounts.rename(row.userId, input.displayName || row.address);
    }
    await this.audit.record(ctx, 'mailbox.updated', { type: 'mailbox', id: row.id, label: row.address }, changes);
    return toMailboxDto(row);
  }

  async setPassword(ctx: TenantContext, id: string, password: string): Promise<void> {
    const mailbox = await this.require(ctx, id);
    if (!mailbox.userId) throw new NotFoundException('This mailbox has no account');
    await this.assertNotInstanceAdmin(ctx, mailbox.userId);
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
    if (mailbox.userId) await this.assertNotInstanceAdmin(ctx, mailbox.userId);
    try {
      await this.engine.deleteMailbox(mailbox.address);
    } catch (error) {
      // Already gone on the mail server: finish cleaning up our side.
      if (!(error instanceof MailEngineError && error.code === 'not_found')) {
        throw engineErrorToHttp(error);
      }
      this.logger.warn(`Mailbox ${mailbox.address} was missing on the mail server during deletion`);
    }
    // The account goes before the row: if a step fails, the row is still there
    // (and visible) so the deletion can simply be retried.
    if (mailbox.userId) await this.accounts.delete(mailbox.userId);
    await this.repository.delete(ctx, id);
    await this.audit.record(ctx, 'mailbox.deleted', { type: 'mailbox', id: mailbox.id, label: mailbox.address });
  }

  /**
   * An organization manages its mailboxes' accounts, but an account that also
   * administers the instance is out of its reach: resetting its password or
   * deleting it would hand over (or remove) the whole instance.
   */
  private async assertNotInstanceAdmin(ctx: TenantContext, userId: string): Promise<void> {
    if (ctx.viaSuperAdmin) return;
    const account = await this.accounts.find(userId);
    if (account?.instanceAdmin) {
      throw new ForbiddenException('This account administers the instance; only an instance administrator can change it');
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
