import { z } from 'zod';
import { type DomainRow } from '../db/schema/index.js';
import { type RateLimit, rateLimitSchema, toRateLimit } from '../rate-limits/rate-limits.js';
import type { DomainUsage } from './domain-limits.js';
import { normalizeDomainName } from './domain-name.js';

export const createDomainSchema = z.strictObject({
  name: z
    .string()
    .max(300)
    .transform((value, ctx) => {
      const normalized = normalizeDomainName(value);
      if (normalized === null) {
        ctx.addIssue({ code: 'custom', message: 'Invalid domain name' });
        return z.NEVER;
      }
      return normalized;
    }),
  /** Makes it an alias domain of this domain of the organization. */
  aliasOf: z.uuid().optional(),
});

export type CreateDomainInput = z.infer<typeof createDomainSchema>;

export const domainIdSchema = z.uuid();

const MIN_QUOTA = 1024 * 1024; // 1 MiB
const MAX_QUOTA = 1024 ** 5; // 1 PiB
const quotaSchema = z.number().int().min(MIN_QUOTA).max(MAX_QUOTA).nullable();
const countSchema = z.number().int().min(0).max(1_000_000).nullable();

/**
 * Changes to a domain. Organization administrators set the description, the
 * default quota and whether the domain is enabled; the limits are for instance
 * administrators (who host the organization) only.
 */
export const updateDomainSchema = z
  .strictObject({
    description: z.string().trim().max(500).optional(),
    /** A disabled domain neither receives nor sends mail, and its mailboxes cannot sign in to mail apps. */
    enabled: z.boolean().optional(),
    defaultMailboxQuotaBytes: quotaSchema.optional(),
    maxMailboxes: countSchema.optional(),
    maxAliases: countSchema.optional(),
    maxMailboxQuotaBytes: quotaSchema.optional(),
    totalQuotaBytes: quotaSchema.optional(),
    /** Messages each mailbox may send per period, unless it has its own limit. */
    rateLimit: rateLimitSchema.optional(),
    /** Smart host for the domain's mail (instance administrators only). */
    relayHostId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;

/**
 * A new DKIM key: generated (of the given size) or imported (a PEM private
 * key the domain already publishes elsewhere). The selector is the DNS label
 * before "._domainkey".
 */
export const replaceDkimSchema = z
  .strictObject({
    selector: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Use letters, digits and hyphens')
      .optional(),
    keyBits: z.union([z.literal(1024), z.literal(2048), z.literal(3072), z.literal(4096)]).optional(),
    privateKey: z.string().max(20_000).optional(),
  })
  .refine((value) => !(value.privateKey && value.keyBits), 'Choose a key size or import a key, not both');
export type ReplaceDkimInput = z.infer<typeof replaceDkimSchema>;

export interface DkimKeyDto {
  selector: string;
  bits: number | null;
  /** The DNS TXT record to publish at <selector>._domainkey.<domain>. */
  record: { name: string; value: string };
  createdAt: string;
}

export const domainLimitFields = ['maxMailboxes', 'maxAliases', 'maxMailboxQuotaBytes', 'totalQuotaBytes', 'relayHostId'] as const;

export interface DomainDto {
  id: string;
  name: string;
  status: DomainRow['status'];
  /** Value to publish as a DNS TXT record to prove ownership. */
  verificationRecord: string;
  verifiedAt: string | null;
  /** Set for an alias domain: the domain whose addresses it repeats. */
  aliasOfDomainId: string | null;
  description: string;
  defaultMailboxQuotaBytes: number | null;
  limits: {
    maxMailboxes: number | null;
    maxAliases: number | null;
    maxMailboxQuotaBytes: number | null;
    totalQuotaBytes: number | null;
  };
  usage: DomainUsage;
  rateLimit: RateLimit | null;
  relayHostId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDomainDto(row: DomainRow, usage: DomainUsage): DomainDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    verificationRecord: `postarix-verification=${row.verificationToken}`,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    aliasOfDomainId: row.aliasOfDomainId,
    description: row.description,
    defaultMailboxQuotaBytes: row.defaultMailboxQuotaBytes,
    limits: {
      maxMailboxes: row.maxMailboxes,
      maxAliases: row.maxAliases,
      maxMailboxQuotaBytes: row.maxMailboxQuotaBytes,
      totalQuotaBytes: row.totalQuotaBytes,
    },
    usage,
    rateLimit: toRateLimit(row),
    relayHostId: row.relayHostId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DnsRecordDto {
  purpose: 'verification' | 'mx' | 'spf' | 'dkim' | 'dmarc' | 'autoconfig' | 'mta-sts' | 'mta-sts-id';
  type: 'TXT' | 'MX' | 'CNAME';
  name: string;
  value: string;
}
