import { describe, expect, it } from 'vitest';
import { IssuerPolicy } from './issuer-policy.js';

describe('IssuerPolicy', () => {
  const policy = new IssuerPolicy(['http://keycloak.corp:8080']);

  it('allows public https URLs', () => {
    expect(policy.allowsUrl('https://login.microsoftonline.com/tenant/v2.0')).toBe(true);
    expect(policy.allowsUrl('https://accounts.google.com')).toBe(true);
    expect(policy.allowsUrl('https://8.8.8.8/')).toBe(true);
  });

  it('refuses plain http, credentials and internal hosts unless trusted', () => {
    for (const url of [
      'http://login.example.com',
      'https://user:pass@login.example.com',
      'https://localhost',
      'https://idp.localhost',
      'https://metadata.google.internal',
      'https://printer.local',
      'https://intranet',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[::ffff:10.0.0.1]',
      'https://[fd00::1]',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(policy.allowsUrl(url), url).toBe(false);
    }
    expect(policy.allowsUrl('http://keycloak.corp:8080/realms/acme')).toBe(true);
  });

  it('refuses hosts whose names resolve to private addresses before fetching', async () => {
    expect(await policy.allowsFetch('https://localtest.me/.well-known/openid-configuration')).toBe(false);
    expect(await policy.allowsFetch('http://keycloak.corp:8080/.well-known/openid-configuration')).toBe(true);
  });
});
