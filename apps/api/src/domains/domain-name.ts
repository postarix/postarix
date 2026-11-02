import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// Letters (any script), combining marks, digits, hyphens and dots only. Rejected up
// front because domainToASCII silently truncates at "/?#\" and percent-decodes.
const ALLOWED_INPUT = /^[\p{L}\p{M}\p{N}.-]+$/u;

/**
 * Normalizes a user-supplied domain name to its lowercase ASCII (punycode) form,
 * or returns null if it is not a valid fully-qualified domain name.
 */
export function normalizeDomainName(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (value.length === 0 || !ALLOWED_INPUT.test(value) || isIP(value) !== 0) return null;

  const ascii = domainToASCII(value);
  if (ascii === '' || ascii.length > 253) return null;

  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  // The top-level domain cannot be purely numeric.
  if (/^\d+$/.test(labels.at(-1) ?? '')) return null;

  return ascii;
}
