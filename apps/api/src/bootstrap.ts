import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { type Auth, AUTH_BASE_PATH, CLIENT_IP_HEADER } from './auth/auth.js';
import { bodyLimits } from './common/body-limits.middleware.js';
import { originCheck } from './common/origin-check.middleware.js';
import type { Env } from './config/env.js';
import { AUTH, ENV } from './core/tokens.js';

/**
 * Creates the Nest application with all HTTP-level wiring. Shared by main.ts
 * and the end-to-end tests so both run exactly the same stack.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Better Auth must read the raw request body, so JSON parsing is added after it.
    bodyParser: false,
    ...(process.env.NODE_ENV === 'test' ? { logger: false as const } : {}),
  });

  const env = app.get<Env>(ENV);
  const auth = app.get<Auth>(AUTH);

  // Only honour X-Forwarded-For from explicitly trusted reverse proxies.
  app.set('trust proxy', env.TRUSTED_PROXIES.length > 0 ? env.TRUSTED_PROXIES : false);
  app.disable('x-powered-by');

  app.use(helmet());
  if (env.TRUSTED_ORIGINS.length > 0) {
    app.enableCors({ origin: env.TRUSTED_ORIGINS, credentials: true });
  }

  // Expose the proxy-aware client IP to Better Auth (rate limiting, session metadata).
  // Any client-supplied value is overwritten so it cannot be spoofed.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.headers[CLIENT_IP_HEADER] = req.ip ?? '';
    next();
  });

  // Parse and size-limit bodies before anything else, Better Auth included.
  app.use(...bodyLimits());

  // Mounted on the bare prefix so Express keeps the query string intact
  // (a `/{*path}` pattern makes better-call drop it). Better Auth performs
  // its own origin/CSRF validation on these routes.
  app.use(AUTH_BASE_PATH, toNodeHandler(auth));

  app.use(originCheck([env.AUTH_URL, ...env.TRUSTED_ORIGINS]));

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
