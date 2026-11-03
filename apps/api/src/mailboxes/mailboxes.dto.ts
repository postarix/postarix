import { z } from 'zod';
import { normalizeAddress, normalizeLocalPart } from '../common/addresses.js';
import { normalizeDomainName } from '../domains/domain-name.js';
import { type RateLimit, rateLimitSchema, toRateLimit } from '../rate-limits/rate-limits.js';
import { type MailboxRow, mailboxKinds, mailboxStatuses, mailProtocols } from '../db/schema/index.js';

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
  /** Omitted: the domain's default quota. Null: unlimited (where the domain allows it). */
  quotaBytes: quotaSchema.optional(),
  /** A room or equipment: invitations to it are answered by itself (see CalendarService). */
  kind: z.enum(mailboxKinds).default('person'),
});
export type CreateMailboxInput = z.infer<typeof createMailboxSchema>;

export const updateMailboxSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    quotaBytes: quotaSchema.optional(),
    status: z.enum(mailboxStatuses).optional(),
    kind: z.enum(mailboxKinds).optional(),
    /** Mail protocols it may sign in with; the webmail always works. */
    allowedProtocols: z
      .array(z.enum(mailProtocols))
      .max(mailProtocols.length)
      .transform((list) => [...new Set(list)])
      .optional(),
    tlsRequiredIn: z.boolean().optional(),
    tlsRequiredOut: z.boolean().optional(),
    /** Messages it may send per period; null: its domain's limit. */
    rateLimit: rateLimitSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type UpdateMailboxInput = z.infer<typeof updateMailboxSchema>;

export const setPasswordSchema = z.strictObject({ password: passwordSchema });

export const mailboxIdSchema = z.uuid();

/** An address, or "@domain" for every address of a domain. */
const senderSchema = z
  .string()
  .max(320)
  .transform((value, ctx) => {
    const trimmed = value.trim().toLowerCase();
    const normalized = trimmed.startsWith('@')
      ? (() => {
          const domain = normalizeDomainName(trimmed.slice(1));
          return domain === null ? null : `@${domain}`;
        })()
      : normalizeAddress(trimmed);
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'Use an address, or @domain for all its addresses' });
      return z.NEVER;
    }
    return normalized;
  });

export const sendAsSchema = z.strictObject({
  senders: z.array(senderSchema).max(200).transform((list) => [...new Set(list)]),
});
export type SendAsInput = z.infer<typeof sendAsSchema>;

export interface MailboxDto {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  displayName: string;
  quotaBytes: number | null;
  status: MailboxRow['status'];
  kind: MailboxRow['kind'];
  allowedProtocols: MailboxRow['allowedProtocols'];
  tlsRequiredIn: boolean;
  tlsRequiredOut: boolean;
  rateLimit: RateLimit | null;
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
    kind: row.kind,
    allowedProtocols: row.allowedProtocols,
    tlsRequiredIn: row.tlsRequiredIn,
    tlsRequiredOut: row.tlsRequiredOut,
    rateLimit: toRateLimit(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
