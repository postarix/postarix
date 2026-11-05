import { describe, expect, it } from 'vitest';
import { messageIdOf, setSenderHeader, stripBccHeader } from './raw-message.js';

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

describe('setSenderHeader and messageIdOf', () => {
  it('replaces any Sender header and reads the Message-ID', () => {
    const raw = Buffer.from('From: team@x.test\r\nSender: someone@else.test\r\n  continued\r\nMessage-ID:\r\n <abc@x.test>\r\nSubject: hi\r\n\r\nBody\r\nSender: not a header\r\n');
    const out = setSenderHeader(raw, '"Ann" <ann@x.test>').toString();
    expect(out).toBe('From: team@x.test\r\nMessage-ID:\r\n <abc@x.test>\r\nSubject: hi\r\nSender: "Ann" <ann@x.test>\r\n\r\nBody\r\nSender: not a header\r\n');
    expect(messageIdOf(raw)).toBe('<abc@x.test>');
    expect(messageIdOf(Buffer.from('Subject: x\r\n\r\nbody'))).toBeNull();
  });
});
