import { z } from 'zod';
import { normalizeAddress } from '../common/addresses.js';
import type { AliasRow } from '../db/schema/index.js';
import { localPartSchema } from '../mailboxes/mailboxes.dto.js';

const MAX_DESTINATIONS = 50;

const destinationsSchema = z
  .array(z.string().max(320))
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

export const createAliasSchema = z
  .strictObject({
    domainId: z.uuid(),
    /** Empty: a catch-all, for every address of the domain that is not a mailbox or another alias. */
    localPart: z.literal('').or(localPartSchema),
    destinations: destinationsSchema.default([]),
    enabled: z.boolean().default(true),
    /** Accept and drop the mail. */
    discard: z.boolean().default(false),
  })
  .refine((value) => value.discard || value.destinations.length > 0, {
    message: 'Add at least one destination',
    path: ['destinations'],
  });
export type CreateAliasInput = z.infer<typeof createAliasSchema>;

export const updateAliasSchema = z
  .strictObject({
    destinations: destinationsSchema.optional(),
    enabled: z.boolean().optional(),
    discard: z.boolean().optional(),
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
  discard: boolean;
  catchAll: boolean;
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
    discard: row.discard,
    catchAll: row.localPart === '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
