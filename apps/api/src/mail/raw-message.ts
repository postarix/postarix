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
