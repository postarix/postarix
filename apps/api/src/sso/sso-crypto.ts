import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'postarix', 'sso-client-secrets', 32));
}

/** AES-256-GCM under a key derived from AUTH_SECRET: "enc:v1:" + base64(iv | tag | ciphertext). */
export function encryptClientSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function decryptClientSecret(stored: string, secret: string): string {
  if (!isEncrypted(stored)) return stored;
  const data = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * The stored oidcConfig JSON with its client secret encrypted (or decrypted).
 * Everything else in it (issuer, client ID, endpoints) is not secret and stays
 * readable. Anything that is not JSON is returned unchanged.
 */
export function mapOidcConfigSecret(stored: string | null, transform: (secret: string) => string): string | null {
  if (!stored) return stored;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(stored) as Record<string, unknown>;
  } catch {
    return stored;
  }
  if (typeof config.clientSecret !== 'string') return stored;
  return JSON.stringify({ ...config, clientSecret: transform(config.clientSecret) });
}

/** For a new provider: the secret is always encrypted, whatever it looks like. */
export const sealNewOidcConfig = (stored: string, secret: string): string =>
  mapOidcConfigSecret(stored, (value) => encryptClientSecret(value, secret))!;

/** For rows saved before secrets were encrypted: encrypts what is not yet. */
export const sealOidcConfig = (stored: string, secret: string): string =>
  mapOidcConfigSecret(stored, (value) => (isEncrypted(value) ? value : encryptClientSecret(value, secret)))!;

export const openOidcConfig = (stored: string | null, secret: string): string | null =>
  mapOidcConfigSecret(stored, (value) => decryptClientSecret(value, secret));
