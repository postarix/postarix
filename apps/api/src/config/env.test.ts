import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AUTH_URL: 'https://mail.example.com',
  AUTH_SECRET: 'x'.repeat(32),
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

  it('rejects a short secret', () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects anything other than true/false for booleans', () => {
    expect(() => loadEnv({ ...base, ALLOW_SIGNUP: 'yes' })).toThrow(/ALLOW_SIGNUP/);
  });
});
