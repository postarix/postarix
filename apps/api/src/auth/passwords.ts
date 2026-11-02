import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    // Malformed or foreign hash formats never match.
    return false;
  }
}
