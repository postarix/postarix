import net from 'node:net';
import tls from 'node:tls';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

/** Endpoints of the stack started with docker/compose/test.yml. */
export const config = {
  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  host: process.env.MAIL_HOST ?? '127.0.0.1',
  smtpPort: Number(process.env.SMTP_PORT ?? 2525),
  submissionPort: Number(process.env.SUBMISSION_PORT ?? 5870),
  submissionsPort: Number(process.env.SUBMISSIONS_PORT ?? 4650),
  sievePort: Number(process.env.SIEVE_PORT ?? 41900),
  imapsPort: Number(process.env.IMAPS_PORT ?? 9930),
  imapPort: Number(process.env.IMAP_PORT ?? 1430),
  davUrl: process.env.DAV_URL ?? 'http://localhost:8085',
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@postarix.test',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'integration admin password',
  /** The mail server's own name, as the API reaches it (test.yml allows importing from it). */
  importHost: process.env.IMPORT_HOST ?? 'mail.postarix.test',
};

/** Minimal API client that keeps the session cookie between calls. */
export class ApiClient {
  private cookies = new Map<string, string>();

  /** A request whose response is not JSON (downloads). */
  async raw(path: string): Promise<{ status: number; headers: Headers; text: string }> {
    const headers: Record<string, string> = { origin: config.apiUrl };
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${config.apiUrl}${path}`, { headers });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { origin: config.apiUrl };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name) this.cookies.set(name.trim(), rest.join('='));
    }
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  async ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, body: result } = await this.request<T>(method, path, body);
    if (status < 200 || status >= 300) {
      throw new Error(`${method} ${path} → ${status}: ${JSON.stringify(result)}`);
    }
    return result;
  }

  async signIn(email: string, password: string): Promise<void> {
    // The API limits sign-ins (3 per 10 s per client, as in production); wait it out.
    for (let attempt = 0; ; attempt++) {
      const { status, body } = await this.request('POST', '/api/auth/sign-in/email', { email, password });
      if (status === 200) return;
      if (status !== 429 || attempt >= 5) {
        throw new Error(`sign-in as ${email} → ${status}: ${JSON.stringify(body)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }
}

export function smtp(port: number, auth?: { user: string; pass: string }) {
  return nodemailer.createTransport({
    host: config.host,
    port,
    secure: port === config.submissionsPort,
    requireTLS: port === config.submissionPort,
    ignoreTLS: port === config.smtpPort && !auth,
    // The test stack uses a self-signed certificate.
    tls: { rejectUnauthorized: false },
    ...(auth ? { auth } : {}),
  });
}

export async function imapLogin(
  user: string,
  pass: string,
  options: { starttls?: boolean } = {},
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.host,
    port: options.starttls ? config.imapPort : config.imapsPort,
    secure: !options.starttls,
    ...(options.starttls ? { doSTARTTLS: true } : {}),
    tls: { rejectUnauthorized: false },
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  return client;
}

/** Whether an IMAP login succeeds (and the connection is then closed). */
export async function canLogin(user: string, pass: string): Promise<boolean> {
  try {
    const client = await imapLogin(user, pass);
    await client.logout();
    return true;
  } catch {
    return false;
  }
}

/** Polls a mailbox until a message with the subject arrives; returns its raw source. */
export async function waitForMessage(
  user: string,
  pass: string,
  subject: string,
  timeoutMs = 45_000,
  folder = 'INBOX',
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const client = await imapLogin(user, pass);
  try {
    while (Date.now() < deadline) {
      // A folder a Sieve script creates on delivery may not exist yet.
      const lock = await client.getMailboxLock(folder).catch(() => null);
      if (!lock) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      try {
        const uids = await client.search({ subject }, { uid: true });
        if (uids && uids.length > 0) {
          const message = await client.fetchOne(String(uids[0]), { source: true }, { uid: true });
          if (message && message.source) return message.source.toString('utf8');
        }
      } finally {
        lock.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`No message with subject "${subject}" reached ${user} within ${timeoutMs} ms`);
  } finally {
    await client.logout();
  }
}

export const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Uploads and activates a Sieve script over ManageSieve (STARTTLS, PLAIN), as
 * a mail app's filter editor does. Rejects with the server's answer on failure.
 */
export async function putSieveScript(user: string, pass: string, script: string, name = 'postarix-test'): Promise<void> {
  // On a Murder, the frontend learns a brand-new mailbox from the mupdate
  // server within seconds; until then its ManageSieve login fails.
  for (let attempt = 0; ; attempt++) {
    try {
      return await putSieveScriptOnce(user, pass, script, name);
    } catch (error) {
      if (attempt >= 5 || !/Authentication Error/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function putSieveScriptOnce(user: string, pass: string, script: string, name: string): Promise<void> {
  let socket: net.Socket | tls.TLSSocket = net.connect(config.sievePort, config.host);
  socket.setEncoding('utf8');
  let buffer = '';
  let waiter: ((response: string) => void) | null = null;
  const complete = () => {
    if (waiter && /(^|\r\n)(OK|NO|BYE)[^\r\n]*\r\n$/.test(buffer)) {
      const response = buffer;
      buffer = '';
      const resolve = waiter;
      waiter = null;
      resolve(response);
    }
  };
  const onData = (chunk: string) => {
    buffer += chunk;
    complete();
  };
  const next = () =>
    new Promise<string>((resolve) => {
      waiter = resolve;
      complete();
    });
  const expectOk = async (command?: string) => {
    if (command !== undefined) socket.write(`${command}\r\n`);
    const response = await next();
    if (!/(^|\r\n)OK/.test(response)) throw new Error(`ManageSieve: ${command ?? 'greeting'} → ${response.trim()}`);
    return response;
  };
  socket.on('data', onData);
  try {
    await expectOk();
    await expectOk('STARTTLS');
    socket.removeListener('data', onData);
    socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secure = tls.connect({ socket: socket as net.Socket, rejectUnauthorized: false }, () => resolve(secure));
      secure.once('error', reject);
    });
    socket.setEncoding('utf8');
    socket.on('data', onData);
    await expectOk(); // capabilities again after STARTTLS
    await expectOk(`AUTHENTICATE "PLAIN" "${Buffer.from(`\0${user}\0${pass}`).toString('base64')}"`);
    await expectOk(`PUTSCRIPT "${name}" {${Buffer.byteLength(script)}+}\r\n${script}`);
    await expectOk(`SETACTIVE "${name}"`);
    socket.write('LOGOUT\r\n');
  } finally {
    socket.end();
  }
}

/** Waits a while and fails if a message with the subject arrives. */
export async function expectNoMessage(user: string, pass: string, subject: string, waitMs = 12_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const client = await imapLogin(user, pass);
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ subject }, { uid: true });
      if (uids && uids.length > 0) throw new Error(`Unexpected message "${subject}" reached ${user}`);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
