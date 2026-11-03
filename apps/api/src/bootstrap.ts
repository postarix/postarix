import 'reflect-metadata';
import { ConsoleLogger, type INestApplication, Logger, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import { IpAccessService } from './policies/policies.js';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { type Auth, AUTH_BASE_PATH, CLIENT_IP_HEADER } from './auth/auth.js';
import { bodyLimits } from './common/body-limits.middleware.js';
import { originCheck } from './common/origin-check.middleware.js';
import type { Env } from './config/env.js';
import { AUTH, ENV } from './core/tokens.js';
import { JmapProxy } from './jmap/jmap-proxy.js';
import { RspamdUiProxy } from './system/rspamd-ui-proxy.js';
import { httpMetrics } from './metrics/metrics.js';

/**
 * Creates the Nest application with all HTTP-level wiring. Shared by main.ts
 * and the end-to-end tests so both run exactly the same stack.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Better Auth must read the raw request body, so JSON parsing is added after it.
    bodyParser: false,
    ...(process.env.NODE_ENV === 'test'
      ? { logger: false as const }
      : process.env.LOG_FORMAT === 'json'
        ? { logger: new ConsoleLogger({ json: true, colors: false }) }
        : {}),
  });

  const env = app.get<Env>(ENV);
  const auth = app.get<Auth>(AUTH);

  // Only honour X-Forwarded-For from explicitly trusted reverse proxies.
  app.set('trust proxy', env.TRUSTED_PROXIES.length > 0 ? env.TRUSTED_PROXIES : false);
  app.disable('x-powered-by');

  app.use(httpMetrics);
  // Networks blocked under System → IP access reach nothing but the internal routes.
  app.use(app.get(IpAccessService).middleware);
  // Rspamd's web interface sets its own security headers (it needs scripts and styles of its own).
  app.use('/api/rspamd-ui', (req: Request, res: Response, next: NextFunction) => {
    // Better Auth needs the client IP for its session checks below.
    req.headers[CLIENT_IP_HEADER] = req.ip ?? '';
    app.get(RspamdUiProxy).handle(req, res, next);
  });
  app.use(helmet());
  if (env.TRUSTED_ORIGINS.length > 0) {
    app.enableCors({ origin: env.TRUSTED_ORIGINS, credentials: true });
  }

  // Expose the proxy-aware client IP to Better Auth (rate limiting, session metadata).
  // Any client-supplied value is overwritten so it cannot be spoofed.
  // Behind a proxy with TRUSTED_PROXIES unset, every client shares the
  // proxy's address (and its rate limits): say so once.
  let warnedAboutProxy = env.TRUSTED_PROXIES.length > 0;
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!warnedAboutProxy && req.headers['x-forwarded-for'] !== undefined && !req.path.startsWith('/api/internal')) {
      warnedAboutProxy = true;
      new Logger('Bootstrap').warn(
        'Requests carry X-Forwarded-For but TRUSTED_PROXIES is empty: client addresses (rate limits, audit log) are the proxy\'s. Set TRUSTED_PROXIES to the reverse proxy\'s address or network.',
      );
    }
    req.headers[CLIENT_IP_HEADER] = req.ip ?? '';
    next();
  });

  // JMAP for the webmail streams its bodies (uploads, downloads, events), so it
  // comes before the body parsers and applies its own limits and origin check.
  app.use('/api/jmap', app.get(JmapProxy).handle);

  // Parse and size-limit bodies before anything else, Better Auth included.
  app.use(...bodyLimits());

  // Mounted on the bare prefix so Express keeps the query string intact
  // (a `/{*path}` pattern makes better-call drop it). Better Auth performs
  // its own origin/CSRF validation on these routes.
  app.use(AUTH_BASE_PATH, toNodeHandler(auth));

  app.use(originCheck([env.AUTH_URL, ...env.TRUSTED_ORIGINS]));

  // Mail software fetches these at fixed paths, outside /api.
  app.setGlobalPrefix('api', {
    exclude: [
      '.well-known/autoconfig/mail/config-v1.1.xml',
      'mail/config-v1.1.xml',
      { path: 'autodiscover/autodiscover.xml', method: RequestMethod.POST },
      '.well-known/mta-sts.txt',
    ],
  });
  app.enableShutdownHooks();
  return app;
}
