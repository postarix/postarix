/**
 * Removes every Bcc header from a raw RFC 5322 message: the draft keeps its
 * Bcc recipients, but the copy that leaves must not reveal them.
 */
export function stripBccHeader(raw: Buffer): Buffer {
  const text = raw.toString('latin1'); // byte-preserving
  const match = /\r?\n\r?\n/.exec(text);
  const headerEnd = match ? match.index : text.length;
  const separator = match ? match[0] : '';
  const header = text.slice(0, headerEnd);
  const body = text.slice(headerEnd + separator.length);
  const newline = header.includes('\r\n') ? '\r\n' : '\n';

  const kept: string[] = [];
  let skipping = false;
  for (const line of header.split(/\r?\n/)) {
    const continuation = line.startsWith(' ') || line.startsWith('\t');
    if (continuation) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^bcc\s*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return Buffer.from(kept.join(newline) + separator + body, 'latin1');
}

function splitHeader(raw: Buffer): { header: string; separator: string; body: string; newline: string } {
  const text = raw.toString('latin1'); // byte-preserving
  const match = /\r?\n\r?\n/.exec(text);
  const headerEnd = match ? match.index : text.length;
  const header = text.slice(0, headerEnd);
  return {
    header,
    separator: match ? match[0] : '',
    body: text.slice(headerEnd + (match ? match[0].length : 0)),
    newline: header.includes('\r\n') ? '\r\n' : '\n',
  };
}

/**
 * Replaces any Sender header with `value` ("Name <address>"): who sent a
 * message on behalf of the From address (RFC 5322 §3.6.2).
 */
export function setSenderHeader(raw: Buffer, value: string): Buffer {
  const { header, separator, body, newline } = splitHeader(raw);
  const kept: string[] = [];
  let skipping = false;
  for (const line of header.split(/\r?\n/)) {
    const continuation = line.startsWith(' ') || line.startsWith('\t');
    if (continuation) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^sender\s*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  kept.push(`Sender: ${value}`);
  return Buffer.from(kept.join(newline) + (separator || newline + newline) + body, 'latin1');
}

/** The message's Message-ID, if it has one. */
export function messageIdOf(raw: Buffer): string | null {
  const { header } = splitHeader(raw);
  const match = /^message-id\s*:\s*(<[^>\r\n]{1,250}>)/im.exec(header.replace(/\r?\n[ \t]+/g, ' '));
  return match ? match[1]! : null;
}
