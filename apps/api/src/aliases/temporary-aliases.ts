import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Param,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { type AuthSession, CurrentSession } from '../auth/session.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { DATABASE, ENV } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { aliases, type AliasRow, domains, mailboxes } from '../db/schema/index.js';
import { assertMayAddAlias } from '../domains/domain-limits.js';
import { findOwnMailbox } from '../jmap/my-mailbox.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { AliasesRepository } from './aliases.repository.js';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const MAX_PER_MAILBOX = 50;
const CLEANUP_MS = 60 * 60 * 1000;

const lifetimeSchema = z.strictObject({
  /** Hours it works: up to a year. */
  hours: z.number().int().min(1).max(24 * 365),
  /** What it is for, to recognize it later. */
  note: z.string().trim().max(100).default(''),
});

export interface TemporaryAliasDto {
  id: string;
  address: string;
  note: string;
  expiresAt: string;
  createdAt: string;
}

const toDto = (row: AliasRow): TemporaryAliasDto => ({
  id: row.id,
  address: row.address,
  note: row.note,
  expiresAt: row.expiresAt!.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/**
 * Temporary addresses people make for themselves (a shop, a newsletter, a
 * one-off sign-up): an alias on their own domain that delivers to their
 * mailbox until it expires, then is deleted. They count against the
 * domain's alias limit.
 */
@Injectable()
export class TemporaryAliasesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TemporaryAliasesService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(AliasesRepository) private readonly repository: AliasesRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.deleteExpired(), CLEANUP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async deleteExpired(now = new Date()): Promise<number> {
    try {
      const deleted = await this.db
        .delete(aliases)
        .where(and(isNotNull(aliases.expiresAt), lt(aliases.expiresAt, now)))
        .returning({ id: aliases.id });
      return deleted.length;
    } catch (error) {
      this.logger.error(`Cannot delete expired temporary addresses: ${(error as Error).message}`);
      return 0;
    }
  }

  private async mine(session: AuthSession) {
    const address = await findOwnMailbox(this.db, session.user.id);
    if (!address) throw new NotFoundException('You have no mailbox');
    const [row] = await this.db
      .select({ id: mailboxes.id, address: mailboxes.address, organizationId: mailboxes.organizationId, domainId: mailboxes.domainId })
      .from(mailboxes)
      .where(eq(mailboxes.address, address));
    if (!row) throw new NotFoundException('You have no mailbox');
    const ctx: TenantContext = {
      organizationId: row.organizationId,
      userId: session.user.id,
      userEmail: session.user.email,
      ipAddress: null,
      role: 'member',
      viaSuperAdmin: false,
      instanceAdmin: false,
    };
    return { ...row, ctx };
  }

  async list(session: AuthSession): Promise<TemporaryAliasDto[]> {
    const me = await this.mine(session);
    const rows = await this.db
      .select()
      .from(aliases)
      .where(and(eq(aliases.ownerMailboxId, me.id), isNotNull(aliases.expiresAt)))
      .orderBy(asc(aliases.expiresAt));
    return rows.filter((r) => r.expiresAt! > new Date()).map(toDto);
  }

  async create(session: AuthSession, input: z.infer<typeof lifetimeSchema>): Promise<TemporaryAliasDto> {
    const me = await this.mine(session);
    const existing = await this.list(session);
    if (existing.length >= MAX_PER_MAILBOX) throw new UnprocessableEntityException(`At most ${MAX_PER_MAILBOX} temporary addresses`);
    const [domain] = await this.db.select({ name: domains.name }).from(domains).where(eq(domains.id, me.domainId));
    for (let attempt = 0; attempt < 5; attempt++) {
      const localPart = `tmp.${Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
      const address = `${localPart}@${domain!.name}`;
      try {
        const row = await this.repository.create(
          me.ctx,
          { domainId: me.domainId, localPart, address, destinations: [me.address], enabled: true, discard: false },
          assertMayAddAlias,
        );
        const [updated] = await this.db
          .update(aliases)
          .set({ expiresAt: new Date(Date.now() + input.hours * 3600_000), ownerMailboxId: me.id, note: input.note })
          .where(eq(aliases.id, row.id))
          .returning();
        return toDto(updated!);
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
      }
    }
    throw new Error('Could not find a free address');
  }

  async extend(session: AuthSession, id: string, hours: number): Promise<TemporaryAliasDto> {
    const me = await this.mine(session);
    const [row] = await this.db
      .update(aliases)
      .set({ expiresAt: new Date(Date.now() + hours * 3600_000) })
      .where(and(eq(aliases.id, id), eq(aliases.ownerMailboxId, me.id), isNotNull(aliases.expiresAt)))
      .returning();
    if (!row) throw new NotFoundException('Temporary address not found');
    return toDto(row);
  }

  async remove(session: AuthSession, id: string): Promise<void> {
    const me = await this.mine(session);
    const deleted = await this.db
      .delete(aliases)
      .where(and(eq(aliases.id, id), eq(aliases.ownerMailboxId, me.id), isNotNull(aliases.expiresAt)))
      .returning({ id: aliases.id });
    if (deleted.length === 0) throw new NotFoundException('Temporary address not found');
  }
}

const idPipe = new ZodValidationPipe(z.uuid());

@Controller('me/temporary-addresses')
export class TemporaryAliasesController {
  constructor(@Inject(TemporaryAliasesService) private readonly temporary: TemporaryAliasesService) {}

  @Get()
  async list(@CurrentSession() session: AuthSession): Promise<{ data: TemporaryAliasDto[] }> {
    return { data: await this.temporary.list(session) };
  }

  @Post()
  create(
    @CurrentSession() session: AuthSession,
    @Body(new ZodValidationPipe(lifetimeSchema)) body: z.infer<typeof lifetimeSchema>,
  ): Promise<TemporaryAliasDto> {
    return this.temporary.create(session, body);
  }

  /** Works for `hours` more, from now. */
  @Patch(':id')
  extend(
    @CurrentSession() session: AuthSession,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(z.strictObject({ hours: lifetimeSchema.shape.hours }))) body: { hours: number },
  ): Promise<TemporaryAliasDto> {
    return this.temporary.extend(session, id, body.hours);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() session: AuthSession, @Param('id', idPipe) id: string): Promise<void> {
    await this.temporary.remove(session, id);
  }
}
