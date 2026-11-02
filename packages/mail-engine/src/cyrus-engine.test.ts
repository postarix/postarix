import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { CyrusEngine, jmapUrl, parseAcl, sharesFromAcl } from './cyrus-engine.js';
import { ImapConnection, quote } from './imap-connection.js';
import { MailEngineError } from './types.js';

type Handler = (command: string, tag: string) => string | string[];

/** A scripted IMAP server: records commands and answers through `handler`. */
async function fakeServer(handler: Handler) {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK fake IMAP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const space = line.indexOf(' ');
        const tag = line.slice(0, space);
        const command = line.slice(space + 1);
        received.push(command);
        if (command === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK bye\r\n`);
          continue;
        }
        const reply = handler(command, tag);
        socket.write((Array.isArray(reply) ? reply : [reply]).join('\r\n') + '\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return { port, received, close };
}

const ok = (_: string, tag: string) => `${tag} OK done`;

describe('quote', () => {
  it('escapes quotes and backslashes', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('refuses control characters and non-ASCII', () => {
    expect(() => quote('a\r\nb')).toThrow();
    expect(() => quote('café')).toThrow();
  });
});

describe('ImapConnection', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('inlines server literals in untagged responses', async () => {
    const server = await fakeServer((command, tag) =>
      command === 'LIST "" "*"' ? ['* LIST () "/" {5}', 'INBOX', `${tag} OK listed`] : ok(command, tag),
    );
    close = server.close;
    const imap = await ImapConnection.connect({ host: '127.0.0.1', port: server.port, security: 'none' });
    const response = await imap.command('LIST "" "*"');
    expect(response.untagged).toEqual(['LIST () "/" INBOX']);
    await imap.logout();
  });

  it('refuses to continue in plaintext when STARTTLS is rejected', async () => {
    const server = await fakeServer((command, tag) =>
      command === 'STARTTLS' ? `${tag} BAD not supported` : ok(command, tag),
    );
    close = server.close;
    await expect(
      ImapConnection.connect({ host: '127.0.0.1', port: server.port, security: 'starttls' }),
    ).rejects.toThrow(/STARTTLS/);
  });
});

describe('ImapConnection TLS verification', () => {
  // Test-only self-signed certificate for mail.example.test.
  const cert = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url), 'utf8');
  const key = readFileSync(new URL('./fixtures/test-key.pem', import.meta.url), 'utf8');
  let server: tls.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function tlsServer(): Promise<number> {
    server = tls.createServer({ cert, key }, (socket) => {
      socket.on('error', () => undefined);
      socket.write('* OK fake IMAPS ready\r\n');
    });
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  it('rejects an untrusted certificate by default', async () => {
    const port = await tlsServer();
    await expect(
      ImapConnection.connect({ host: '127.0.0.1', port, security: 'tls', servername: 'mail.example.test' }),
    ).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it('accepts a pinned certificate for the expected name only', async () => {
    const port = await tlsServer();
    const imap = await ImapConnection.connect({
      host: '127.0.0.1',
      port,
      security: 'tls',
      servername: 'mail.example.test',
      ca: () => cert,
    });
    imap.destroy();

    await expect(
      ImapConnection.connect({ host: '127.0.0.1', port, security: 'tls', servername: 'other.example', ca: () => cert }),
    ).rejects.toThrow(/other\.example|altnames|Hostname/i);
  });
});

describe('CyrusEngine', () => {
  let server: Awaited<ReturnType<typeof fakeServer>>;
  afterEach(async () => server?.close());

  const engineFor = (port: number) =>
    new CyrusEngine({
      host: '127.0.0.1',
      port,
      security: 'none',
      adminUser: 'cyrus',
      adminPassword: 'pa"ss',
    });

  it('creates a mailbox with a quota in KiB', async () => {
    server = await fakeServer(ok);
    await engineFor(server.port).createMailbox('alice@example.com', { quotaBytes: 1_048_576 });
    expect(server.received).toEqual([
      'LOGIN "cyrus" "pa\\"ss"',
      'CREATE "user/alice@example.com"',
      'CREATE "user/alice/Drafts@example.com" (USE (\\Drafts))',
      'CREATE "user/alice/Sent@example.com" (USE (\\Sent))',
      'CREATE "user/alice/Trash@example.com" (USE (\\Trash))',
      'CREATE "user/alice/Junk@example.com" (USE (\\Junk))',
      'CREATE "user/alice/Archive@example.com" (USE (\\Archive))',
      'SETACL "user/alice/Junk@example.com" anyone p',
      'SETQUOTA "user/alice@example.com" (STORAGE 1024)',
      'LOGOUT',
    ]);
  });

  it('removes a partly created mailbox when a later step fails', async () => {
    server = await fakeServer((command, tag) =>
      command.startsWith('CREATE "user/alice/Trash') ? `${tag} NO disk full` : `${tag} OK done`,
    );
    await expect(
      engineFor(server.port).createMailbox('alice@example.com', { quotaBytes: null }),
    ).rejects.toBeInstanceOf(MailEngineError);
    expect(server.received).toContain('DELETE "user/alice@example.com"');
  });

  it('skips SETQUOTA for unlimited mailboxes', async () => {
    server = await fakeServer(ok);
    await engineFor(server.port).createMailbox('bob@example.com', { quotaBytes: null });
    expect(server.received).not.toContainEqual(expect.stringMatching(/^SETQUOTA/));
  });

  it('grants itself the delete right before deleting', async () => {
    server = await fakeServer(ok);
    await engineFor(server.port).deleteMailbox('alice@example.com');
    expect(server.received.slice(1, 3)).toEqual([
      'SETACL "user/alice@example.com" "cyrus" lrswipkxtecdan',
      'DELETE "user/alice@example.com"',
    ]);
  });

  it('maps server errors to engine error codes', async () => {
    server = await fakeServer((command, tag) => {
      if (command.startsWith('CREATE')) return `${tag} NO [ALREADYEXISTS] Mailbox already exists`;
      if (command.startsWith('RENAME')) return `${tag} NO [NONEXISTENT] Mailbox does not exist`;
      return ok(command, tag);
    });
    const engine = engineFor(server.port);
    await expect(engine.createMailbox('a@example.com', { quotaBytes: null })).rejects.toMatchObject({
      code: 'already_exists',
    });
    await expect(engine.renameMailbox('a@example.com', 'b@example.com')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reports unavailability when login fails', async () => {
    server = await fakeServer((command, tag) =>
      command.startsWith('LOGIN') ? `${tag} NO authentication failed` : ok(command, tag),
    );
    const error = await engineFor(server.port)
      .createMailbox('a@example.com', { quotaBytes: null })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailEngineError);
    expect((error as MailEngineError).code).toBe('unavailable');
  });

  it('parses usage from GETQUOTAROOT', async () => {
    server = await fakeServer((command, tag) =>
      command.startsWith('GETQUOTAROOT')
        ? [
            '* QUOTAROOT "user/alice@example.com" "user/alice@example.com"',
            '* QUOTA "user/alice@example.com" (STORAGE 10 2048)',
            `${tag} OK done`,
          ]
        : ok(command, tag),
    );
    await expect(engineFor(server.port).getUsage('alice@example.com')).resolves.toEqual({
      usedBytes: 10 * 1024,
      quotaBytes: 2048 * 1024,
    });
  });

  it('rejects addresses that could escape the mailbox namespace', async () => {
    expect(() => CyrusEngine.mailboxName('first.last+tag@example.com')).not.toThrow();
    // '/' is Cyrus' hierarchy separator: it would address someone else's folders.
    expect(() => CyrusEngine.mailboxName('../etc@example.com')).toThrow();
    expect(() => CyrusEngine.mailboxName('bob/Sent@example.com')).toThrow();
    expect(() => CyrusEngine.mailboxName('a b@example.com')).toThrow();
    expect(() => CyrusEngine.mailboxName('Alice@Example.com')).toThrow();
    expect(() => CyrusEngine.mailboxName('a"@example.com')).toThrow();
    expect(() => CyrusEngine.mailboxName('*@example.com')).toThrow(); // IMAP wildcard
    expect(() => CyrusEngine.mailboxName('a%b@example.com')).toThrow();
  });
});

describe('CyrusEngine JMAP', () => {
  it('builds URLs below /jmap/ and refuses to climb out of it', () => {
    expect(jmapUrl('http://cyrus:8008', '', '').href).toBe('http://cyrus:8008/jmap/');
    expect(jmapUrl('http://cyrus:8008', 'download/u1/B12/file%20name.pdf', 'accept=application/pdf').href).toBe(
      'http://cyrus:8008/jmap/download/u1/B12/file%20name.pdf?accept=application/pdf',
    );
    for (const bad of ['../admin', 'upload/%2e%2e/x', 'a/%2E./b', '/etc', 'x\\y', 'a%2fb', 'http://evil/', 'a b', 'a?b']) {
      expect(() => jmapUrl('http://cyrus:8008', bad, ''), bad).toThrow(MailEngineError);
    }
  });

  it('sends requests as the mailbox owner, with the password the caller provides', async () => {
    const seen: { url?: string; auth?: string; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        Object.assign(seen, {
          url: req.url,
          auth: req.headers.authorization,
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const engine = new CyrusEngine({
        host: '127.0.0.1',
        port: 1,
        security: 'none',
        adminUser: 'cyrus',
        adminPassword: 'x',
        jmap: { url: `http://127.0.0.1:${port}`, password: (address) => `token-for-${address}` },
      });
      const res = await engine.jmap('alice@example.com', {
        method: 'POST',
        path: '',
        query: '',
        contentType: 'application/json',
        body: new TextEncoder().encode('{"using":[]}'),
      });
      expect(await res.json()).toEqual({ ok: true });
      expect(seen).toEqual({
        url: '/jmap/',
        auth: `Basic ${Buffer.from('alice@example.com:token-for-alice@example.com').toString('base64')}`,
        body: '{"using":[]}',
      });
      await expect(engine.jmap('not an address', { method: 'GET', path: '', query: '' })).rejects.toThrow(MailEngineError);
    } finally {
      server.close();
    }
  });
});

describe('collection sharing ACLs', () => {
  it('reads who a collection is shared with, leaving out the owner, the admin and "anyone"', () => {
    const acl = parseAcl([
      'ACL "user/ann/#calendars/Default@example.com" ann@example.com lrswipkxtecdan9 anyone 9 ben@example.com lrw9 cyrus lrswipkxtecdan',
      'ACL user/ann/#calendars/Default@example.com carl@example.com lrswitedn5679 dora@example.com 9',
    ]);
    expect(acl.get('anyone')).toBe('9');
    expect(sharesFromAcl(acl, 'ann@example.com', 'cyrus')).toEqual([
      { grantee: 'ben@example.com', access: 'read' },
      { grantee: 'carl@example.com', access: 'write' },
    ]);
  });
});
