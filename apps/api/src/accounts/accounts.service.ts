import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Auth } from '../auth/auth.js';
import { hasInstanceAdminRole } from '../auth/roles.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { AUTH, DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { account, session, user } from '../db/schema/index.js';

export interface AccountSummary {
  id: string;
  email: string;
  banned: boolean;
  twoFactorEnabled: boolean;
  /** Holds the instance administrator role. */
  instanceAdmin: boolean;
}

/** User-account operations the mail features need, on top of Better Auth. */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** Creates a regular user with email/password credentials. Throws 409 if the email is taken. */
  async create(input: { email: string; password: string; name: string }): Promise<string> {
    const [existing] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, input.email))
      .limit(1);
    if (existing) throw new ConflictException('This address is already in use');

    const { user: created } = await this.auth.api.createUser({
      body: { email: input.email, password: input.password, name: input.name, role: 'user' },
    });
    return created.id;
  }

  async find(userId: string): Promise<AccountSummary | undefined> {
    const [row] = await this.db
      .select({
        id: user.id,
        email: user.email,
        banned: user.banned,
        twoFactorEnabled: user.twoFactorEnabled,
        role: user.role,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!row) return undefined;
    const { role, ...rest } = row;
    return {
      ...rest,
      banned: row.banned ?? false,
      twoFactorEnabled: row.twoFactorEnabled ?? false,
      instanceAdmin: hasInstanceAdminRole(role),
    };
  }

  async rename(userId: string, name: string): Promise<void> {
    await this.db.update(user).set({ name }).where(eq(user.id, userId));
  }

  /** Replaces the account password and signs the user out everywhere. */
  async setPassword(userId: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      await tx
        .update(account)
        .set({ password: passwordHash })
        .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
      await tx.delete(session).where(eq(session.userId, userId));
    });
  }

  /** Checks the account (web) password. */
  async verifyAccountPassword(userId: string, password: string): Promise<boolean> {
    const [row] = await this.db
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
      .limit(1);
    if (!row?.password) return false;
    return verifyPassword(row.password, password);
  }

  /** Deletes the user; sessions, memberships and app passwords cascade. */
  async delete(userId: string): Promise<void> {
    await this.db.delete(user).where(eq(user.id, userId));
  }
}
