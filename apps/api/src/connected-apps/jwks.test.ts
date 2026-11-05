import { describe, expect, it } from 'vitest';
import { IssuerPolicy } from '../sso/issuer-policy.js';
import { fetchJwks, jwksUrlAllowed } from './jwks.js';

describe('JWKS URLs', () => {
  const policy = new IssuerPolicy([]);

  it('must be https on a public host', () => {
    expect(jwksUrlAllowed('https://keys.example.com/.well-known/jwks.json', policy)).toBe(true);
    expect(jwksUrlAllowed('http://keys.example.com/jwks', policy)).toBe(false);
    expect(jwksUrlAllowed('https://10.1.2.3/jwks', policy)).toBe(false);
    expect(jwksUrlAllowed('https://localhost/jwks', policy)).toBe(false);
    expect(jwksUrlAllowed('https://user:pw@keys.example.com/jwks', policy)).toBe(false);
    expect(jwksUrlAllowed('not a url', policy)).toBe(false);
  });

  it('refuses private addresses when fetching', async () => {
    await expect(fetchJwks('https://127.0.0.1/jwks', () => false)).rejects.toThrow(/not allowed/);
    await expect(fetchJwks('http://keys.example.com/jwks', () => false)).rejects.toThrow(/https/);
  });
});
