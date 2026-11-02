import { describe, expect, it } from 'vitest';
import { forwardDraft, replyDraft } from './compose';
import type { RenderedMessage } from './mail';

const message: RenderedMessage = {
  id: 'M1',
  threadId: 'T1',
  mailboxIds: {},
  keywords: {},
  subject: 'Plans',
  from: [{ name: 'Bob', email: 'bob@x.com' }],
  to: [{ email: 'ann@me.com' }, { email: 'carl@x.com' }],
  cc: [{ email: 'dora@y.com' }],
  bcc: [],
  replyTo: [],
  sentAt: '2026-11-01T10:00:00Z',
  receivedAt: '2026-11-01T10:00:01Z',
  messageId: ['m1@x.com'],
  references: ['m0@x.com'],
  html: '',
  text: 'Line 1\nLine 2',
  truncated: false,
  blockedImages: 0,
  attachments: [{ blobId: 'B1', name: 'a.pdf', type: 'application/pdf', size: 10 }],
};

describe('replyDraft', () => {
  it('replies to the sender, threads the reply and quotes the text', () => {
    const draft = replyDraft(message, 'ann@me.com', false, ['ann@me.com']);
    expect(draft.to).toEqual([{ name: 'Bob', email: 'bob@x.com' }]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe('Re: Plans');
    expect(draft.inReplyTo).toEqual(['m1@x.com']);
    expect(draft.references).toEqual(['m0@x.com', 'm1@x.com']);
    expect(draft.text).toContain('> Line 1\n> Line 2');
  });

  it('replies to all without including the user', () => {
    const draft = replyDraft({ ...message, subject: 'RE: Plans' }, 'ann@me.com', true, ['ann@me.com']);
    expect(draft.cc.map((a) => a.email)).toEqual(['carl@x.com', 'dora@y.com']);
    expect(draft.subject).toBe('RE: Plans');
  });
});

describe('forwardDraft', () => {
  it('keeps attachments and the original text, with no recipients', () => {
    const draft = forwardDraft(message, 'ann@me.com');
    expect(draft.subject).toBe('Fwd: Plans');
    expect(draft.to).toEqual([]);
    expect(draft.attachments).toEqual(message.attachments);
    expect(draft.text).toContain('Forwarded message');
    expect(draft.text).toContain('Line 1');
  });
});
