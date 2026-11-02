import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mailSettingsSchema, parseSettingsScript, renderSettingsScript } from './sieve-settings.js';

describe('webmail Sieve settings', () => {
  it('writes nothing when everything is off', () => {
    expect(renderSettingsScript(DEFAULT_SETTINGS)).toBeNull();
  });

  it('writes a vacation reply with an end date and a forward that keeps a copy, and reads them back', () => {
    const settings = {
      vacation: { enabled: true, subject: 'Away "until" Monday', message: 'Back soon.\nC:\\temp', until: '2026-12-01' },
      forwarding: { enabled: true, address: 'me@elsewhere.example', keepCopy: true },
    };
    const script = renderSettingsScript(settings)!;
    expect(script).toContain('require ["vacation", "date", "relational", "copy"];');
    expect(script).toContain('if currentdate :value "le" "date" "2026-12-01" {');
    expect(script).toContain('vacation :days 3 :subject "Away \\"until\\" Monday" "Back soon.\nC:\\\\temp";');
    expect(script).toContain('redirect :copy "me@elsewhere.example";');
    expect(parseSettingsScript(script)).toEqual(settings);
  });

  it('forwards without a copy when asked, and ignores scripts it did not write', () => {
    const script = renderSettingsScript({ ...DEFAULT_SETTINGS, forwarding: { enabled: true, address: 'a@b.example', keepCopy: false } })!;
    expect(script).toContain('redirect "a@b.example";');
    expect(script).not.toContain('copy');
    expect(parseSettingsScript('require ["fileinto"];\nfileinto "Lists";')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettingsScript(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('refuses incomplete or malformed settings', () => {
    const bad = (patch: object) => !mailSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...patch }).success;
    expect(bad({ vacation: { enabled: true, subject: 'x', message: ' ', until: null } })).toBe(true);
    expect(bad({ vacation: { enabled: false, subject: 'two\nlines', message: '', until: null } })).toBe(true);
    expect(bad({ forwarding: { enabled: true, address: '', keepCopy: true } })).toBe(true);
    expect(bad({ forwarding: { enabled: true, address: 'not an address', keepCopy: true } })).toBe(true);
  });
});
