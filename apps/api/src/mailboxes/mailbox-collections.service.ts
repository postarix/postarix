import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailboxes } from '../db/schema/index.js';

const BATCH = 50;
const RETRY_MS = 10 * 60 * 1000;

/**
 * Keeps every mailbox's calendars and address books private by default:
 * Cyrus lets "anyone" on the server read a calendar's free/busy, which would
 * cross organizations. Sharing happens only through the API, inside the
 * organization. New mailboxes are handled when created; mailboxes from before
 * this existed (or whose first attempt failed) are handled in the background.
 */
@Injectable()
export class MailboxCollectionsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MailboxCollectionsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Restricts one mailbox's collections; never throws. */
  async restrict(address: string): Promise<boolean> {
    try {
      await this.engine.restrictCollections(address);
      await this.db.update(mailboxes).set({ collectionsRestrictedAt: new Date() }).where(eq(mailboxes.address, address));
      return true;
    } catch (error) {
      this.logger.warn(`Could not restrict the calendars of ${address}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Works through the mailboxes not handled yet. */
  async catchUp(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const failed = new Set<string>();
    try {
      for (;;) {
        const rows = await this.db
          .select({ address: mailboxes.address })
          .from(mailboxes)
          .where(and(isNull(mailboxes.collectionsRestrictedAt), eq(mailboxes.status, 'active')))
          .orderBy(mailboxes.createdAt)
          .limit(BATCH + failed.size);
        const pending = rows.filter((r) => !failed.has(r.address));
        if (pending.length === 0) return;
        for (const { address } of pending) {
          if (!(await this.restrict(address))) failed.add(address);
        }
      }
    } catch (error) {
      this.logger.warn(`Calendar privacy check stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    void this.catchUp();
    this.timer = setInterval(() => void this.catchUp(), RETRY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}
