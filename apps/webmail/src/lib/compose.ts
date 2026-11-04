import type { EmailAddress } from '@postarix/jmap-client';
import { api } from './api';
import { displayName, longDate } from './format';
import { jmap } from './jmap';
import type { RenderedMessage } from './mail';

export interface Attachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export interface DraftInput {
  from: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** Plain-text body (always sent, for clients that do not show HTML). */
  text: string;
  /** Formatted body (sanitized HTML), or '' for a plain-text message. */
  html: string;
  attachments: Attachment[];
  inReplyTo: string[];
  references: string[];
}

export function emptyDraft(from: string): DraftInput {
  return { from, to: [], cc: [], bcc: [], subject: '', text: '', html: '', attachments: [], inReplyTo: [], references: [] };
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const pattern = prefix === 'Re' ? /^re:/i : /^(fwd?|fw):/i;
  return pattern.test(subject.trim()) ? subject : `${prefix}: ${subject}`;
}

function quote(message: RenderedMessage): string {
  const who = displayName(message.from[0]) || 'someone';
  const when = message.sentAt ?? message.receivedAt;
  const body = message.text.split('\n').map((line) => `> ${line}`).join('\n');
  return `\n\nOn ${longDate(when)}, ${who} wrote:\n${body}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text as HTML paragraphs (line breaks kept). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function quoteHtml(message: RenderedMessage): string {
  const who = escapeHtml(displayName(message.from[0]) || 'someone');
  const when = escapeHtml(longDate(message.sentAt ?? message.receivedAt));
  return `<p><br></p><p>On ${when}, ${who} wrote:</p><blockquote>${textToHtml(message.text)}</blockquote>`;
}

/** A reply (or reply to all) to `message`, sent from `from`. */
export function replyDraft(message: RenderedMessage, from: string, all: boolean, own: string[]): DraftInput {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const notMine = (a: EmailAddress) => !mine.has(a.email.toLowerCase());
  const to = message.replyTo.length ? message.replyTo : message.from;
  const cc = all ? [...message.to, ...message.cc].filter(notMine).filter((a) => !to.some((t) => t.email === a.email)) : [];
  return {
    ...emptyDraft(from),
    to: to.filter(notMine).length ? to.filter(notMine) : to,
    cc,
    subject: prefixed(message.subject, 'Re'),
    text: quote(message),
    html: quoteHtml(message),
    inReplyTo: message.messageId,
    references: [...message.references, ...message.messageId],
  };
}

export function forwardDraft(message: RenderedMessage, from: string): DraftInput {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${message.from.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')}`,
    `Date: ${longDate(message.sentAt ?? message.receivedAt)}`,
    `Subject: ${message.subject}`,
    `To: ${message.to.map((a) => a.email).join(', ')}`,
  ].join('\n');
  return {
    ...emptyDraft(from),
    subject: prefixed(message.subject, 'Fwd'),
    text: `\n\n${header}\n\n${message.text}`,
    html: `<p><br></p>${textToHtml(header)}${textToHtml(message.text)}`,
    attachments: message.attachments,
    references: [...message.references, ...message.messageId],
  };
}

/** A complete HTML document for the formatted body, with readable defaults. */
function wrapHtml(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family: system-ui, sans-serif; font-size: 15px; line-height: 1.5">${fragment}</body></html>`;
}

async function mailboxIdByRole(role: string): Promise<string> {
  const { list } = await jmap.call<{ list: { id: string; role: string | null }[] }>('Mailbox/get', { properties: ['role'] });
  const found = list.find((m) => m.role === role);
  if (!found) throw new Error(`No ${role} folder`);
  return found.id;
}

/**
 * Stores the draft in Drafts and returns its id. Messages cannot be edited in
 * place, so a previous version (`replaces`) is destroyed in the same request.
 */
/**
 * The JMAP Email object for a draft. Empty address lists are left out: Cyrus
 * would write them as empty headers ("Cc:" with nothing), a classic spam
 * signal. (No charset on the parts: with bodyValues the server chooses it,
 * RFC 8621 §4.6.)
 */
export function draftEmail(input: DraftInput, draftsId: string): Record<string, unknown> {
  const text = { type: 'text/plain' };
  const html = { type: 'text/html' };
  return {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ email: input.from }],
    ...(input.to.length ? { to: input.to } : {}),
    ...(input.cc.length ? { cc: input.cc } : {}),
    ...(input.bcc.length ? { bcc: input.bcc } : {}),
    subject: input.subject,
    ...(input.inReplyTo.length ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references.length ? { references: input.references } : {}),
    ...(input.html
      ? {
          bodyValues: { text: { value: input.text }, html: { value: wrapHtml(input.html) } },
          textBody: [{ partId: 'text', ...text }],
          htmlBody: [{ partId: 'html', ...html }],
        }
      : {
          bodyValues: { body: { value: input.text } },
          textBody: [{ partId: 'body', ...text }],
        }),
    attachments: input.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })),
  };
}

/**
 * Stores the draft in Drafts and returns its id. Messages cannot be edited in
 * place, so a previous version (`replaces`) is destroyed in the same request.
 */
export async function saveDraft(input: DraftInput, replaces?: string | null): Promise<string> {
  const accountId = await jmap.accountId();
  const draftsId = await mailboxIdByRole('drafts');
  const results = await jmap.batch((b) =>
    b.add('Email/set', {
      accountId,
      create: { draft: draftEmail(input, draftsId) },
      ...(replaces ? { destroy: [replaces] } : {}),
    }),
  );
  const result = results.get('c0') as { created?: Record<string, { id: string }>; notCreated?: Record<string, { type: string; description?: string }> };
  const created = result.created?.draft;
  if (!created) {
    const error = result.notCreated?.draft;
    throw new Error(`Could not save the draft (${error?.description ?? error?.type ?? 'unknown error'})`);
  }
  return created.id;
}

/** Saves the draft, then asks the API to send it (which moves it to Sent). */
export async function sendDraft(input: DraftInput, replaces?: string | null): Promise<void> {
  const id = await saveDraft(input, replaces);
  await api('/mail/send', { method: 'POST', body: { emailId: id } });
}
