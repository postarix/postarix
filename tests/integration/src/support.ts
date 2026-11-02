import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

/** Endpoints of the stack started with docker/compose/test.yml. */
export const config = {
  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  host: process.env.MAIL_HOST ?? '127.0.0.1',
  smtpPort: Number(process.env.SMTP_PORT ?? 2525),
  submissionPort: Number(process.env.SUBMISSION_PORT ?? 5870),
  submissionsPort: Number(process.env.SUBMISSIONS_PORT ?? 4650),
  imapsPort: Number(process.env.IMAPS_PORT ?? 9930),
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@postarix.test',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'integration admin password',
};

/** Minimal API client that keeps the session cookie between calls. */
export class ApiClient {
  private cookies = new Map<string, string>();

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
    await this.ok('POST', '/api/auth/sign-in/email', { email, password });
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

export async function imapLogin(user: string, pass: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.host,
    port: config.imapsPort,
    secure: true,
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
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const client = await imapLogin(user, pass);
  try {
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock('INBOX');
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
