import { Body, Controller, Get, Header, HttpCode, Inject, Injectable, Module, Post, Query, Res, UseGuards } from '@nestjs/common';
import { asc, eq, gt, inArray, lt, max, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailboxes, sessionDisconnectNodes, sessionDisconnects } from '../db/schema/index.js';
import { InternalTokenGuard } from '../mail-auth/mail-auth.controller.js';

/** Why someone's open mail sessions are ended (kept with the request). */
export type DisconnectReason =
  | 'mailbox_disabled'
  | 'mailbox_deleted'
  | 'domain_disabled'
  | 'account_deleted'
  | 'mailbox_converted'
  | 'account_banned'
  | 'password_changed'
  | 'second_factor_added'
  | 'app_password_revoked'
  | 'signed_out_everywhere'
  | 'access_removed';

/** Requests are kept this long; a node down for longer starts again from the latest. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a node's poll is held open when there is nothing to do. */
export const LONG_POLL_MS = 25_000;
const POLL_STEP_MS = 1_000;
const BATCH = 500;

const ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+$/;

/**
 * Asks every Cyrus node to end the open sessions of these mail logins (Cyrus
 * checks credentials only when a session starts). Takes user ids (their
 * mailboxes' addresses are looked up) and/or addresses. Safe to call for
 * users without a mailbox: nothing is recorded.
 */
export async function requestDisconnect(
  db: Pick<Database, 'select' | 'insert'>,
  who: { userIds?: readonly string[]; addresses?: readonly string[]; domainId?: string },
  reason: DisconnectReason,
): Promise<void> {
  const addresses = new Set((who.addresses ?? []).map((a) => a.toLowerCase()));
  const userIds = [...new Set(who.userIds ?? [])].filter(Boolean);
  if (userIds.length > 0) {
    const rows = await db.select({ address: mailboxes.address }).from(mailboxes).where(inArray(mailboxes.userId, userIds));
    for (const row of rows) addresses.add(row.address);
  }
  if (who.domainId) {
    const rows = await db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.domainId, who.domainId));
    for (const row of rows) addresses.add(row.address);
  }
  const values = [...addresses].filter((username) => ADDRESS.test(username)).map((username) => ({ username, reason }));
  if (values.length > 0) await db.insert(sessionDisconnects).values(values);
}

@Injectable()
export class SessionDisconnectsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The requests a node has not applied yet, oldest first. A node seen for the
   * first time starts after the latest request: it has no sessions from before.
   * Waits up to `waitMs` for one to arrive when there is none.
   */
  async pending(node: string, waitMs = LONG_POLL_MS, signal?: AbortSignal): Promise<{ id: number; username: string }[]> {
    const cursor = await this.cursor(node);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = await this.db
        .select({ id: sessionDisconnects.id, username: sessionDisconnects.username })
        .from(sessionDisconnects)
        .where(gt(sessionDisconnects.id, cursor))
        .orderBy(asc(sessionDisconnects.id))
        .limit(BATCH);
      if (rows.length > 0 || Date.now() >= deadline || signal?.aborted) return rows;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_STEP_MS, Math.max(0, deadline - Date.now()))));
    }
  }

  /** Records that a node applied every request up to `lastId`. */
  async acknowledge(node: string, lastId: number): Promise<void> {
    await this.db
      .insert(sessionDisconnectNodes)
      .values({ node, lastId })
      .onConflictDoUpdate({
        target: sessionDisconnectNodes.node,
        set: { lastId: sql`GREATEST(${sessionDisconnectNodes.lastId}, ${lastId})`, seenAt: new Date() },
      });
    await this.prune();
  }

  private async cursor(node: string): Promise<number> {
    const [known] = await this.db
      .update(sessionDisconnectNodes)
      .set({ seenAt: new Date() })
      .where(eq(sessionDisconnectNodes.node, node))
      .returning({ lastId: sessionDisconnectNodes.lastId });
    if (known) return known.lastId;
    const [latest] = await this.db.select({ id: max(sessionDisconnects.id) }).from(sessionDisconnects);
    const lastId = latest?.id ?? 0;
    await this.db.insert(sessionDisconnectNodes).values({ node, lastId }).onConflictDoNothing();
    return lastId;
  }

  private async prune(): Promise<void> {
    const before = new Date(Date.now() - KEEP_MS);
    await this.db.delete(sessionDisconnects).where(lt(sessionDisconnects.createdAt, before));
    await this.db.delete(sessionDisconnectNodes).where(lt(sessionDisconnectNodes.seenAt, before));
  }
}

const nodeSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
/** Seconds to hold the poll open when there is nothing (25 by default). */
const waitSchema = z.coerce.number().int().min(0).max(LONG_POLL_MS / 1000).default(LONG_POLL_MS / 1000);
const ackSchema = z.object({ node: nodeSchema, last: z.coerce.number().int().min(0) });

/**
 * For the Cyrus containers (internal listener, mail-auth secret): which mail
 * logins to disconnect, as "<id> <address>" lines, and the acknowledgement.
 * The API never reaches into the mail containers; they ask.
 */
@Controller('internal/sessions/disconnects')
@Public()
@UseGuards(InternalTokenGuard)
export class SessionDisconnectsController {
  constructor(@Inject(SessionDisconnectsService) private readonly disconnects: SessionDisconnectsService) {}

  @Get()
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('cache-control', 'no-store')
  async pending(
    @Query('node', new ZodValidationPipe(nodeSchema)) node: string,
    @Query('wait', new ZodValidationPipe(waitSchema)) wait: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const rows = await this.disconnects.pending(node, wait * 1000, abort.signal);
    return rows.map((row) => `${row.id} ${row.username}\n`).join('');
  }

  @Post('ack')
  @HttpCode(204)
  async acknowledge(@Body(new ZodValidationPipe(ackSchema)) body: z.infer<typeof ackSchema>): Promise<void> {
    await this.disconnects.acknowledge(body.node, body.last);
  }
}

@Module({
  controllers: [SessionDisconnectsController],
  providers: [SessionDisconnectsService],
  exports: [SessionDisconnectsService],
})
export class SessionDisconnectsModule {}
