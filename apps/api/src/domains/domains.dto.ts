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
  createdAt: string;
  updatedAt: string;
}

export function toDomainDto(row: DomainRow): DomainDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
