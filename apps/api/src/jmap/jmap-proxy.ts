import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type MailEngine, MailEngineError } from '@postarix/mail-engine';
import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import type { Auth } from '../auth/auth.js';
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

/** Download types a browser may render inline; everything else is an attachment. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** Session-resource fields holding URLs (RFC 8620 §2). */
const SESSION_URL_FIELDS = ['apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const;

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
  ) {
    this.checkOrigin = originCheck([env.AUTH_URL, ...env.TRUSTED_ORIGINS]);
    this.publicRoot = new URL('/api/jmap/', env.AUTH_URL).href;
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
    const address = await findOwnMailbox(this.db, session.user.id);
    if (!address) throw new ProxyError(404, 'You have no mailbox');

    const [rawPath = '', query = ''] = req.url.split(/\?(.*)/s, 2);
    const path = rawPath.replace(/^\//, '');
    if (!ALLOWED_PATHS[method].test(path)) throw new ProxyError(404, 'Not found');

    const isUpload = path.startsWith('upload/');
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const upstream = await this.engine.jmap(address, {
      method,
      path,
      query,
      contentType: req.headers['content-type'],
      accept: req.headers.accept,
      lastEventId: typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
      body: method === 'POST' ? limitedBody(req, isUpload ? this.env.MAIL_UPLOAD_LIMIT : API_BODY_LIMIT) : undefined,
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
      const name = decodeURIComponent(path.split('/')[3] ?? 'download');
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

  /** Points the session's URLs at this proxy instead of Cyrus. */
  private rewriteSession(session: Record<string, unknown>): Record<string, unknown> {
    const out = { ...session };
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
      res.status(error.status).json({ statusCode: error.status, message: error.message });
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
