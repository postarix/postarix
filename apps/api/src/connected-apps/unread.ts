import { ApiDoc } from '../openapi/openapi.js';
import { Body, Controller, ForbiddenException, HttpCode, Inject, Injectable, Logger, Post, Req } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { CounterStore } from '../core/counter-store.js';
import { COUNTER_STORE, DATABASE, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { connectedApps } from '../db/schema/index.js';
import { resolveExternalIdentity } from '../identities/resolve-identity.js';
import { findSharedAccounts } from '../jmap/my-mailbox.js';
import { ServerJmap } from '../mail/jmap-client.js';
import type { AppTokenGrant } from './app-tokens.js';

/** Counts are kept this long (an application's menu polls often). */
const CACHE_MS = 30_000;
const MAX_SUBJECTS = 200;

export interface UnreadEntry {
  subject: string;
  /** Unread messages in their inbox; null when the subject is unknown here. */
  inbox: number | null;
  /** Unread messages in the inbox of each shared mailbox they can read. */
  shared: { address: string; name: string; unread: number }[];
}

export const unreadSchema = z.strictObject({
  /** External subjects of the application's identity issuer. */
  subjects: z.array(z.string().min(1).max(500)).min(1).max(MAX_SUBJECTS),
});

/** The application token on the request (see SessionGuard). */
export interface AppTokenRequest {
  appToken?: AppTokenGrant;
}

/** Unread counts of many people at once, for a connected application's menu. */
@Injectable()
export class UnreadService {
  private readonly logger = new Logger(UnreadService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(COUNTER_STORE) private readonly counters: CounterStore,
  ) {}

  async counts(grant: AppTokenGrant, subjects: string[]): Promise<UnreadEntry[]> {
    const [app] = await this.db.select({ issuer: connectedApps.identityIssuer }).from(connectedApps).where(eq(connectedApps.id, grant.appId));
    if (!app) return [];
    const out: UnreadEntry[] = [];
    for (const subject of [...new Set(subjects)]) {
      const key = `unread:${grant.appId}:${Buffer.from(subject).toString('base64url')}`;
      const cached = await this.counters.getValue(key);
      if (cached) {
        out.push(JSON.parse(cached) as UnreadEntry);
        continue;
      }
      const entry = await this.one(grant.organizationId, app.issuer, subject);
      if (entry.inbox !== null) await this.counters.setValue(key, JSON.stringify(entry), CACHE_MS);
      out.push(entry);
    }
    return out;
  }

  private async one(organizationId: string, issuer: string, subject: string): Promise<UnreadEntry> {
    // Only people linked to this application's issuer: anything else is unknown.
    const person = await resolveExternalIdentity(this.db, organizationId, issuer, subject);
    if (!person) return { subject, inbox: null, shared: [] };
    const shared = await findSharedAccounts(this.db, person.userId);
    const accounts = [person.address, ...shared.map((s) => s.address)];
    try {
      const jmap = new ServerJmap(this.engine, person.address);
      const responses = await jmap.call(
        accounts.map((accountId, i) => ['Mailbox/get', { accountId, properties: ['role', 'unreadEmails'] }, `m${i}`]),
      );
      const inboxUnread = (i: number) => {
        const list = (responses[i]?.[1]?.list ?? []) as { role: string | null; unreadEmails: number }[];
        return list.find((m) => m.role === 'inbox')?.unreadEmails ?? 0;
      };
      return {
        subject,
        inbox: inboxUnread(0),
        shared: shared.map((s, i) => ({ address: s.address, name: s.displayName || s.address, unread: inboxUnread(i + 1) })),
      };
    } catch (error) {
      this.logger.warn(`Could not count unread mail of ${person.address}: ${error instanceof Error ? error.message : String(error)}`);
      return { subject, inbox: null, shared: [] };
    }
  }
}

@Controller('mail')
export class UnreadController {
  constructor(@Inject(UnreadService) private readonly unread: UnreadService) {}

  /** For connected applications' own tokens (client credentials, mail.read). */
  @ApiDoc({ summary: 'Unread counts of many people', description: 'Inbox unread counts of up to 200 people linked to the application (by their id in it), and of the shared mailboxes they can read. Cached for 30 seconds.', appToken: 'Only a connected application\'s own token (client credentials, `mail.read`).' })
  @Post('unread')
  @HttpCode(200)
  async counts(@Req() req: AppTokenRequest, @Body(new ZodValidationPipe(unreadSchema)) body: z.infer<typeof unreadSchema>) {
    const grant = req.appToken;
    if (!grant || grant.userId !== null) throw new ForbiddenException('Only a connected application’s own token can ask for this');
    return { data: await this.unread.counts(grant, body.subjects) };
  }
}
