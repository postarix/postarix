import { describe, expect, it } from 'vitest';
import { openOidcConfig, sealOidcConfig } from './sso-crypto.js';

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
});
