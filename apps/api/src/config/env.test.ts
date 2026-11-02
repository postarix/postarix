import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NODE_ENV: 'production',
  AUTH_URL: 'https://mail.example.com',
  AUTH_SECRET: 'x'.repeat(32),
  CYRUS_ADMIN_PASSWORD: 'cyrus-admin-secret',
  VALKEY_URL: 'redis://:secret@valkey:6379',
};

describe('loadEnv', () => {
  it('uses secure defaults', () => {
    const env = loadEnv(base);
    expect(env.ALLOW_SIGNUP).toBe(false);
    expect(env.ALLOW_USER_CREATE_ORG).toBe(false);
    expect(env.TRUSTED_PROXIES).toEqual([]);
    expect(env.TRUSTED_ORIGINS).toEqual([]);
  });

  it('parses comma-separated lists', () => {
    const env = loadEnv({ ...base, TRUSTED_PROXIES: '10.0.0.0/8, 172.16.0.1 ,' });
    expect(env.TRUSTED_PROXIES).toEqual(['10.0.0.0/8', '172.16.0.1']);
  });

  it('reads the backends of a Cyrus Murder', () => {
    expect(loadEnv(base).CYRUS_BACKENDS).toEqual([]);
    const env = loadEnv({ ...base, CYRUS_BACKENDS: 'b1=cyrus-backend-1, b2=cyrus-backend-2.cluster.local', CYRUS_DEFAULT_BACKEND: 'b2' });
    expect(env.CYRUS_BACKENDS).toEqual([
      { name: 'b1', host: 'cyrus-backend-1' },
      { name: 'b2', host: 'cyrus-backend-2.cluster.local' },
    ]);
    expect(() => loadEnv({ ...base, CYRUS_BACKENDS: 'b1=one,b1=two' })).toThrow(/unique/);
    expect(() => loadEnv({ ...base, CYRUS_BACKENDS: 'just-a-host' })).toThrow(/name=host/);
    expect(() => loadEnv({ ...base, CYRUS_BACKENDS: 'b1=one', CYRUS_DEFAULT_BACKEND: 'b9' })).toThrow(/CYRUS_DEFAULT_BACKEND/);
  });

  it('refuses an https deployment that is not explicitly in production mode', () => {
    const { NODE_ENV: _unused, ...withoutNodeEnv } = base;
    expect(() => loadEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'development' })).toThrow(/NODE_ENV/);
    expect(loadEnv({ ...base, NODE_ENV: 'development', AUTH_URL: 'http://localhost:3000' })).toBeTruthy();
  });

  it('requires the Cyrus admin password unless the memory engine is used', () => {
    const { CYRUS_ADMIN_PASSWORD: _unused, ...withoutCyrus } = base;
    expect(() => loadEnv(withoutCyrus)).toThrow(/CYRUS_ADMIN_PASSWORD/);
    expect(loadEnv({ ...withoutCyrus, MAIL_ENGINE: 'memory' }).MAIL_ENGINE).toBe('memory');
  });

  it('refuses to skip domain verification in production', () => {
    expect(() => loadEnv({ ...base, DOMAIN_VERIFICATION: 'skip' })).toThrow(/DOMAIN_VERIFICATION/);
  });

  it('keeps internal endpoints disabled unless a long token is set', () => {
    expect(loadEnv(base).INTERNAL_API_TOKEN).toBeUndefined();
    expect(() => loadEnv({ ...base, INTERNAL_API_TOKEN: 'short' })).toThrow(/INTERNAL_API_TOKEN/);
  });

  it('requires Valkey in production', () => {
    const { VALKEY_URL: _unused, ...withoutValkey } = base;
    expect(() => loadEnv(withoutValkey)).toThrow(/VALKEY_URL/);
  });

  it('rejects a short secret', () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects anything other than true/false for booleans', () => {
    expect(() => loadEnv({ ...base, ALLOW_SIGNUP: 'yes' })).toThrow(/ALLOW_SIGNUP/);
  });
  it('treats an empty SYSTEM_MAIL_FROM as unset and rejects a malformed one', () => {
    expect(loadEnv({ ...base, SYSTEM_MAIL_FROM: '' }).SYSTEM_MAIL_FROM).toBeUndefined();
    expect(loadEnv({ ...base, SYSTEM_MAIL_FROM: 'notices@example.com' }).SYSTEM_MAIL_FROM).toBe('notices@example.com');
    expect(() => loadEnv({ ...base, SYSTEM_MAIL_FROM: 'not an address' })).toThrow(/SYSTEM_MAIL_FROM/);
  });
  it('requires encrypted internal traffic in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      AUTH_URL: 'https://mail.example.com',
      VALKEY_URL: 'redis://valkey:6379',
      DOMAIN_VERIFICATION: 'dns',
      INTERNAL_API_TOKEN: 'internal-token-that-is-long-enough-for-this',
      INTERNAL_TLS_CERT_FILE: '/certs/fullchain.pem',
      INTERNAL_TLS_KEY_FILE: '/certs/api-privkey.pem',
      CYRUS_JMAP_URL: 'https://cyrus:8008',
    };
    expect(() => loadEnv(production)).not.toThrow();
    expect(() => loadEnv({ ...production, CYRUS_JMAP_URL: 'http://cyrus:8008' })).toThrow(/CYRUS_JMAP_URL/);
    expect(() => loadEnv({ ...production, INTERNAL_TLS_KEY_FILE: undefined })).toThrow(/INTERNAL_TLS/);
  });
});
