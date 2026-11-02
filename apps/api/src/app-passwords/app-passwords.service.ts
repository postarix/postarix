import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { isUniqueViolation } from '../common/pg-errors.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import {
  type AppPasswordRow,
  type AppPasswordScope,
  appPasswords,
  appPasswordScopes,
} from '../db/schema/index.js';
import {
  generateAppPassword,
  LOOKUP_PREFIX_LENGTH,
  normalizeAppPassword,
} from './app-password-format.js';

const MAX_PER_USER = 50;

export const createAppPasswordSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  scopes: z
    .array(z.enum(appPasswordScopes))
    .min(1)
    .transform((scopes) => [...new Set(scopes)]),
});
export type CreateAppPasswordInput = z.infer<typeof createAppPasswordSchema>;

export interface AppPasswordDto {
  id: string;
  name: string;
  scopes: AppPasswordScope[];
  lastUsedAt: string | null;
  createdAt: string;
}

function toDto(row: AppPasswordRow): AppPasswordDto {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * App passwords belong to a user, not an organization: every query is scoped
 * by the authenticated user's ID.
 */
@Injectable()
export class AppPasswordsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(userId: string): Promise<AppPasswordDto[]> {
    const rows = await this.db
      .select()
      .from(appPasswords)
      .where(eq(appPasswords.userId, userId))
      .orderBy(asc(appPasswords.createdAt));
    return rows.map(toDto);
  }

  /** Creates an app password. The plain value is returned only here, once. */
  async create(
    userId: string,
    input: CreateAppPasswordInput,
  ): Promise<AppPasswordDto & { password: string }> {
    const [existing] = await this.db
      .select({ total: count() })
      .from(appPasswords)
      .where(eq(appPasswords.userId, userId));
    if ((existing?.total ?? 0) >= MAX_PER_USER) {
      throw new UnprocessableEntityException(`You can have at most ${MAX_PER_USER} app passwords`);
    }

    const { raw, display } = generateAppPassword();
    try {
      const [row] = await this.db
        .insert(appPasswords)
        .values({
          userId,
          name: input.name,
          scopes: input.scopes,
          lookupPrefix: raw.slice(0, LOOKUP_PREFIX_LENGTH),
          passwordHash: await hashPassword(raw),
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return { ...toDto(row), password: display };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('You already have an app password with this name');
      }
      throw error;
    }
  }

  async revoke(userId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(appPasswords)
      .where(and(eq(appPasswords.userId, userId), eq(appPasswords.id, id)))
      .returning({ id: appPasswords.id });
    if (deleted.length === 0) throw new NotFoundException('App password not found');
  }

  /**
   * Checks a candidate password against the user's app passwords that carry
   * the given scope. Records the use on success.
   */
  async verify(userId: string, candidate: string, scope: AppPasswordScope): Promise<boolean> {
    const raw = normalizeAppPassword(candidate);
    if (raw === null) return false;

    const rows = await this.db
      .select()
      .from(appPasswords)
      .where(
        and(
          eq(appPasswords.userId, userId),
          eq(appPasswords.lookupPrefix, raw.slice(0, LOOKUP_PREFIX_LENGTH)),
        ),
      );
    for (const row of rows) {
      if (!row.scopes.includes(scope)) continue;
      if (await verifyPassword(row.passwordHash, raw)) {
        await this.db
          .update(appPasswords)
          .set({ lastUsedAt: new Date() })
          .where(eq(appPasswords.id, row.id));
        return true;
      }
    }
    return false;
  }
}
