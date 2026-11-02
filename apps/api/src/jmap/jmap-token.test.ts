import { describe, expect, it } from 'vitest';
import { JMAP_TOKEN_TTL_SECONDS, looksLikeJmapToken, mintJmapToken, verifyJmapToken } from './jmap-token.js';

const SECRET = 'a'.repeat(40);

describe('JMAP login tokens', () => {
  it('verify for the address they were minted for, until they expire', () => {
    const now = Date.UTC(2026, 10, 2);
    const token = mintJmapToken(SECRET, 'alice@example.com', now);
    expect(looksLikeJmapToken(token)).toBe(true);
    expect(verifyJmapToken(SECRET, 'alice@example.com', token, now)).toBe(true);
    expect(verifyJmapToken(SECRET, 'alice@example.com', token, now + (JMAP_TOKEN_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifyJmapToken(SECRET, 'alice@example.com', token, now + (JMAP_TOKEN_TTL_SECONDS + 1) * 1000)).toBe(false);
  });

  it('fail for another address, another secret, or any tampering', () => {
    const now = Date.now();
    const token = mintJmapToken(SECRET, 'alice@example.com', now);
    expect(verifyJmapToken(SECRET, 'bob@example.com', token, now)).toBe(false);
    expect(verifyJmapToken('b'.repeat(40), 'alice@example.com', token, now)).toBe(false);
    const [prefix, expires, signature] = token.split('.');
    // Pushing the expiry further out invalidates the signature.
    expect(verifyJmapToken(SECRET, 'alice@example.com', `${prefix}.${Number(expires) + 60}.${signature}`, now)).toBe(false);
    expect(verifyJmapToken(SECRET, 'alice@example.com', `${token}.x`, now)).toBe(false);
    expect(verifyJmapToken(SECRET, 'alice@example.com', 'pxj1..', now)).toBe(false);
    expect(verifyJmapToken(SECRET, 'alice@example.com', 'a normal password', now)).toBe(false);
  });
});
