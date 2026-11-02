import { describe, expect, it } from 'vitest';
import { openOidcConfig, sealNewOidcConfig, sealOidcConfig } from './sso-crypto.js';

const SECRET = 'an instance secret that is long enough';

describe('SSO client secret encryption', () => {
  const plain = JSON.stringify({ issuer: 'https://idp.example', clientId: 'app', clientSecret: 'shh-very-secret' });

  it('encrypts only the client secret and opens it again', () => {
    const sealed = sealOidcConfig(plain, SECRET);
    expect(sealed).not.toContain('shh-very-secret');
    expect(JSON.parse(sealed)).toMatchObject({ issuer: 'https://idp.example', clientId: 'app' });
    expect(JSON.parse(sealed).clientSecret).toMatch(/^enc:v1:/);
    expect(openOidcConfig(sealed, SECRET)).toBe(plain);
    // Sealing twice does not encrypt twice.
    expect(sealOidcConfig(sealed, SECRET)).toBe(sealed);
  });

  it('cannot be opened with another secret, and passes legacy plaintext through', () => {
    const sealed = sealOidcConfig(plain, SECRET);
    expect(() => openOidcConfig(sealed, 'another secret that is long enough')).toThrow();
    expect(openOidcConfig(plain, SECRET)).toBe(plain);
    expect(openOidcConfig(null, SECRET)).toBeNull();
  });
  it('encrypts a new secret even when it looks encrypted already', () => {
    const tricky = JSON.stringify({ clientId: 'app', clientSecret: 'enc:v1:not-really' });
    const sealed = sealNewOidcConfig(tricky, SECRET);
    expect(JSON.parse(sealed).clientSecret).not.toBe('enc:v1:not-really');
    expect(openOidcConfig(sealed, SECRET)).toBe(tricky);
  });
});
