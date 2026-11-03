import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mailSettingsSchema, parseSettingsScript, renderSettingsScript } from './sieve-settings.js';

describe('webmail Sieve settings', () => {
  it('writes nothing when everything is off', () => {
    expect(renderSettingsScript(DEFAULT_SETTINGS)).toBeNull();
  });

  it('writes a vacation reply with an end date and a forward that keeps a copy, and reads them back', () => {
    const settings = {
      filters: [],
      vacation: { enabled: true, subject: 'Away "until" Monday', message: 'Back soon.\nC:\\temp', until: '2026-12-01' },
      forwarding: { enabled: true, address: 'me@elsewhere.example', keepCopy: true },
    };
    const script = renderSettingsScript(settings)!;
    expect(script).toContain('require ["vacation", "date", "relational", "copy"];');
    expect(script).toContain('if currentdate :value "le" "date" "2026-12-01" {');
    expect(script).toContain('vacation :days 3 :subject "Away \\"until\\" Monday" "Back soon.\nC:\\\\temp";');
    expect(script).toContain('redirect :copy "me@elsewhere.example";');
    expect(parseSettingsScript(script)).toEqual({ ...settings, taggedMail: 'inbox' });
  });

  it('forwards without a copy when asked, and ignores scripts it did not write', () => {
    const script = renderSettingsScript({ ...DEFAULT_SETTINGS, forwarding: { enabled: true, address: 'a@b.example', keepCopy: false } })!;
    expect(script).toContain('redirect "a@b.example";');
    expect(script).not.toContain('copy');
    expect(parseSettingsScript('require ["fileinto"];\nfileinto "Lists";')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettingsScript(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('writes filters: flags first, then the first matching move or delete', () => {
    const script = renderSettingsScript({
      ...DEFAULT_SETTINGS,
      filters: [
        { field: 'from', contains: 'news@shop.example', action: 'move', folder: 'Shopping' },
        { field: 'subject', contains: '[invoice]', action: 'label', keyword: 'label-invoices' },
        { field: 'to', contains: 'team@', action: 'markRead' },
        { field: 'subject', contains: 'Win "big"', action: 'delete' },
      ],
    })!;
    expect(script).toContain('require ["imap4flags", "fileinto"];');
    const body = script.split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('require'));
    expect(body.join('\n')).toBe(
      [
        'if header :contains "subject" "[invoice]" {',
        '  addflag "label-invoices";',
        '}',
        'if header :contains ["to", "cc"] "team@" {',
        '  addflag "\\\\Seen";',
        '}',
        'if header :contains "from" "news@shop.example" {',
        '  fileinto "Shopping";',
        '}',
        'elsif header :contains "subject" "Win \\"big\\"" {',
        '  fileinto "Trash";',
        '}',
        '',
      ].join('\n'),
    );
    expect(parseSettingsScript(script).filters).toHaveLength(4);
    // Older scripts had no filters.
    expect(parseSettingsScript(script.replace(/"filters":\[[^\]]*\],?/, '')).filters).toEqual([]);
  });

  it('refuses incomplete or malformed settings', () => {
    const bad = (patch: object) => !mailSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...patch }).success;
    expect(bad({ vacation: { enabled: true, subject: 'x', message: ' ', until: null } })).toBe(true);
    expect(bad({ vacation: { enabled: false, subject: 'two\nlines', message: '', until: null } })).toBe(true);
    expect(bad({ forwarding: { enabled: true, address: '', keepCopy: true } })).toBe(true);
    expect(bad({ forwarding: { enabled: true, address: 'not an address', keepCopy: true } })).toBe(true);
    expect(bad({ filters: [{ field: 'from', contains: 'x', action: 'move' }] })).toBe(true);
    expect(bad({ filters: [{ field: 'from', contains: 'x', action: 'label', keyword: 'Seen' }] })).toBe(true);
    expect(bad({ filters: [{ field: 'body', contains: 'x', action: 'delete' }] })).toBe(true);
  });
});

describe('tagged mail', () => {
  it('files ann+tag@ mail in a folder named after the tag, except Junk', () => {
    const script = renderSettingsScript({ ...DEFAULT_SETTINGS, taggedMail: 'folder' })!;
    expect(script).toContain('require ["envelope", "subaddress", "variables", "fileinto", "mailbox"];');
    expect(script).toContain('fileinto :create "${tag}";');
    expect(script).toContain('"Junk"');
    expect(parseSettingsScript(script).taggedMail).toBe('folder');
  });

  it('marks the subject instead', () => {
    const script = renderSettingsScript({ ...DEFAULT_SETTINGS, taggedMail: 'subject' })!;
    expect(script).toContain('addheader "Subject" "[${tag}] ${subject}";');
  });

  it('writes no script for the default', () => {
    expect(renderSettingsScript(DEFAULT_SETTINGS)).toBeNull();
  });
});
