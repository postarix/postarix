import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPair, hkdfSync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const generateKeyPairAsync = promisify(generateKeyPair);

export interface GeneratedDkimKey {
  /** PKCS#8 PEM, kept only encrypted at rest. */
  privateKeyPem: string;
  /** Base64 SubjectPublicKeyInfo, as published in the DKIM DNS record ("p="). */
  publicKey: string;
}

export const dkimKeySizes = [1024, 2048, 3072, 4096] as const;
export type DkimKeySize = (typeof dkimKeySizes)[number];

/** Generates an RSA DKIM key pair; 2048 bits by default (the size every receiver supports). */
export async function generateDkimKey(bits: DkimKeySize = 2048): Promise<GeneratedDkimKey> {
  const { privateKey, publicKey } = await generateKeyPairAsync('rsa', {
    modulusLength: bits,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return { privateKeyPem: privateKey, publicKey: publicKey.toString('base64') };
}

/**
 * Reads an RSA private key brought from elsewhere (PEM, PKCS#1 or PKCS#8), so
 * a domain can keep the DKIM key it already publishes. Null if it is not an
 * RSA key of 1024 to 4096 bits.
 */
export function importDkimKey(pem: string): (GeneratedDkimKey & { bits: number }) | null {
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== 'rsa' || bits < 1024 || bits > 4096) return null;
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
    return { privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey, bits };
  } catch {
    return null;
  }
}

/** Size in bits of a published public key ("p=" value). */
export function publicKeyBits(publicKey: string): number | null {
  try {
    return createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyDetails?.modulusLength ?? null;
  } catch {
    return null;
  }
}

const FORMAT = 'v1';

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'postarix', 'dkim-private-keys', 32));
}

/**
 * Encrypts a private key with AES-256-GCM under a key derived from the
 * instance secret. Output: "v1:" + base64(iv | tag | ciphertext).
 */
export function encryptPrivateKey(pem: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

export function decryptPrivateKey(stored: string, secret: string): string {
  const [format, payload] = stored.split(':', 2);
  if (format !== FORMAT || !payload) throw new Error('Unknown DKIM key encryption format');
  const data = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

/** Selector for a key created now, e.g. "px202611". */
export function selectorFor(date: Date): string {
  return `px${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
