import { randomInt } from 'node:crypto';

// RFC 4648 base32 alphabet, lowercase: no 0/1/8/9, so no o/0 or l/1 confusion when typed.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const LENGTH = 24; // 120 bits of entropy
export const LOOKUP_PREFIX_LENGTH = 6;

/** Generates a new app password (24 base32 characters, shown in groups of four). */
export function generateAppPassword(): { raw: string; display: string } {
  let raw = '';
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return { raw, display: raw.match(/.{4}/g)!.join(' ') };
}

/**
 * Normalizes what a user typed into a mail client: spaces and dashes are
 * ignored and case doesn't matter. Returns null if it cannot be an app password.
 */
export function normalizeAppPassword(input: string): string | null {
  const value = input.replace(/[\s-]/g, '').toLowerCase();
  if (value.length !== LENGTH) return null;
  for (const char of value) if (!ALPHABET.includes(char)) return null;
  return value;
}
