import { normalizeDomainName } from '../domains/domain-name.js';

/**
 * Local parts we create (mailboxes, aliases): lowercase letters, digits, dot,
 * hyphen and underscore. "+" is reserved as Postfix' sub-addressing delimiter
 * (alice+news@ is delivered to alice@), and "/" would collide with Cyrus'
 * hierarchy separator.
 */
const OWN_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** Local parts of external addresses: RFC 5322 dot-atom, minus anything that breaks Postfix maps. */
const EXTERNAL_LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

export function normalizeLocalPart(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!OWN_LOCAL_PART.test(value) || value.includes('..')) return null;
  return value;
}

/** Normalizes any deliverable address (e.g. an alias destination), or returns null. */
export function normalizeAddress(input: string): string | null {
  const value = input.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const local = value.slice(0, at);
  const domain = normalizeDomainName(value.slice(at + 1));
  if (domain === null || local.length > 64 || !EXTERNAL_LOCAL_PART.test(local)) return null;
  return `${local}@${domain}`;
}
