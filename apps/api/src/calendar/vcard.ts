import ICAL from 'ical.js';

/** A contact as Cyrus' JMAP contacts model stores it (see the webmail's Contact). */
export interface ImportedContact {
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  nickname: string;
  notes: string;
  emails: {
    type: 'personal' | 'work' | 'other';
    value: string;
    isDefault: boolean;
  }[];
  phones: {
    type: 'home' | 'work' | 'mobile' | 'fax' | 'other';
    value: string;
  }[];
}

export class VcardError extends Error {}

/** Most contacts one file may bring in. */
export const MAX_IMPORTED_CONTACTS = 5000;
const MAX_FIELD = 500;
const MAX_NOTES = 5000;
const MAX_VALUES = 20;

/** Control characters (but tab and newlines) never belong in a contact field. */
function stripControls(value: string): string {
  return [...value]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
}

function text(value: unknown, max = MAX_FIELD): string {
  if (Array.isArray(value)) value = value.filter((v) => typeof v === 'string' && v.trim()).join(' ');
  return typeof value === 'string' ? stripControls(value).trim().slice(0, max) : '';
}

function types(prop: ICAL.Property): string[] {
  const raw = prop.getParameter('type');
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((t) => String(t).toLowerCase().split(','));
}

function emailType(prop: ICAL.Property): ImportedContact['emails'][number]['type'] {
  const t = types(prop);
  if (t.includes('work')) return 'work';
  if (t.includes('home') || t.includes('personal')) return 'personal';
  return 'other';
}

function phoneType(prop: ICAL.Property): ImportedContact['phones'][number]['type'] {
  const t = types(prop);
  if (t.includes('cell') || t.includes('mobile') || t.includes('iphone')) return 'mobile';
  if (t.includes('fax')) return 'fax';
  if (t.includes('work')) return 'work';
  if (t.includes('home')) return 'home';
  return 'other';
}

function contactOf(card: ICAL.Component): ImportedContact | null {
  const name = card.getFirstPropertyValue('n');
  const parts = Array.isArray(name) ? name : typeof name === 'string' ? name.split(';') : [];
  const lastName = text(parts[0]);
  let firstName = text(parts[1]);
  if (!firstName && !lastName) firstName = text(card.getFirstPropertyValue('fn'));
  const org = card.getFirstPropertyValue('org');
  const emails = card
    .getAllProperties('email')
    .slice(0, MAX_VALUES)
    .map((prop) => ({
      type: emailType(prop),
      value: text(prop.getFirstValue(), 254).replace(/^mailto:/i, ''),
      pref: types(prop).includes('pref'),
    }))
    .filter((e) => /^[^\s@]+@[^\s@]+$/.test(e.value));
  // The preferred address first; it becomes the default.
  emails.sort((a, b) => Number(b.pref) - Number(a.pref));
  const phones = card
    .getAllProperties('tel')
    .slice(0, MAX_VALUES)
    .map((prop) => ({
      type: phoneType(prop),
      value: text(prop.getFirstValue(), 64).replace(/^tel:/i, ''),
    }))
    .filter((p) => p.value);
  const contact: ImportedContact = {
    firstName,
    lastName,
    company: text(Array.isArray(org) ? org[0] : typeof org === 'string' ? org.split(';')[0] : ''),
    jobTitle: text(card.getFirstPropertyValue('title')),
    nickname: text(card.getFirstPropertyValue('nickname')),
    notes: text(card.getFirstPropertyValue('note'), MAX_NOTES),
    emails: emails.map((e, i) => ({
      type: e.type,
      value: e.value,
      isDefault: i === 0,
    })),
    phones,
  };
  const empty = !contact.firstName && !contact.lastName && !contact.company && contact.emails.length === 0 && contact.phones.length === 0;
  return empty ? null : contact;
}

/**
 * vCard 2.1 (old Outlook and phones) writes quoted-printable values, folded
 * with a trailing "=": join those lines and decode the values, so the parser
 * sees plain text.
 */
function unfoldQuotedPrintable(data: string): string {
  if (!/QUOTED-PRINTABLE/i.test(data)) return data;
  const lines = data.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!/;ENCODING=QUOTED-PRINTABLE[;:]/i.test(line)) {
      out.push(line);
      continue;
    }
    while (line.endsWith('=') && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    const colon = line.indexOf(':');
    const params = line
      .slice(0, colon)
      .replace(/;ENCODING=QUOTED-PRINTABLE/i, '')
      .replace(/;CHARSET=[^;:]*/i, '');
    const bytes = line.slice(colon + 1).replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    out.push(`${params}:${Buffer.from(bytes, 'latin1').toString('utf8')}`);
  }
  return out.join('\r\n');
}

/** vCard 2.1 also writes types without a name ("EMAIL;INTERNET;WORK:"): name them. */
function bareTypes(data: string): string {
  return data
    .split(/\r?\n/)
    .map((line) => {
      if (/^[ \t]/.test(line)) return line;
      const colon = line.indexOf(':');
      if (colon < 0) return line;
      const head = line.slice(0, colon).replace(/;([A-Za-z0-9-]+)(?=;|$)/g, ';TYPE=$1');
      return head + line.slice(colon);
    })
    .join('\r\n');
}

/**
 * Reads a .vcf file (one or many vCards 2.1/3.0/4.0, as Google, Outlook and
 * Apple export them) into contacts. Photos, addresses and custom fields are
 * left out. Throws VcardError when the file is not a vCard file.
 */
export function readVcards(data: string): ImportedContact[] {
  let parsed: unknown;
  try {
    parsed = ICAL.parse(bareTypes(unfoldQuotedPrintable(data)));
  } catch {
    throw new VcardError('The file cannot be read as contacts (vCard)');
  }
  const list = (Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed : [parsed]) as unknown[][];
  if (list.length > MAX_IMPORTED_CONTACTS) throw new VcardError(`The file holds more than ${MAX_IMPORTED_CONTACTS} contacts`);
  const contacts: ImportedContact[] = [];
  for (const jcard of list) {
    if (!Array.isArray(jcard) || jcard[0] !== 'vcard') throw new VcardError('The file cannot be read as contacts (vCard)');
    const contact = contactOf(new ICAL.Component(jcard));
    if (contact) contacts.push(contact);
  }
  if (contacts.length === 0) throw new VcardError('The file holds no contacts');
  return contacts;
}
