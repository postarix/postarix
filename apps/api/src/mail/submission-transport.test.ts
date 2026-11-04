import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { trustedCa } from './submission-transport.js';

describe('trustedCa', () => {
  it('adds the certificate file to the system roots, never replaces them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postarix-ca-'));
    const file = join(dir, 'fullchain.pem');
    writeFileSync(file, '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n');
    const { ca } = trustedCa(file);
    expect(ca).toHaveLength(rootCertificates.length + 1);
    expect(ca!.slice(0, -1)).toEqual([...rootCertificates]);
    expect(ca!.at(-1)).toContain('leaf');
  });

  it('leaves the defaults alone without a readable file', () => {
    expect(trustedCa(undefined)).toEqual({});
    expect(trustedCa('/nonexistent/fullchain.pem')).toEqual({});
  });
});
