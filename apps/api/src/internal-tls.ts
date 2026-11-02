import { readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Env } from './config/env.js';

/** True when the request came in over the internal HTTPS listener. */
export function viaInternalTls(request: { socket?: { encrypted?: boolean; localPort?: number } }, env: Env): boolean {
  return Boolean(request.socket?.encrypted) && request.socket?.localPort === env.INTERNAL_TLS_PORT;
}

export function internalTlsEnabled(env: Env): boolean {
  return Boolean(env.INTERNAL_TLS_CERT_FILE && env.INTERNAL_TLS_KEY_FILE);
}

/**
 * Starts the internal HTTPS listener (same application) for the mail-login
 * bridge, with the mail server's certificate. A renewed certificate is
 * loaded within a minute.
 */
export async function startInternalTls(app: INestApplication, env: Env): Promise<https.Server | null> {
  if (!internalTlsEnabled(env)) return null;
  const logger = new Logger('InternalTls');
  const certFile = env.INTERNAL_TLS_CERT_FILE!;
  const keyFile = env.INTERNAL_TLS_KEY_FILE!;
  const load = () => ({ cert: readFileSync(certFile), key: readFileSync(keyFile) });
  const stamp = () => `${statSync(certFile).mtimeMs}:${statSync(keyFile).mtimeMs}`;
  const server = https.createServer({ ...load(), minVersion: 'TLSv1.2' }, app.getHttpAdapter().getInstance());
  let last = stamp();
  const timer = setInterval(() => {
    try {
      const now = stamp();
      if (now !== last) {
        server.setSecureContext({ ...load(), minVersion: 'TLSv1.2' });
        last = now;
        logger.log('Certificate renewed; reloaded');
      }
    } catch (error) {
      logger.warn(`Cannot reload the certificate: ${(error as Error).message}`);
    }
  }, 60_000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  await new Promise<void>((resolve) => server.listen(env.INTERNAL_TLS_PORT, resolve));
  logger.log(`Internal HTTPS listener on port ${env.INTERNAL_TLS_PORT}`);
  return server;
}
