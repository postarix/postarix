import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE, COUNTER_STORE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { findOwnMailbox, findSharedAccounts, type SharedAccount } from '../jmap/my-mailbox.js';
import { AuditService } from '../audit/audit.service.js';
import { mailboxes, organizationMailOptions, user } from '../db/schema/index.js';
import { BlobTooLargeError, JmapMethodError, ServerJmap } from './jmap-client.js';
import { messageIdOf, setSenderHeader, stripBccHeader } from './raw-message.js';
import { SendLimiter } from './send-limiter.js';
import { createSubmissionTransport } from './submission-transport.js';
import type { CounterStore } from '../core/counter-store.js';
import { RateLimitsService } from '../rate-limits/rate-limits.js';

export interface Identities {
  /** Their own mailbox. */
  address: string;
  name: string;
  /** Addresses they may send as from their own mailbox (aliases, send-as). */
  addresses: string[];
  /** Shared mailboxes they may send from: the draft goes in that account. */
  shared: { address: string; name: string; accountId: string }[];
}

export const sendSchema = z.strictObject({
  emailId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  /** The draft's account: omitted for the person's own mailbox, or a shared mailbox they may send as. */
  accountId: z.string().min(3).max(320).optional(),
});

const MAX_RECIPIENTS = 100;
const recipientSchema = z.email();

interface DraftAddress {
  email?: string | null;
}

interface Draft {
  from: DraftAddress[] | null;
  sender: DraftAddress[] | null;
  to: DraftAddress[] | null;
  cc: DraftAddress[] | null;
  bcc: DraftAddress[] | null;
  blobId: string;
  size: number;
  keywords: Record<string, boolean>;
}

/**
 * Sends a draft from the signed-in user's mailbox. The draft is read from the
 * mail server (not from the request), its From must be an address the user may
 * send as (the same rule Postfix applies on port 587), Bcc is removed, and the
 * message goes to Postfix's internal submission port. Then the draft moves to
 * Sent.
 */
@Injectable()
export class SendService {
  private readonly logger = new Logger(SendService.name);
  private readonly messages: SendLimiter;
  private readonly recipients: SendLimiter;
  private readonly transport;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ENV) private readonly env: Env,
    @Inject(COUNTER_STORE) counters: CounterStore,
    @Inject(RateLimitsService) private readonly rateLimits: RateLimitsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.messages = new SendLimiter(counters, 'messages', 200, 60 * 60 * 1000);
    this.recipients = new SendLimiter(counters, 'recipients', 2_000, 60 * 60 * 1000);
    this.transport = createSubmissionTransport(env);
  }

  async send(userId: string, emailId: string, accountId?: string): Promise<{ sent: true; movedToSent: boolean }> {
    if (!this.transport) throw new ServiceUnavailableException('Sending is not configured');
    const address = await findOwnMailbox(this.db, userId);
    if (!address) throw new NotFoundException('You have no mailbox');
    // From a shared mailbox: the draft is in its account, it must be the
    // person's to send from, and the message goes to its Sent.
    let shared: SharedAccount | undefined;
    if (accountId !== undefined && accountId !== address) {
      shared = (await findSharedAccounts(this.db, userId)).find((s) => s.address === accountId);
      if (!shared) throw new NotFoundException('Mailbox not found');
      if (shared.rights !== 'send') throw new ForbiddenException(`You may not send from ${shared.address}`);
    }
    const jmap = new ServerJmap(this.engine, address, shared?.address);

    const { list } = await this.withJmap(() =>
      jmap.single<{ list: (Draft & { id: string })[] }>('Email/get', {
        ids: [emailId],
        properties: ['from', 'sender', 'to', 'cc', 'bcc', 'blobId', 'size', 'keywords'],
      }),
    );
    const draft = list[0];
    if (!draft) throw new NotFoundException('Draft not found');
    if (!draft.keywords?.$draft) throw new UnprocessableEntityException('Only drafts can be sent');
    if (draft.size > this.env.MAIL_UPLOAD_LIMIT) throw new PayloadTooLargeException('The message is too large');

    const from = this.singleAddress(draft.from, 'From');
    if (draft.sender?.length) {
      const sender = this.singleAddress(draft.sender, 'Sender');
      if (sender !== from) throw new UnprocessableEntityException('Sender must match From');
    }
    if (!(await this.maySendAs(shared?.address ?? address, from))) {
      throw new ForbiddenException(`You may not send as ${from}`);
    }

    const recipients = [
      ...new Set([...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((a) => (a.email ?? '').trim())),
    ];
    if (recipients.length === 0) throw new UnprocessableEntityException('Add at least one recipient');
    if (recipients.length > MAX_RECIPIENTS) {
      throw new UnprocessableEntityException(`At most ${MAX_RECIPIENTS} recipients per message`);
    }
    const invalid = recipients.find((r) => !recipientSchema.safeParse(r).success);
    if (invalid !== undefined) throw new UnprocessableEntityException(`Invalid recipient: ${invalid || '(empty)'}`);

    if (!(await this.messages.tryTake(userId, 1)) || !(await this.recipients.tryTake(userId, recipients.length))) {
      throw new HttpException('Sending limit reached; try again later', 429);
    }
    // The limit the organization set (Rspamd applies the same one to mail apps):
    // the person's, and the shared mailbox's for the team as a whole.
    await this.rateLimits.take(address);
    if (shared) await this.rateLimits.take(shared.address);

    let raw: Buffer;
    try {
      raw = await jmap.download(draft.blobId, this.env.MAIL_UPLOAD_LIMIT);
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw new PayloadTooLargeException('The message is too large');
      throw error;
    }

    let outgoing = stripBccHeader(raw);
    if (shared && (await this.sharedSenderHeader(shared.organizationId))) {
      outgoing = setSenderHeader(outgoing, await this.senderOf(address));
    }
    try {
      await this.transport.sendMail({ envelope: { from, to: recipients }, raw: outgoing });
    } catch (error) {
      const err = error as { responseCode?: number; response?: string; code?: string };
      if (err.responseCode && err.responseCode >= 500) {
        throw new UnprocessableEntityException(`The mail server refused the message: ${err.response ?? err.responseCode}`);
      }
      this.logger.error(`Submission failed for ${address}: ${err.response ?? err.code ?? String(error)}`);
      throw new ServiceUnavailableException('Could not send the message; try again later');
    }

    if (shared) {
      const [person] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      await this.audit.record(
        {
          organizationId: shared.organizationId,
          userId,
          userEmail: person?.email ?? address,
          ipAddress: null,
          role: 'member',
          viaSuperAdmin: false,
          instanceAdmin: false,
        },
        'mail.sent_as_shared',
        { type: 'mailbox', id: shared.id, label: shared.address },
        { by: address, recipients: recipients.length, messageId: messageIdOf(raw) },
      );
    }
    return { sent: true, movedToSent: await this.moveToSent(jmap, emailId) };
  }

  private async sharedSenderHeader(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ on: organizationMailOptions.sharedSenderHeader })
      .from(organizationMailOptions)
      .where(eq(organizationMailOptions.organizationId, organizationId));
    return row?.on ?? false;
  }

  /** "Name <address>" of the person, for the Sender header. */
  private async senderOf(address: string): Promise<string> {
    const [row] = await this.db.select({ name: mailboxes.displayName }).from(mailboxes).where(eq(mailboxes.address, address));
    const name = (row?.name || '').replace(/["\\\r\n]/g, '').trim();
    return name ? `"${name}" <${address}>` : `<${address}>`;
  }

  /**
   * Sends a message the server composed on the user's behalf (calendar
   * invitations and replies), from their own mailbox address, under the same
   * hourly limits as their other mail.
   */
  async sendComposed(
    userId: string,
    message: { from: string; to: string[]; subject: string; text: string; calendar?: { method: string; content: string } },
  ): Promise<void> {
    if (!this.transport) throw new ServiceUnavailableException('Sending is not configured');
    const recipients = [...new Set(message.to.map((r) => r.trim().toLowerCase()))];
    if (recipients.length === 0) return;
    if (recipients.length > MAX_RECIPIENTS) {
      throw new UnprocessableEntityException(`At most ${MAX_RECIPIENTS} recipients per message`);
    }
    const invalid = recipients.find((r) => !recipientSchema.safeParse(r).success);
    if (invalid !== undefined) throw new UnprocessableEntityException(`Invalid recipient: ${invalid || '(empty)'}`);
    if (!(await this.messages.tryTake(userId, 1)) || !(await this.recipients.tryTake(userId, recipients.length))) {
      throw new HttpException('Sending limit reached; try again later', 429);
    }
    await this.rateLimits.take(message.from);
    try {
      await this.transport.sendMail({
        envelope: { from: message.from, to: recipients },
        from: message.from,
        to: recipients,
        subject: message.subject,
        text: message.text,
        ...(message.calendar ? { icalEvent: { method: message.calendar.method, content: message.calendar.content } } : {}),
      });
    } catch (error) {
      const err = error as { responseCode?: number; response?: string; code?: string };
      if (err.responseCode && err.responseCode >= 500) {
        throw new UnprocessableEntityException(`The mail server refused the message: ${err.response ?? err.responseCode}`);
      }
      this.logger.error(`Submission failed for ${message.from}: ${err.response ?? err.code ?? String(error)}`);
      throw new ServiceUnavailableException('Could not send the message; try again later');
    }
  }

  /** Addresses the user may put in From: their mailbox and their organization's aliases that deliver to it. */
  async identities(userId: string): Promise<Identities> {
    const address = await findOwnMailbox(this.db, userId);
    if (!address) throw new NotFoundException('You have no mailbox');
    // The name shown with From: the mailbox's display name, else the account's (when it is not just the address).
    const [named] = await this.db
      .select({ displayName: mailboxes.displayName, userName: user.name })
      .from(mailboxes)
      .leftJoin(user, eq(user.id, mailboxes.userId))
      .where(eq(mailboxes.address, address))
      .limit(1);
    const userName = named?.userName && named.userName.toLowerCase() !== address ? named.userName : '';
    const name = (named?.displayName || userName).trim();
    const result = await this.db.execute<{ sender: string }>(
      // "@domain" entries allow any address of a domain; the webmail offers the listed addresses.
      sql`SELECT sender FROM mail.sender_logins WHERE login = ${address} AND sender NOT LIKE '@%' ORDER BY sender <> ${address}, sender`,
    );
    // Shared mailboxes they may send from (as the mailbox, from its account).
    const shared = (await findSharedAccounts(this.db, userId))
      .filter((s) => s.rights === 'send')
      .map((s) => ({ address: s.address, name: s.displayName, accountId: s.address }));
    const sharedAddresses = new Set(shared.map((s) => s.address));
    return { address, name, addresses: result.rows.map((r) => r.sender).filter((a) => !sharedAddresses.has(a)), shared };
  }

  private singleAddress(list: DraftAddress[] | null, header: string): string {
    if (!list || list.length !== 1 || !list[0]?.email) {
      throw new UnprocessableEntityException(`${header} must contain exactly one address`);
    }
    return list[0].email.trim().toLowerCase();
  }

  /** The same ownership rule Postfix uses for authenticated submission. */
  private async maySendAs(login: string, sender: string): Promise<boolean> {
    const result = await this.db.execute(
      sql`SELECT 1 FROM mail.sender_logins
          WHERE (sender = ${sender} OR sender = '@' || split_part(${sender}, '@', 2)) AND login = ${login} LIMIT 1`,
    );
    return result.rows.length > 0;
  }

  /** Files the sent draft in Sent, marked read. Failing here does not unsend anything. */
  private async moveToSent(jmap: ServerJmap, emailId: string): Promise<boolean> {
    try {
      const { ids } = await jmap.single<{ ids: string[] }>('Mailbox/query', { filter: { role: 'sent' } });
      const sentId = ids[0];
      if (!sentId) return false;
      const result = await jmap.single<{ updated?: Record<string, unknown> | null }>('Email/set', {
        update: { [emailId]: { mailboxIds: { [sentId]: true }, keywords: { $seen: true } } },
      });
      return Boolean(result.updated && emailId in result.updated);
    } catch (error) {
      this.logger.warn(`Sent, but could not move ${emailId} to Sent: ${(error as Error).message}`);
      return false;
    }
  }

  private async withJmap<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof JmapMethodError) throw new UnprocessableEntityException(`Mail server error: ${error.type}`);
      throw error;
    }
  }
}
