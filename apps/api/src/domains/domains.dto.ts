import { z } from 'zod';
import { type DomainRow } from '../db/schema/index.js';
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

export interface DomainDto {
  id: string;
  name: string;
  status: DomainRow['status'];
  /** Value to publish as a DNS TXT record to prove ownership. */
  verificationRecord: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDomainDto(row: DomainRow): DomainDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    verificationRecord: `postarix-verification=${row.verificationToken}`,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
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
