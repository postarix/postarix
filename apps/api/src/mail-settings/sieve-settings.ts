import { z } from 'zod';

/** The Sieve script the webmail manages for a mailbox (automatic reply and forwarding). */
export const SETTINGS_SCRIPT = 'postarix-settings';

const singleLine = (max: number) => z.string().trim().max(max).regex(/^[^\r\n]*$/, 'Use a single line');

const filterSchema = z
  .strictObject({
    /** What to look at: the sender, the recipients (To and Cc) or the subject. */
    field: z.enum(['from', 'to', 'subject']),
    /** Text to look for (case-insensitive, anywhere in the field). */
    contains: singleLine(200).min(1),
    action: z.enum(['move', 'markRead', 'label', 'delete']),
    /** The folder for "move" (its name, e.g. "Lists" or "Work/Clients"). */
    folder: singleLine(200).optional(),
    /** The label keyword for "label". */
    keyword: z
      .string()
      .regex(/^label-[a-z0-9-]{1,40}$/)
      .optional(),
  })
  .superRefine((filter, ctx) => {
    if (filter.action === 'move' && !filter.folder) ctx.addIssue({ code: 'custom', path: ['folder'], message: 'Choose a folder' });
    if (filter.action === 'label' && !filter.keyword) ctx.addIssue({ code: 'custom', path: ['keyword'], message: 'Choose a label' });
  });

export type MailFilter = z.infer<typeof filterSchema>;

export const mailSettingsSchema = z
  .strictObject({
    /** Rules applied to arriving mail, in order (at most 50). */
    filters: z.array(filterSchema).max(50).default([]),
    vacation: z.strictObject({
      enabled: z.boolean(),
      subject: singleLine(200),
      message: z.string().max(5000),
      /** Last day the reply is sent (inclusive), or null for no end. */
      until: z.iso.date().nullable(),
    }),
    forwarding: z.strictObject({
      enabled: z.boolean(),
      address: z.union([z.literal(''), z.email().max(254)]),
      keepCopy: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.vacation.enabled && value.vacation.message.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['vacation', 'message'], message: 'Write the reply' });
    }
    if (value.forwarding.enabled && value.forwarding.address === '') {
      ctx.addIssue({ code: 'custom', path: ['forwarding', 'address'], message: 'Enter the address to forward to' });
    }
  });

export type MailSettings = z.infer<typeof mailSettingsSchema>;

export const DEFAULT_SETTINGS: MailSettings = {
  filters: [],
  vacation: { enabled: false, subject: 'Out of office', message: '', until: null },
  forwarding: { enabled: false, address: '', keepCopy: true },
};

const MARKER = '# Postarix settings:';

/** A Sieve quoted string (RFC 5228): backslashes and quotes escaped; line breaks allowed. */
function quoted(text: string): string {
  return `"${text.replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The script for these settings, or null when nothing is switched on. */
function filterTest(filter: MailFilter): string {
  const headers = filter.field === 'from' ? '"from"' : filter.field === 'to' ? '["to", "cc"]' : '"subject"';
  return `header :contains ${headers} ${quoted(filter.contains)}`;
}

export function renderSettingsScript(settings: MailSettings): string | null {
  const { vacation, forwarding } = settings;
  const filters = settings.filters ?? [];
  if (!vacation.enabled && !forwarding.enabled && filters.length === 0) return null;
  const extensions = new Set<string>();
  const body: string[] = [];
  // Flags first (they apply to wherever the message is then filed), then the
  // first matching move or delete only.
  for (const filter of filters) {
    if (filter.action !== 'markRead' && filter.action !== 'label') continue;
    extensions.add('imap4flags');
    const flag = filter.action === 'markRead' ? '\\Seen' : filter.keyword!;
    body.push(`if ${filterTest(filter)} {`, `  addflag ${quoted(flag)};`, '}');
  }
  const moves = filters.filter((f) => f.action === 'move' || f.action === 'delete');
  moves.forEach((filter, index) => {
    extensions.add('fileinto');
    const folder = filter.action === 'delete' ? 'Trash' : filter.folder!;
    body.push(`${index === 0 ? 'if' : 'elsif'} ${filterTest(filter)} {`, `  fileinto ${quoted(folder)};`, '}');
  });
  if (vacation.enabled) {
    extensions.add('vacation');
    const reply = `vacation :days 3 :subject ${quoted(vacation.subject || 'Out of office')} ${quoted(vacation.message)};`;
    if (vacation.until) {
      extensions.add('date');
      extensions.add('relational');
      body.push(`if currentdate :value "le" "date" ${quoted(vacation.until)} {`, `  ${reply}`, '}');
    } else {
      body.push(reply);
    }
  }
  if (forwarding.enabled) {
    if (forwarding.keepCopy) extensions.add('copy');
    body.push(`redirect ${forwarding.keepCopy ? ':copy ' : ''}${quoted(forwarding.address)};`);
  }
  return [
    '# Managed by the Postarix webmail (Settings). Changes made here are replaced.',
    `${MARKER} ${JSON.stringify(settings)}`,
    `require [${[...extensions].map((e) => `"${e}"`).join(', ')}];`,
    ...body,
    '',
  ].join('\n');
}

/** The settings a script was made from, or the defaults. */
export function parseSettingsScript(script: string | null): MailSettings {
  const line = script?.split('\n').find((l) => l.startsWith(MARKER));
  if (!line) return DEFAULT_SETTINGS;
  try {
    const parsed = mailSettingsSchema.safeParse(JSON.parse(line.slice(MARKER.length)));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}
