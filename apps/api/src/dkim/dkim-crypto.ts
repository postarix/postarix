import { createCipheriv, createDecipheriv, generateKeyPair, hkdfSync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const generateKeyPairAsync = promisify(generateKeyPair);

export interface GeneratedDkimKey {
  /** PKCS#8 PEM, kept only encrypted at rest. */
  privateKeyPem: string;
  /** Base64 SubjectPublicKeyInfo, as published in the DKIM DNS record ("p="). */
  publicKey: string;
}

/** Generates an RSA-2048 DKIM key pair (the size every receiver supports). */
export async function generateDkimKey(): Promise<GeneratedDkimKey> {
  const { privateKey, publicKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return { privateKeyPem: privateKey, publicKey: publicKey.toString('base64') };
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
