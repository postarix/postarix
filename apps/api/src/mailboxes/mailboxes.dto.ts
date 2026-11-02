import { z } from 'zod';
import { normalizeLocalPart } from '../common/addresses.js';
import { type MailboxRow, mailboxStatuses } from '../db/schema/index.js';

const MIN_QUOTA = 1024 * 1024; // 1 MiB
const MAX_QUOTA = 1024 ** 4; // 1 TiB

export const localPartSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const normalized = normalizeLocalPart(value);
    if (normalized === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use lowercase letters, digits, ".", "-" or "_" (not at the start or end)',
      });
      return z.NEVER;
    }
    return normalized;
  });

const quotaSchema = z.number().int().min(MIN_QUOTA).max(MAX_QUOTA).nullable();
const displayNameSchema = z.string().trim().max(128);
export const passwordSchema = z.string().min(12).max(256);

export const createMailboxSchema = z.strictObject({
  domainId: z.uuid(),
  localPart: localPartSchema,
  displayName: displayNameSchema.default(''),
  password: passwordSchema,
  quotaBytes: quotaSchema.default(null),
});
export type CreateMailboxInput = z.infer<typeof createMailboxSchema>;

export const updateMailboxSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    quotaBytes: quotaSchema.optional(),
    status: z.enum(mailboxStatuses).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateMailboxInput = z.infer<typeof updateMailboxSchema>;

export const setPasswordSchema = z.strictObject({ password: passwordSchema });

export const mailboxIdSchema = z.uuid();

export interface MailboxDto {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  displayName: string;
  quotaBytes: number | null;
  status: MailboxRow['status'];
  createdAt: string;
  updatedAt: string;
}

export function toMailboxDto(row: MailboxRow): MailboxDto {
  return {
    id: row.id,
    domainId: row.domainId,
    address: row.address,
    localPart: row.localPart,
    displayName: row.displayName,
    quotaBytes: row.quotaBytes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
