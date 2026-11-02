import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type MailEngine, MailEngineError } from '@postarix/mail-engine';
import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import type { Auth } from '../auth/auth.js';
import { SECOND_FACTOR_REQUIRED, SecondFactorPolicy } from '../auth/second-factor-policy.js';
import { originCheck } from '../common/origin-check.middleware.js';
import type { Env } from '../config/env.js';
import { AUTH, DATABASE, ENV, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { findOwnMailbox } from './my-mailbox.js';

/** Largest JMAP API request (method calls), well above what clients send. */
const API_BODY_LIMIT = 10 * 1024 * 1024;

/** The JMAP resources the webmail may reach, relative to the JMAP root. */
const ALLOWED_PATHS: Record<'GET' | 'POST', RegExp> = {
  GET: /^(?:|download\/[^/]+\/[^/]+\/[^/]+|eventsource\/?)$/,
  POST: /^(?:|upload\/[^/]+\/?)$/,
};

/**
 * The JMAP capabilities and methods the webmail may use. Everything else Cyrus
 * offers stays out of reach: EmailSubmission (sending goes through
 * /api/mail/send, which checks the sender and rate limits), Sieve scripts,
 * vacation responses (Cyrus cannot send them yet), backups, administration.
 */
export const ALLOWED_CAPABILITIES = new Set([
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:calendars',
  'https://cyrusimap.org/ns/jmap/contacts',
]);
const ALLOWED_METHODS =
  /^(?:Mailbox\/(?:get|changes|query|queryChanges|set)|Email\/(?:get|changes|query|queryChanges|set|copy|import|parse)|Thread\/(?:get|changes)|SearchSnippet\/get|Blob\/(?:copy|get|lookup)|Calendar\/(?:get|changes)|CalendarEvent\/(?:get|changes|query|queryChanges|set)|AddressBook\/(?:get|changes)|Contact\/(?:get|changes|query|queryChanges|set))$/;

/** Download types a browser may render inline; everything else is an attachment. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** Session-resource fields holding URLs (RFC 8620 §2). */
const SESSION_URL_FIELDS = ['apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const;

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * /api/jmap/*: JMAP for the webmail. The signed-in user always acts as the
 * owner of their own mailbox; nothing in the request selects the account
 * Cyrus logs in as. Cyrus enforces mailbox rights from there.
 *
 * It is plain Express middleware (mounted before the body parsers) because it
 * streams uploads, downloads and server-sent events.
 */
@Injectable()
export class JmapProxy {
  private readonly logger = new Logger(JmapProxy.name);
  private readonly checkOrigin;
  private readonly publicRoot: string;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
    @Inject(ENV) private readonly env: Env,
    @Inject(SecondFactorPolicy) private readonly secondFactor: SecondFactorPolicy,
  ) {
    this.checkOrigin = originCheck([env.AUTH_URL, ...env.TRUSTED_ORIGINS]);
    // Path-only, so the URLs work wherever the webmail is served from (behind
    // the reverse proxy, or by the webmail server forwarding /api).
    this.publicRoot = '/api/jmap/';
  }

  /** Express handler, to mount on /api/jmap. */
  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    this.checkOrigin(req, res, () => {
      this.serve(req, res).catch((error: unknown) => this.fail(res, error, next));
    });
  };

  private async serve(req: Request, res: Response): Promise<void> {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method !== 'GET' && method !== 'POST') throw new ProxyError(405, 'Method not allowed');

    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new ProxyError(401, 'Sign in first');
    if (!(await this.secondFactor.satisfied(session.user.id, session.session.id))) {
      throw new ProxyError(403, 'Your organization requires a second sign-in step. Set it up in your account settings.', SECOND_FACTOR_REQUIRED);
    }
    const address = await findOwnMailbox(this.db, session.user.id);
    if (!address) throw new ProxyError(404, 'You have no mailbox');

    const [rawPath = '', query = ''] = req.url.split(/\?(.*)/s, 2);
    const path = rawPath.replace(/^\//, '');
    if (!ALLOWED_PATHS[method].test(path)) throw new ProxyError(404, 'Not found');

    const isUpload = path.startsWith('upload/');
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let body: ReadableStream<Uint8Array> | Uint8Array | undefined;
    if (method === 'POST') {
      body = isUpload ? limitedBody(req, this.env.MAIL_UPLOAD_LIMIT) : checkApiRequest(await readAll(limitedBody(req, API_BODY_LIMIT)));
    }

    const upstream = await this.engine.jmap(address, {
      method,
      path,
      query,
      contentType: isUpload ? req.headers['content-type'] : method === 'POST' ? 'application/json' : undefined,
      accept: req.headers.accept,
      lastEventId: typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
      body,
      signal: abort.signal,
    });

    // The token is minted by us; Cyrus refusing it is a server problem, not the user's.
    if (upstream.status === 401 || upstream.status === 403) {
      this.logger.error(`Cyrus refused the JMAP login of ${address} (${upstream.status})`);
      throw new ProxyError(502, 'The mail server refused the request');
    }

    res.status(upstream.status);
    res.setHeader('cache-control', upstream.headers.get('cache-control') ?? 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');

    if (method === 'GET' && path === '' && upstream.ok) {
      res.json(this.rewriteSession((await upstream.json()) as Record<string, unknown>));
      return;
    }

    const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
    res.setHeader('content-type', type);
    // Not content-length: fetch may have decompressed the body.
    for (const header of ['etag', 'last-modified'] as const) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    if (path.startsWith('download/')) {
      // Blobs are untrusted content served from our origin: never let them run.
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      const inline = INLINE_TYPES.has(type.split(';')[0]!.trim().toLowerCase());
      let name = 'download';
      try {
        name = decodeURIComponent(path.split('/')[3] ?? 'download') || 'download';
      } catch {
        // Not valid percent-encoding: keep the generic name.
      }
      res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    }

    if (path.startsWith('eventsource')) {
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
    }

    if (!upstream.body) {
      res.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const body = Readable.fromWeb(upstream.body as WebReadableStream);
      body.on('error', (error) => (abort.signal.aborted ? resolve() : reject(error)));
      res.on('close', resolve);
      body.pipe(res);
    });
  }

  /**
   * Points the session's URLs at this proxy instead of Cyrus, and advertises
   * only the capabilities the proxy lets through.
   */
  private rewriteSession(session: Record<string, unknown>): Record<string, unknown> {
    const out = { ...session };
    const keep = (value: unknown) =>
      value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => ALLOWED_CAPABILITIES.has(key))) : value;
    out.capabilities = keep(out.capabilities);
    out.primaryAccounts = keep(out.primaryAccounts);
    if (out.accounts && typeof out.accounts === 'object') {
      out.accounts = Object.fromEntries(
        Object.entries(out.accounts as Record<string, Record<string, unknown>>).map(([id, account]) => [
          id,
          { ...account, accountCapabilities: keep(account.accountCapabilities) },
        ]),
      );
    }
    for (const field of SESSION_URL_FIELDS) {
      const value = out[field];
      if (typeof value === 'string') out[field] = value.replace(/^(?:https?:\/\/[^/]+)?\/jmap\//, this.publicRoot);
    }
    return out;
  }

  private fail(res: Response, error: unknown, next: NextFunction): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof ProxyError) {
      res.status(error.status).json({ statusCode: error.status, message: error.message, ...(error.code ? { code: error.code } : {}) });
      return;
    }
    if (error instanceof BodyTooLarge) {
      res.status(413).json({ statusCode: 413, message: 'Payload too large' });
      return;
    }
    if (error instanceof MailEngineError) {
      const status = error.code === 'rejected' ? 400 : 503;
      res.status(status).json({ statusCode: status, message: status === 503 ? 'The mail server is unavailable' : 'Bad request' });
      return;
    }
    next(error);
  }
}

class BodyTooLarge extends Error {}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Event properties that schedule (invite people), anywhere in an event or a patch path. */
const SCHEDULING_PROPERTIES = new Set(['participants', 'replyTo', 'sendSchedulingMessages', 'organizerCalendarAddress']);
const RULE_PROPERTIES = new Set(['recurrenceRules', 'excludedRecurrenceRules']);
const ALLOWED_FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

function checkRules(value: unknown): void {
  const rules = (Array.isArray(value) ? value : value ? [value] : []) as unknown[];
  for (const rule of rules) {
    const frequency = typeof rule === 'object' && rule ? (rule as { frequency?: unknown }).frequency : rule;
    if (frequency !== undefined && frequency !== null && !ALLOWED_FREQUENCIES.has(String(frequency))) {
      throw new ProxyError(403, 'Events may repeat at most daily');
    }
  }
}

/** Walks an event (or a patch) and its overrides, in object form and in patch paths ("a/b/c"). */
function checkEventObject(object: unknown, depth = 0): void {
  if (!object || typeof object !== 'object' || depth > 6) return;
  for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
    const path = key.split('/').filter(Boolean);
    if (path.some((segment) => SCHEDULING_PROPERTIES.has(segment))) throw new ProxyError(403, 'Inviting people to events is not available');
    const ruleAt = path.findIndex((segment) => RULE_PROPERTIES.has(segment));
    if (ruleAt !== -1) {
      // "recurrenceRules" (a list), "recurrenceRules/0" (a rule) or "recurrenceRules/0/frequency" (a value).
      if (ruleAt === path.length - 1) checkRules(value);
      else if (ruleAt === path.length - 2) checkRules([value]);
      else checkRules([{ frequency: value }]);
    }
    if (value && typeof value === 'object') checkEventObject(value, depth + 1);
  }
}

/**
 * Calendar events may not invite people (scheduling is off in Cyrus: invitations
 * would bypass the mail pipeline) nor repeat more often than daily (expanding
 * them would be expensive for the shared mail server). The arguments must be
 * given directly: a result reference ("#create") would bring in objects that
 * were never checked.
 */
function checkCalendarEventSet(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (key.startsWith('#')) throw new ProxyError(403, 'Result references are not available here');
    if (SCHEDULING_PROPERTIES.has(key)) throw new ProxyError(403, 'Inviting people to events is not available');
  }
  for (const object of [
    ...Object.values((args.create ?? {}) as Record<string, unknown>),
    ...Object.values((args.update ?? {}) as Record<string, unknown>),
  ]) {
    checkEventObject(object);
  }
}

/**
 * Checks a JMAP API request against the allowed capabilities and methods, and
 * returns it re-serialized (so what Cyrus parses is exactly what was checked).
 */
export function checkApiRequest(raw: Uint8Array): Uint8Array {
  let request: unknown;
  try {
    request = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    throw new ProxyError(400, 'The request is not valid JSON');
  }
  const { using, methodCalls } = (request ?? {}) as { using?: unknown; methodCalls?: unknown };
  if (!Array.isArray(using) || !Array.isArray(methodCalls)) throw new ProxyError(400, 'Not a JMAP request');
  for (const capability of using) {
    if (typeof capability !== 'string' || !ALLOWED_CAPABILITIES.has(capability)) {
      throw new ProxyError(403, `Capability not available: ${String(capability).slice(0, 100)}`);
    }
  }
  for (const call of methodCalls) {
    const name: unknown = Array.isArray(call) ? call[0] : undefined;
    if (typeof name !== 'string' || !ALLOWED_METHODS.test(name)) {
      throw new ProxyError(403, `Method not available: ${String(name).slice(0, 100)}`);
    }
    if (name === 'CalendarEvent/set' && Array.isArray(call) && call[1] && typeof call[1] === 'object') {
      checkCalendarEventSet(call[1] as Record<string, unknown>);
    }
  }
  return Buffer.from(JSON.stringify(request));
}

/** The request body as a web stream that fails once it exceeds `limit` bytes. */
function limitedBody(req: Request, limit: number): ReadableStream<Uint8Array> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  let seen = 0;
  const source = Readable.toWeb(req) as ReadableStream<Uint8Array>;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new BodyTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}
