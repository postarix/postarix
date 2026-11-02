import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived credentials the API uses to log in to Cyrus' JMAP service as a
 * mailbox owner, on behalf of a signed-in web session. Only the API can mint
 * them (the key derives from AUTH_SECRET) and they never leave the internal
 * network: Cyrus hands them back to the API's login bridge for checking.
 */
const PREFIX = 'pxj1';
export const JMAP_TOKEN_TTL_SECONDS = 300;

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'postarix', 'jmap-login-token-v1', 32));
}

function sign(key: Buffer, address: string, expires: number): string {
  return createHmac('sha256', key).update(`${address}\n${expires}`).digest('base64url');
}

export function mintJmapToken(secret: string, address: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + JMAP_TOKEN_TTL_SECONDS;
  return `${PREFIX}.${expires}.${sign(keyFrom(secret), address, expires)}`;
}

export function looksLikeJmapToken(password: string): boolean {
  return password.startsWith(`${PREFIX}.`);
}

export function verifyJmapToken(secret: string, address: string, token: string, now = Date.now()): boolean {
  const [prefix, expiresText, signature, ...rest] = token.split('.');
  if (prefix !== PREFIX || rest.length > 0 || !expiresText || !signature || !/^\d{1,12}$/.test(expiresText)) return false;
  const expires = Number(expiresText);
  const nowSeconds = Math.floor(now / 1000);
  if (expires < nowSeconds || expires > nowSeconds + JMAP_TOKEN_TTL_SECONDS) return false;
  const expected = Buffer.from(sign(keyFrom(secret), address, expires));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
