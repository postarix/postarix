import { z } from 'zod';
import { type DomainRow } from '../db/schema/index.js';
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
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;

export const domainLimitFields = ['maxMailboxes', 'maxAliases', 'maxMailboxQuotaBytes', 'totalQuotaBytes'] as const;

export interface DomainDto {
  id: string;
  name: string;
  status: DomainRow['status'];
  /** Value to publish as a DNS TXT record to prove ownership. */
  verificationRecord: string;
  verifiedAt: string | null;
  description: string;
  defaultMailboxQuotaBytes: number | null;
  limits: {
    maxMailboxes: number | null;
    maxAliases: number | null;
    maxMailboxQuotaBytes: number | null;
    totalQuotaBytes: number | null;
  };
  usage: DomainUsage;
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
    description: row.description,
    defaultMailboxQuotaBytes: row.defaultMailboxQuotaBytes,
    limits: {
      maxMailboxes: row.maxMailboxes,
      maxAliases: row.maxAliases,
      maxMailboxQuotaBytes: row.maxMailboxQuotaBytes,
      totalQuotaBytes: row.totalQuotaBytes,
    },
    usage,
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
