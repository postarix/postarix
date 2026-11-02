import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { ssoProvider, user } from '../db/schema/index.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type SsoProviderRow = typeof ssoProvider.$inferSelect;

/**
 * Better Auth requires an owning user for every provider and deletes the
 * provider with that user. Providers belong to organizations, not to the
 * person who set them up, so they are all owned by this account instead. It
 * has no password and is banned, so nobody can sign in with it.
 */
export const SYSTEM_USER_ID = 'postarix-system';
const SYSTEM_USER_EMAIL = 'system@postarix.invalid';

@Injectable()
export class SsoRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  list(ctx: TenantContext): Promise<SsoProviderRow[]> {
    return this.db
      .select()
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, ctx.organizationId))
      .orderBy(asc(ssoProvider.domain));
  }

  async findById(ctx: TenantContext, id: string): Promise<SsoProviderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ssoProvider)
      .where(and(eq(ssoProvider.organizationId, ctx.organizationId), eq(ssoProvider.id, id)))
      .limit(1);
    return row;
  }

  /** Any organization's provider for a domain: sign-in finds providers by domain, so there is one per domain. */
  async existsForDomain(domain: string): Promise<boolean> {
    const rows = await this.db.select({ id: ssoProvider.id }).from(ssoProvider).where(eq(ssoProvider.domain, domain)).limit(1);
    return rows.length > 0;
  }

  async create(
    ctx: TenantContext,
    values: { providerId: string; issuer: string; domain: string; oidcConfig: string },
  ): Promise<SsoProviderRow> {
    await this.ensureSystemUser();
    const [row] = await this.db
      .insert(ssoProvider)
      .values({ id: crypto.randomUUID(), ...values, organizationId: ctx.organizationId, userId: SYSTEM_USER_ID })
      .returning();
    return row!;
  }

  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(ssoProvider)
      .where(and(eq(ssoProvider.organizationId, ctx.organizationId), eq(ssoProvider.id, id)))
      .returning({ id: ssoProvider.id });
    return rows.length > 0;
  }

  async deleteAll(ctx: TenantContext): Promise<number> {
    const rows = await this.db
      .delete(ssoProvider)
      .where(eq(ssoProvider.organizationId, ctx.organizationId))
      .returning({ id: ssoProvider.id });
    return rows.length;
  }

  /**
   * Instance maintenance (not tenant data access): rewrites every provider's
   * stored config with `seal`, for providers saved before client secrets were
   * encrypted. Returns how many rows changed.
   */
  async resealAll(seal: (stored: string) => string): Promise<number> {
    let changed = 0;
    for (const row of await this.db.select({ id: ssoProvider.id, oidcConfig: ssoProvider.oidcConfig }).from(ssoProvider)) {
      if (!row.oidcConfig) continue;
      const sealed = seal(row.oidcConfig);
      if (sealed === row.oidcConfig) continue;
      await this.db.update(ssoProvider).set({ oidcConfig: sealed }).where(eq(ssoProvider.id, row.id));
      changed++;
    }
    return changed;
  }

  private async ensureSystemUser(): Promise<void> {
    const now = new Date();
    await this.db
      .insert(user)
      .values({
        id: SYSTEM_USER_ID,
        name: 'Postarix',
        email: SYSTEM_USER_EMAIL,
        emailVerified: false,
        banned: true,
        banReason: 'System account that owns single sign-on providers',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}
