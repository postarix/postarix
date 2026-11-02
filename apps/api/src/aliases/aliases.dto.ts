import { z } from 'zod';
import { normalizeAddress } from '../common/addresses.js';
import type { AliasRow } from '../db/schema/index.js';
import { localPartSchema } from '../mailboxes/mailboxes.dto.js';

const MAX_DESTINATIONS = 50;

const destinationsSchema = z
  .array(z.string().max(320))
  .min(1)
  .max(MAX_DESTINATIONS)
  .transform((values, ctx) => {
    const normalized: string[] = [];
    for (const [index, value] of values.entries()) {
      const address = normalizeAddress(value);
      if (address === null) {
        ctx.addIssue({ code: 'custom', path: [index], message: 'Invalid email address' });
        return z.NEVER;
      }
      if (!normalized.includes(address)) normalized.push(address);
    }
    return normalized;
  });

export const createAliasSchema = z.strictObject({
  domainId: z.uuid(),
  localPart: localPartSchema,
  destinations: destinationsSchema,
  enabled: z.boolean().default(true),
});
export type CreateAliasInput = z.infer<typeof createAliasSchema>;

export const updateAliasSchema = z
  .strictObject({
    destinations: destinationsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateAliasInput = z.infer<typeof updateAliasSchema>;

export const aliasIdSchema = z.uuid();

export interface AliasDto {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  destinations: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toAliasDto(row: AliasRow): AliasDto {
  return {
    id: row.id,
    domainId: row.domainId,
    address: row.address,
    localPart: row.localPart,
    destinations: row.destinations,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
