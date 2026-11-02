import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import { DATABASE, DKIM_PUBLISHER, ENV } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type DkimKeyRow, dkimKeys, domains } from '../db/schema/index.js';
import { decryptPrivateKey, encryptPrivateKey, generateDkimKey, selectorFor } from './dkim-crypto.js';
import type { DkimPublisher } from './dkim-publisher.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Manages per-domain DKIM keys. Callers pass domain IDs they have already
 * resolved through a tenant-scoped repository; this service never looks up a
 * domain on behalf of a request by itself.
 */
@Injectable()
export class DkimService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DkimService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(DKIM_PUBLISHER) private readonly publisher: DkimPublisher,
  ) {}

  async createForDomain(domainId: string): Promise<DkimKeyRow> {
    const key = await generateDkimKey();
    const [row] = await this.db
      .insert(dkimKeys)
      .values({
        domainId,
        selector: selectorFor(new Date()),
        publicKey: key.publicKey,
        privateKeyEncrypted: encryptPrivateKey(key.privateKeyPem, this.env.AUTH_SECRET),
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async activeKey(domainId: string): Promise<DkimKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(dkimKeys)
      .where(and(eq(dkimKeys.domainId, domainId), eq(dkimKeys.status, 'active')))
      .limit(1);
    return row;
  }

  /** Makes Rspamd sign mail for this (active) domain with its active key. */
  async publish(domain: { id: string; name: string }): Promise<void> {
    await this.publisher.markHosted(domain.name);
    const key = await this.activeKey(domain.id);
    if (!key) {
      this.logger.warn(`Domain ${domain.name} has no active DKIM key; mail will not be signed`);
      return;
    }
    await this.publisher.publish(
      domain.name,
      key.selector,
      decryptPrivateKey(key.privateKeyEncrypted, this.env.AUTH_SECRET),
    );
  }

  async unpublish(domainName: string): Promise<void> {
    await this.publisher.unmarkHosted(domainName);
    await this.publisher.unpublish(domainName);
  }

  /**
   * Re-publishes every active domain's key and removes stale entries, at start
   * and then every few minutes, so Valkey converges with the database after a
   * restart or wipe, or after a publish that failed. One broken domain (say, a
   * key that no longer decrypts) does not stop the others.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sync(): Promise<void> {
    let active: { id: string; name: string }[];
    try {
      active = await this.db
        .select({ id: domains.id, name: domains.name })
        .from(domains)
        .where(eq(domains.status, 'active'));
    } catch (error) {
      this.logger.error(`DKIM key synchronisation failed: ${(error as Error).message}`);
      return;
    }
    for (const domain of active) {
      try {
        await this.publish(domain);
      } catch (error) {
        this.logger.error(`Cannot publish the DKIM key of ${domain.name}: ${(error as Error).message}`);
      }
    }
    try {
      await this.publisher.replaceHosted(active.map((d) => d.name));
    } catch (error) {
      this.logger.error(`Cannot publish the hosted domains: ${(error as Error).message}`);
    }
    try {
      const activeNames = new Set(active.map((d) => d.name));
      for (const name of await this.publisher.publishedDomains()) {
        if (!activeNames.has(name)) await this.publisher.unpublish(name);
      }
    } catch (error) {
      this.logger.error(`Cannot prune stale DKIM keys: ${(error as Error).message}`);
    }
  }
}
