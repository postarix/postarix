import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { internalSecret } from './internal-secrets.js';

describe('internal secrets', () => {
  it('differ per purpose and never equal the token', () => {
    const token = 'internal-test-token-that-is-long-enough';
    const values = (['mail-auth', 'submission', 'cyrus-smtp'] as const).map((p) => internalSecret(token, p));
    expect(new Set(values).size).toBe(3);
    expect(values).not.toContain(token);
  });

  it('match what the mail containers derive with openssl', () => {
    const token = 'internal-test-token-that-is-long-enough';
    const shell = execFileSync('sh', ['-c', `printf %s postarix:submission | openssl dgst -sha256 -hmac "$T" -r | cut -d' ' -f1`], {
      env: { ...process.env, T: token },
    })
      .toString()
      .trim();
    expect(internalSecret(token, 'submission')).toBe(shell);
  });
});
