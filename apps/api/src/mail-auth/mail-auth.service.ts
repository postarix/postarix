import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AccountsService } from '../accounts/accounts.service.js';
import { AppPasswordsService } from '../app-passwords/app-passwords.service.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { type AppPasswordScope, domains, mailboxes } from '../db/schema/index.js';
import { DATABASE, ENV, COUNTER_STORE } from '../core/tokens.js';
import { looksLikeJmapToken, verifyJmapToken } from '../jmap/jmap-token.js';
import { FailureLimiter } from './failure-limiter.js';
import type { CounterStore } from '../core/counter-store.js';

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
  /**
   * Which saslauthd instance asks. "jmap" is the one behind Cyrus' internal
   * JMAP service (the webmail), which accepts nothing but the API's tokens.
   */
  instance: z.enum(['', 'jmap']).default(''),
});
export type MailLoginAttempt = z.infer<typeof mailLoginSchema>;

@Injectable()
export class MailAuthService {
  private readonly logger = new Logger(MailAuthService.name);
  private readonly limiter: FailureLimiter;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AppPasswordsService) private readonly appPasswords: AppPasswordsService,
    @Inject(ENV) private readonly env: Env,
    @Inject(COUNTER_STORE) counters: CounterStore,
  ) {
    this.limiter = new FailureLimiter(counters, 'mail-login', 10, 15 * 60 * 1000);
  }

  /**
   * Validates a mail-protocol login. App passwords with the right scope always
   * work; the account password only works while the user has no second factor.
   *
   * Lockout applies to the account password only. App passwords carry ~120 bits
   * of entropy and cannot be guessed, so they keep working while an attacker
   * hammers a mailbox: repeated failures cannot lock real clients out.
   */
  async authenticate(attempt: MailLoginAttempt): Promise<boolean> {
    const username = attempt.username.trim().toLowerCase();
    const scope = SERVICE_SCOPES[attempt.service.trim().toLowerCase()];
    if (!scope || username.length === 0 || attempt.password.length === 0) return false;

    const account = await this.findAccount(username);
    if (!account) return false;

    // Cyrus' internal JMAP service (the webmail) only accepts the API's own
    // short-lived tokens, minted for a signed-in web session; and those tokens
    // work nowhere else. So no app password or account password ever reaches
    // mail through JMAP. Tokens are never subject to lockout.
    if (attempt.instance === 'jmap') {
      return scope === 'dav' && looksLikeJmapToken(attempt.password) && verifyJmapToken(this.env.AUTH_SECRET, username, attempt.password);
    }
    if (looksLikeJmapToken(attempt.password)) return false;

    if (await this.appPasswords.verify(account.id, attempt.password, scope)) return true;
    if (account.twoFactorEnabled) return false;

    if (await this.limiter.isBlocked(username)) {
      this.logger.warn(`Account password refused after repeated failures: ${username}`);
      return false;
    }
    // Counted before the (slow) hash check, so parallel attempts cannot slip
    // past the limit; cleared again on success.
    await this.limiter.recordFailure(username);
    const ok = await this.accounts.verifyAccountPassword(account.id, attempt.password);
    if (ok) await this.limiter.recordSuccess(username);
    return ok;
  }

  private async findAccount(username: string) {
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
    if (!mailbox?.userId) return null;

    const account = await this.accounts.find(mailbox.userId);
    if (!account || account.banned) return null;
    return account;
  }
}
