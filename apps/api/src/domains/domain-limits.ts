import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { aliases, type DomainRow, domains, mailboxes } from '../db/schema/index.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/** What a domain currently holds, measured against its limits. */
export interface DomainUsage {
  mailboxes: number;
  aliases: number;
  /** Sum of the mailboxes' quotas (unlimited ones count as 0). */
  quotaBytes: number;
  /** Mailboxes without a quota. */
  unlimitedMailboxes: number;
}

type Executor = Pick<Database, 'select'>;

export async function domainUsage(db: Executor, domainId: string): Promise<DomainUsage> {
  const [boxes] = await db
    .select({
      n: count(),
      quota: sql<string>`coalesce(sum(${mailboxes.quotaBytes}), 0)`,
      unlimited: sql<number>`count(*) filter (where ${mailboxes.quotaBytes} is null)::int`,
    })
    .from(mailboxes)
    .where(eq(mailboxes.domainId, domainId));
  const [als] = await db.select({ n: count() }).from(aliases).where(eq(aliases.domainId, domainId));
  return {
    mailboxes: boxes?.n ?? 0,
    aliases: als?.n ?? 0,
    quotaBytes: Number(boxes?.quota ?? 0),
    unlimitedMailboxes: boxes?.unlimited ?? 0,
  };
}

/**
 * Locks the organization's domain row for the rest of the transaction, so
 * concurrent creations are counted one after the other, and returns it with
 * its usage. Undefined if the domain is not the organization's.
 */
export async function lockDomain(
  tx: Executor,
  ctx: TenantContext,
  domainId: string,
): Promise<{ domain: DomainRow; usage: DomainUsage } | undefined> {
  const [domain] = await tx
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.organizationId, ctx.organizationId)))
    .for('update');
  if (!domain) return undefined;
  return { domain, usage: await domainUsage(tx, domainId) };
}

function limitReached(message: string, code: string): ConflictException {
  return new ConflictException({ message, code });
}

/** Mailboxes and aliases live on the target domain; an alias domain repeats them. */
export function aliasDomainRefusal(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'This is an alias domain: add mailboxes and aliases to the domain it repeats',
    code: 'ALIAS_DOMAIN',
  });
}

export function assertMayAddMailbox(domain: DomainRow, usage: DomainUsage): void {
  if (domain.maxMailboxes !== null && usage.mailboxes >= domain.maxMailboxes) {
    throw limitReached(
      `${domain.name} already has its maximum of ${domain.maxMailboxes} mailboxes`,
      'DOMAIN_MAILBOX_LIMIT',
    );
  }
}

export function assertMayAddAlias(domain: DomainRow, usage: DomainUsage): void {
  if (domain.maxAliases !== null && usage.aliases >= domain.maxAliases) {
    throw limitReached(`${domain.name} already has its maximum of ${domain.maxAliases} aliases`, 'DOMAIN_ALIAS_LIMIT');
  }
}

/**
 * Checks a mailbox's new quota against the domain's limits. `previous` is the
 * mailbox's current quota when it is changed, undefined when it is created.
 */
export function assertQuotaFits(
  domain: DomainRow,
  usage: DomainUsage,
  quota: number | null,
  previous?: number | null,
): void {
  const max = domain.maxMailboxQuotaBytes;
  if (max !== null && (quota === null || quota > max)) {
    throw new UnprocessableEntityException({
      message: `Mailboxes of ${domain.name} may have at most ${formatBytes(max)}`,
      code: 'MAILBOX_QUOTA_TOO_LARGE',
    });
  }
  const total = domain.totalQuotaBytes;
  if (total === null) return;
  if (quota === null) {
    throw new UnprocessableEntityException({
      message: `${domain.name} has a total quota, so its mailboxes need a quota`,
      code: 'MAILBOX_QUOTA_REQUIRED',
    });
  }
  const after = usage.quotaBytes - (previous ?? 0) + quota;
  if (after > total) {
    const free = Math.max(0, total - usage.quotaBytes + (previous ?? 0));
    throw limitReached(
      `${domain.name} has ${formatBytes(free)} of its ${formatBytes(total)} total quota left`,
      'DOMAIN_QUOTA_EXCEEDED',
    );
  }
}

export interface DomainLimits {
  maxMailboxes: number | null;
  maxAliases: number | null;
  maxMailboxQuotaBytes: number | null;
  totalQuotaBytes: number | null;
  defaultMailboxQuotaBytes: number | null;
}

/** New limits must hold for what the domain already has, and for new mailboxes. */
export function assertLimitsHold(name: string, limits: DomainLimits, usage: DomainUsage, largestQuota: number | null): void {
  const fail = (message: string) => {
    throw new ConflictException({ message, code: 'DOMAIN_LIMIT_BELOW_USAGE' });
  };
  if (limits.maxMailboxes !== null && limits.maxMailboxes < usage.mailboxes) {
    fail(`${name} already has ${usage.mailboxes} mailboxes`);
  }
  if (limits.maxAliases !== null && limits.maxAliases < usage.aliases) {
    fail(`${name} already has ${usage.aliases} aliases`);
  }
  if (limits.maxMailboxQuotaBytes !== null || limits.totalQuotaBytes !== null) {
    if (usage.unlimitedMailboxes > 0) {
      fail(`${usage.unlimitedMailboxes} mailboxes of ${name} have no quota; give them one first`);
    }
  }
  if (limits.maxMailboxQuotaBytes !== null && largestQuota !== null && largestQuota > limits.maxMailboxQuotaBytes) {
    fail(`A mailbox of ${name} already has ${formatBytes(largestQuota)}`);
  }
  if (limits.totalQuotaBytes !== null && usage.quotaBytes > limits.totalQuotaBytes) {
    fail(`The mailboxes of ${name} already have ${formatBytes(usage.quotaBytes)} together`);
  }
  const fallback = limits.defaultMailboxQuotaBytes;
  if (limits.maxMailboxQuotaBytes !== null && (fallback === null || fallback > limits.maxMailboxQuotaBytes)) {
    throw new UnprocessableEntityException({
      message: 'The default mailbox quota must be set, and fit within the largest mailbox quota',
      code: 'DEFAULT_QUOTA_INVALID',
    });
  }
  if (limits.totalQuotaBytes !== null && (fallback === null || fallback > limits.totalQuotaBytes)) {
    throw new UnprocessableEntityException({
      message: 'With a total quota, the default mailbox quota must be set, and fit within it',
      code: 'DEFAULT_QUOTA_INVALID',
    });
  }
}

export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}
