import { describe, expect, it } from 'vitest';
import { draftEmail, emptyDraft, forwardDraft, replyDraft } from './compose';
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
  calendar: false,
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

describe('draftEmail', () => {
  it('puts the sender’s name in From when there is one', () => {
    expect(draftEmail({ ...emptyDraft('ann@me.com'), fromName: ' Ann Example ' }, 'D1').from).toEqual([{ name: 'Ann Example', email: 'ann@me.com' }]);
    expect(draftEmail(emptyDraft('ann@me.com'), 'D1').from).toEqual([{ email: 'ann@me.com' }]);
  });

  it('leaves out empty address lists', () => {
    const email = draftEmail({ ...emptyDraft('ann@me.com'), to: [{ email: 'bob@x.com' }], subject: 'Hola', text: 'Año' }, 'D1');
    expect(email.to).toEqual([{ email: 'bob@x.com' }]);
    expect(email).not.toHaveProperty('cc');
    expect(email).not.toHaveProperty('bcc');
    expect(email.textBody).toEqual([{ partId: 'body', type: 'text/plain' }]);
  });

  it('keeps the recipients it has, and both parts of a formatted message', () => {
    const email = draftEmail({ ...emptyDraft('ann@me.com'), cc: [{ email: 'c@x.com' }], text: 'a', html: '<p>a</p>' }, 'D1');
    expect(email).not.toHaveProperty('to');
    expect(email.cc).toEqual([{ email: 'c@x.com' }]);
    expect(email.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
  });
});
