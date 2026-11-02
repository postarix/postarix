import { describe, expect, it } from 'vitest';
import { stripBccHeader } from './raw-message.js';

describe('stripBccHeader', () => {
  it('removes Bcc headers, folded lines included, and nothing else', () => {
    const raw = [
      'From: Ann <ann@example.com>',
      'To: bob@example.com',
      'BCC: secret@example.com,',
      '\tother-secret@example.com',
      'Subject: Hi',
      'bcc:third@example.com',
      '',
      'Bcc: this line is in the body and stays',
      '',
    ].join('\r\n');
    const out = stripBccHeader(Buffer.from(raw)).toString();
    expect(out).toBe(
      ['From: Ann <ann@example.com>', 'To: bob@example.com', 'Subject: Hi', '', 'Bcc: this line is in the body and stays', ''].join(
        '\r\n',
      ),
    );
  });

  it('keeps bytes that are not UTF-8 intact', () => {
    const raw = Buffer.concat([Buffer.from('Subject: x\r\nBcc: y\r\n\r\n'), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
    const out = stripBccHeader(raw);
    expect(out.subarray(-4)).toEqual(Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    expect(out.toString('latin1').startsWith('Subject: x\r\n\r\n')).toBe(true);
  });
});
