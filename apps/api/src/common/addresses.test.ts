import { describe, expect, it } from 'vitest';
import { normalizeAddress, normalizeLocalPart } from './addresses.js';

describe('normalizeLocalPart', () => {
  it.each([
    ['Alice', 'alice'],
    ['first.last', 'first.last'],
    ['a_b-c', 'a_b-c'],
    ['x', 'x'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeLocalPart(input)).toBe(expected);
  });

  it.each(['', '.a', 'a.', 'a..b', 'a+b', 'a/b', 'a b', 'a@b', 'ñ', 'a'.repeat(65), '"a"'])(
    'rejects %j',
    (input) => {
      expect(normalizeLocalPart(input)).toBeNull();
    },
  );
});

describe('normalizeAddress', () => {
  it.each([
    ['Bob@Example.COM', 'bob@example.com'],
    ['bob+news@example.com', 'bob+news@example.com'],
    ['o\'brien@example.com', "o'brien@example.com"],
    ['x@münchen.de', 'x@xn--mnchen-3ya.de'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  it.each([
    'bob',
    '@example.com',
    'bob@',
    'bob@localhost',
    'a,b@example.com',
    'a b@example.com',
    '"a"@example.com',
    '.a@example.com',
    'a..b@example.com',
    'a@b@example.com',
  ])('rejects %j', (input) => {
    expect(normalizeAddress(input)).toBeNull();
  });
});
