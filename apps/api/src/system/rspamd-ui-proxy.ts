import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import type { Auth } from '../auth/auth.js';
import { SecondFactorPolicy } from '../auth/second-factor-policy.js';
import { hasInstanceAdminRole } from '../auth/roles.js';
import { originCheck } from '../common/origin-check.middleware.js';
import type { Env } from '../config/env.js';
import { AUTH, ENV } from '../core/tokens.js';

/** Largest upload (a message to learn as spam or ham). */
const BODY_LIMIT = 30 * 1024 * 1024;

/**
 * Rspamd's own web interface, for instance administrators, at
 * /api/rspamd-ui/. The administrator's session is the login: the proxy adds
 * the controller password itself (the enable password when set, which allows
 * changes such as learning; otherwise the read-only one), and drops whatever
 * password the browser sends. Nobody else gets through, and Rspamd's port is
 * never published.
 *
 * Plain Express middleware, mounted before the body parsers and helmet: it
 * streams bodies and sets its own security headers for Rspamd's pages.
 */
@Injectable()
export class RspamdUiProxy {
  private readonly logger = new Logger(RspamdUiProxy.name);
  private readonly checkOrigin;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(ENV) private readonly env: Env,
    @Inject(SecondFactorPolicy) private readonly secondFactor: SecondFactorPolicy,
  ) {
    this.checkOrigin = originCheck([env.AUTH_URL, ...env.TRUSTED_ORIGINS]);
  }

  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    this.checkOrigin(req, res, () => {
      this.serve(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof Refusal) {
          res.status(error.status).type('text/plain').send(error.message);
          return;
        }
        this.logger.warn(`Rspamd web interface: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.name === 'BodyTooLarge') {
          res.status(413).type('text/plain').send('Payload too large');
          return;
        }
        next(error);
      });
    });
  };

  private async serve(req: Request, res: Response): Promise<void> {
    const base = this.env.RSPAMD_CONTROLLER_URL;
    const password = this.env.RSPAMD_CONTROLLER_ENABLE_PASSWORD || this.env.RSPAMD_CONTROLLER_PASSWORD;
    // Hidden like every instance-admin route: 404 for everyone else.
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session || !hasInstanceAdminRole(session.user.role)) throw new Refusal(404, 'Not found');
    if (!(await this.secondFactor.satisfied(session.user.id, session.session.id))) throw new Refusal(403, 'Set up the second sign-in step first');
    if (!base || !password) throw new Refusal(503, 'The spam filter is not configured on this server');

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method !== 'GET' && method !== 'POST') throw new Refusal(405, 'Method not allowed');

    // Relative links in Rspamd's pages need the trailing slash.
    if (req.originalUrl.split('?')[0] === '/api/rspamd-ui') {
      res.redirect(308, '/api/rspamd-ui/');
      return;
    }
    const target = new URL(req.url.replace(/^\/+/, '/'), base);
    if (target.origin !== new URL(base).origin) throw new Refusal(400, 'Bad request');

    const headers: Record<string, string> = { password };
    for (const name of ['accept', 'content-type', 'flag', 'weight', 'classifier', 'map', 'deliver-to']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await fetch(target, {
      method,
      headers,
      signal: abort.signal,
      ...(method === 'POST' ? { body: limitedBody(req, BODY_LIMIT), duplex: 'half' } : {}),
    } as RequestInit);

    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    res.setHeader('cache-control', upstream.headers.get('cache-control') ?? 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    if (!upstream.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>).pipe(res);
  }
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function limitedBody(req: Request, limit: number): ReadableStream<Uint8Array> {
  const tooLarge = () => Object.assign(new Error('Payload too large'), { name: 'BodyTooLarge' });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  let seen = 0;
  return (Readable.toWeb(req) as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}
