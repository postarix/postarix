import { describe, expect, it } from 'vitest';
import { formatRecipient, parseAddresses, shortDate } from './format';
import { parseRoute, mailboxPath } from './router';

describe('parseAddresses', () => {
  it('reads plain and named addresses and reports the rest', () => {
    expect(parseAddresses('a@x.com, "Bob B" <b@y.org>; Carl <c@z.net>\n bad, also@bad')).toEqual({
      addresses: [{ email: 'a@x.com' }, { name: 'Bob B', email: 'b@y.org' }, { name: 'Carl', email: 'c@z.net' }],
      invalid: ['bad', 'also@bad'],
    });
  });
});

describe('shortDate', () => {
  it('shows the time for today and the date otherwise', () => {
    const now = new Date('2026-11-02T15:00:00');
    expect(shortDate('2026-11-02T09:30:00', now)).toMatch(/9|09/);
    expect(shortDate('2025-01-05T09:30:00', now)).toMatch(/2025/);
  });
});

describe('router', () => {
  it('round-trips mailbox paths', () => {
    expect(parseRoute(mailboxPath('M a', 'E/1', 'from:bob'))).toEqual({ name: 'mailbox', mailboxId: 'M a', emailId: 'E/1', search: 'from:bob' });
    expect(parseRoute('/')).toEqual({ name: 'mailbox', mailboxId: null, emailId: null, search: '' });
    expect(parseRoute('/login')).toEqual({ name: 'login' });
    expect(parseRoute('/calendar?date=2026-11-10')).toEqual({ name: 'calendar', date: '2026-11-10' });
    expect(parseRoute('/calendar?date=junk')).toEqual({ name: 'calendar', date: null });
    expect(parseRoute('/contacts/c1?q=ann')).toEqual({ name: 'contacts', contactId: 'c1', search: 'ann' });
  });
});

describe('recipients with commas in their names', () => {
  it('keeps a quoted name together', () => {
    const field = `${formatRecipient('Acme, Inc.', 'sales@acme.example')}, bob@b.example`;
    expect(field).toBe('"Acme, Inc." <sales@acme.example>, bob@b.example');
    expect(parseAddresses(field)).toEqual({
      addresses: [{ name: 'Acme, Inc.', email: 'sales@acme.example' }, { email: 'bob@b.example' }],
      invalid: [],
    });
  });

  it('drops characters that would break the field', () => {
    expect(formatRecipient('Eve "<x@y>"', 'eve@e.example')).toBe('"Eve x@y" <eve@e.example>');
  });
});
