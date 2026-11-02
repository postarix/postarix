import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { aliases, mailboxes } from '../db/schema/index.js';

/**
 * Global address uniqueness across mailboxes and aliases.
 *
 * Deliberately not tenant-scoped: an address must be unique on the whole
 * instance. Callers only check addresses on active domains their organization
 * owns, so the answer never reveals another tenant's data.
 */
@Injectable()
export class AddressRegistry {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async isTaken(address: string): Promise<boolean> {
    const [mailbox] = await this.db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.address, address))
      .limit(1);
    if (mailbox) return true;
    const [alias] = await this.db
      .select({ id: aliases.id })
      .from(aliases)
      .where(eq(aliases.address, address))
      .limit(1);
    return alias !== undefined;
  }
}
