import { describe, expect, it } from 'vitest';
import { normalizeDomainName } from './domain-name.js';

describe('normalizeDomainName', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  EXAMPLE.com.  ', 'example.com'],
    ['mail.sub.example.co', 'mail.sub.example.co'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
    ['a-b.example', 'a-b.example'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeDomainName(input)).toBe(expected);
  });

  it.each([
    '',
    '.',
    'localhost',
    '127.0.0.1',
    '::1',
    '-a.example',
    'a-.example',
    'a..example',
    'exa_mple.com',
    'example.123',
    `${'a'.repeat(64)}.example`,
    `${'a.'.repeat(127)}com`,
    'weird.example/../../etc',
    'pct%2eexample',
    'q.example?x=1',
    'b.example\\c',
    'user@example.com',
    'example.com:25',
  ])('rejects %j', (input) => {
    expect(normalizeDomainName(input)).toBeNull();
  });
});
