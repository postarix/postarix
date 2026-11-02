import type { EmailAddress } from '@postarix/jmap-client';

export function displayName(address: EmailAddress | undefined | null): string {
  if (!address) return '';
  return address.name?.trim() || address.email;
}

export function addressList(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** Today: time; this year: day and month; older: full date. */
export function shortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function longDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Splits a recipient field on commas, semicolons and new lines, except inside quotes or <…>. */
export function splitRecipients(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of input) {
    if (char === '"' && !angle) quoted = !quoted;
    else if (char === '<' && !quoted) angle = true;
    else if (char === '>' && !quoted) angle = false;
    if (!quoted && !angle && (char === ',' || char === ';' || char === '\n')) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** A recipient as typed in an address field: "Name" <address>, or the bare address. */
export function formatRecipient(name: string | null | undefined, email: string): string {
  const clean = (name ?? '').replace(/["\\<>\r\n]/g, '').trim();
  return clean && clean !== email ? `"${clean}" <${email}>` : email;
}

/** "a@x, Bob <b@y>; c@z" → addresses. Returns the invalid parts separately. */
export function parseAddresses(input: string): { addresses: EmailAddress[]; invalid: string[] } {
  const addresses: EmailAddress[] = [];
  const invalid: string[] = [];
  for (const raw of splitRecipients(input)) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/.exec(part);
    const email = match ? match[2]! : part;
    const name = match?.[1]?.trim() || null;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) addresses.push(name ? { name, email } : { email });
    else invalid.push(part);
  }
  return { addresses, invalid };
}

/** Section heading for a list of mail: Today, Yesterday, the weekday this week, then month and year. */
export function dayGroup(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(undefined, { month: 'long' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}
