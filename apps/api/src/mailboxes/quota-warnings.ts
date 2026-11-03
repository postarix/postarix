import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE, SYSTEM_MAILER } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailboxes } from '../db/schema/index.js';
import type { SystemMailer } from '../mail/system-mailer.js';
import { loadInstanceSettings } from '../settings/instance-settings.js';

const CHECK_EVERY_MS = 60 * 60 * 1000;
/** A full mailbox is reminded again after this long. */
const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Tells people when their mailbox is nearly full (the instance's
 * quota.warnAtPercent, 90% by default), once, and again a week later if it
 * still is. Checked every hour.
 */
@Injectable()
export class QuotaWarningsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QuotaWarningsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many people were told. */
  async check(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let warned = 0;
    try {
      const { quota } = await loadInstanceSettings(this.db);
      if (quota.warnAtPercent <= 0) return 0;
      const rows = await this.db
        .select({ id: mailboxes.id, address: mailboxes.address, quotaBytes: mailboxes.quotaBytes, warnedAt: mailboxes.quotaWarnedAt })
        .from(mailboxes)
        .where(and(isNotNull(mailboxes.quotaBytes), inArray(mailboxes.status, ['active', 'no_login'])));
      for (const row of rows) {
        let usage;
        try {
          usage = await this.engine.getUsage(row.address);
        } catch (error) {
          this.logger.warn(`Cannot read the usage of ${row.address}: ${(error as Error).message}`);
          continue;
        }
        const quotaBytes = usage.quotaBytes ?? row.quotaBytes;
        if (!quotaBytes || usage.usedBytes === null) continue;
        const percent = (usage.usedBytes / quotaBytes) * 100;
        if (percent < quota.warnAtPercent) {
          // Back under the threshold: the next time it fills up, say so again.
          if (row.warnedAt) await this.db.update(mailboxes).set({ quotaWarnedAt: null }).where(eq(mailboxes.id, row.id));
          continue;
        }
        if (row.warnedAt && now.getTime() - row.warnedAt.getTime() < REMIND_AFTER_MS) continue;
        await this.mailer.send({
          to: row.address,
          subject: `Your mailbox is ${Math.floor(percent)}% full`,
          text: [
            `${row.address} uses ${size(usage.usedBytes)} of its ${size(quotaBytes)}.`,
            '',
            percent >= 100
              ? 'It is full: new mail is refused until you free some space.'
              : 'When it is full, new mail is refused. Delete old mail (and empty the Trash) or ask your administrator for more space.',
          ].join('\n'),
        });
        await this.db.update(mailboxes).set({ quotaWarnedAt: now }).where(eq(mailboxes.id, row.id));
        warned++;
      }
    } catch (error) {
      this.logger.error(`Quota check failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
    return warned;
  }
}
