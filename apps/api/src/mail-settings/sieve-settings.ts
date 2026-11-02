import { z } from 'zod';

/** The Sieve script the webmail manages for a mailbox (automatic reply and forwarding). */
export const SETTINGS_SCRIPT = 'postarix-settings';

const singleLine = (max: number) => z.string().trim().max(max).regex(/^[^\r\n]*$/, 'Use a single line');

export const mailSettingsSchema = z
  .strictObject({
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
  vacation: { enabled: false, subject: 'Out of office', message: '', until: null },
  forwarding: { enabled: false, address: '', keepCopy: true },
};

const MARKER = '# Postarix settings:';

/** A Sieve quoted string (RFC 5228): backslashes and quotes escaped; line breaks allowed. */
function quoted(text: string): string {
  return `"${text.replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The script for these settings, or null when nothing is switched on. */
export function renderSettingsScript(settings: MailSettings): string | null {
  const { vacation, forwarding } = settings;
  if (!vacation.enabled && !forwarding.enabled) return null;
  const extensions = new Set<string>();
  const body: string[] = [];
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
