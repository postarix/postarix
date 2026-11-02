import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AccountsService } from '../accounts/accounts.service.js';
import { AppPasswordsService } from '../app-passwords/app-passwords.service.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type AppPasswordScope, domains, mailboxes } from '../db/schema/index.js';
import { FailureLimiter } from './failure-limiter.js';

/** Maps the SASL service name reported by Cyrus/Postfix to an app password scope. */
const SERVICE_SCOPES: Record<string, AppPasswordScope> = {
  imap: 'imap',
  pop: 'imap',
  pop3: 'imap',
  sieve: 'imap',
  smtp: 'smtp',
  submission: 'smtp',
  http: 'dav',
  caldav: 'dav',
  carddav: 'dav',
};

export const mailLoginSchema = z.object({
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  service: z.string().min(1).max(32),
});
export type MailLoginAttempt = z.infer<typeof mailLoginSchema>;

@Injectable()
export class MailAuthService {
  private readonly logger = new Logger(MailAuthService.name);
  private readonly limiter = new FailureLimiter(10, 15 * 60 * 1000);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AppPasswordsService) private readonly appPasswords: AppPasswordsService,
  ) {}

  /**
   * Validates a mail-protocol login. App passwords with the right scope always
   * work; the account password only works while the user has no second factor.
   */
  async authenticate(attempt: MailLoginAttempt): Promise<boolean> {
    const username = attempt.username.trim().toLowerCase();
    const scope = SERVICE_SCOPES[attempt.service.trim().toLowerCase()];
    if (!scope || username.length === 0 || attempt.password.length === 0) return false;

    if (this.limiter.isBlocked(username)) {
      this.logger.warn(`Mail login blocked after repeated failures: ${username}`);
      return false;
    }

    const ok = await this.check(username, attempt.password, scope);
    if (ok) this.limiter.recordSuccess(username);
    else this.limiter.recordFailure(username);
    return ok;
  }

  private async check(username: string, password: string, scope: AppPasswordScope): Promise<boolean> {
    // Instance-wide lookup by address is the point of this endpoint: mail
    // logins identify the mailbox by its full address.
    const [mailbox] = await this.db
      .select({ userId: mailboxes.userId })
      .from(mailboxes)
      .innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(
        and(
          eq(mailboxes.address, username),
          eq(mailboxes.status, 'active'),
          eq(domains.status, 'active'),
        ),
      )
      .limit(1);
    if (!mailbox?.userId) return false;

    const account = await this.accounts.find(mailbox.userId);
    if (!account || account.banned) return false;

    if (await this.appPasswords.verify(account.id, password, scope)) return true;
    if (account.twoFactorEnabled) return false;
    return this.accounts.verifyAccountPassword(account.id, password);
  }
}
