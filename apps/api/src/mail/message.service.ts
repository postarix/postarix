import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { findOwnMailbox } from '../jmap/my-mailbox.js';
import { proxiedImageUrl } from './image-proxy.js';
import { JmapMethodError, ServerJmap } from './jmap-client.js';
import { htmlToText, sanitizeEmailHtml, textToHtml } from './sanitize.js';

const MAX_BODY_BYTES = 2_000_000;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface BodyPart {
  partId?: string | null;
  blobId?: string | null;
  type: string;
  name?: string | null;
  size: number;
  cid?: string | null;
  disposition?: string | null;
}

interface Address {
  name?: string | null;
  email?: string | null;
}

interface JmapEmail {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  subject: string | null;
  from: Address[] | null;
  to: Address[] | null;
  cc: Address[] | null;
  bcc: Address[] | null;
  replyTo: Address[] | null;
  sentAt: string | null;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  htmlBody: BodyPart[];
  textBody: BodyPart[];
  attachments: BodyPart[];
  bodyValues: Record<string, { value: string; isTruncated?: boolean }>;
}

export interface RenderedMessage {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  sentAt: string | null;
  receivedAt: string;
  messageId: string[];
  references: string[];
  /** Sanitized HTML, to show in a sandboxed iframe. */
  html: string;
  /** The plain-text body, for quoting in replies. */
  text: string;
  truncated: boolean;
  blockedImages: number;
  attachments: { blobId: string; name: string; type: string; size: number }[];
}

/** Reads a message from the user's own mailbox and renders it safely for the webmail. */
@Injectable()
export class MessageService {
  private readonly imageBase: string;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.imageBase = new URL('/api/mail/image', env.AUTH_URL).href;
  }

  async render(userId: string, emailId: string, remoteImages: boolean): Promise<RenderedMessage> {
    const address = await findOwnMailbox(this.db, userId);
    if (!address) throw new NotFoundException('You have no mailbox');
    const jmap = new ServerJmap(this.engine, address);

    let list: JmapEmail[];
    try {
      ({ list } = await jmap.single<{ list: JmapEmail[] }>('Email/get', {
        ids: [emailId],
        properties: [
          'threadId', 'mailboxIds', 'keywords', 'subject', 'from', 'to', 'cc', 'bcc', 'replyTo', 'sentAt', 'receivedAt',
          'messageId', 'inReplyTo', 'references', 'htmlBody', 'textBody', 'attachments', 'bodyValues',
        ],
        bodyProperties: ['partId', 'blobId', 'type', 'name', 'size', 'cid', 'disposition'],
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
        maxBodyValueBytes: MAX_BODY_BYTES,
      }));
    } catch (error) {
      if (error instanceof JmapMethodError) throw new UnprocessableEntityException(`Mail server error: ${error.type}`);
      throw error;
    }
    const email = list[0];
    if (!email) throw new NotFoundException('Message not found');

    const value = (part: BodyPart) => (part.partId ? (email.bodyValues[part.partId]?.value ?? '') : '');
    const truncated = Object.values(email.bodyValues).some((v) => v.isTruncated);
    const hasHtml = email.htmlBody.some((p) => p.type === 'text/html');
    const rawHtml = hasHtml
      ? email.htmlBody.map((p) => (p.type === 'text/html' ? value(p) : p.type === 'text/plain' ? textToHtml(value(p)) : '')).join('\n')
      : email.textBody.map((p) => textToHtml(value(p))).join('\n');
    const plain = email.textBody.filter((p) => p.type === 'text/plain').map(value).join('\n');
    const text = plain.trim() || !hasHtml ? plain : htmlToText(rawHtml);

    // Inline images referenced as cid: become data: URIs, within size limits.
    const referenced = new Set([...rawHtml.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => m[1]!.replace(/^<|>$/g, '').toLowerCase()));
    const parts = [...email.attachments, ...email.htmlBody];
    const inline = new Map<string, string>();
    let inlineBytes = 0;
    for (const part of parts) {
      const cid = part.cid?.replace(/^<|>$/g, '').toLowerCase();
      if (!cid || !referenced.has(cid) || inline.has(cid) || !part.blobId || !INLINE_TYPES.has(part.type)) continue;
      if (part.size > MAX_INLINE_IMAGE_BYTES || inlineBytes + part.size > MAX_INLINE_TOTAL_BYTES) continue;
      try {
        const bytes = await jmap.download(part.blobId, MAX_INLINE_IMAGE_BYTES);
        inlineBytes += bytes.length;
        inline.set(cid, `data:${part.type};base64,${bytes.toString('base64')}`);
      } catch {
        // A broken inline image is shown as missing.
      }
    }

    const { html, blockedImages } = sanitizeEmailHtml(rawHtml, {
      inlineImage: (cid) => inline.get(cid.toLowerCase()) ?? null,
      remoteImage: (url) => (remoteImages ? proxiedImageUrl(this.env.AUTH_SECRET, this.imageBase, url) : null),
    });

    const inlined = new Set(inline.keys());
    return {
      id: email.id,
      threadId: email.threadId,
      mailboxIds: email.mailboxIds,
      keywords: email.keywords,
      subject: email.subject ?? '',
      from: email.from ?? [],
      to: email.to ?? [],
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      replyTo: email.replyTo ?? [],
      sentAt: email.sentAt,
      receivedAt: email.receivedAt,
      messageId: email.messageId ?? [],
      references: [...(email.references ?? []), ...(email.inReplyTo ?? [])].filter((v, i, a) => a.indexOf(v) === i),
      html,
      text,
      truncated,
      blockedImages,
      attachments: email.attachments
        .filter((p) => p.blobId && !(p.cid && inlined.has(p.cid.replace(/^<|>$/g, '').toLowerCase())))
        .map((p) => ({ blobId: p.blobId!, name: p.name ?? 'attachment', type: p.type, size: p.size })),
    };
  }
}
