import { createServer, type Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics. They are served on their own port (METRICS_PORT), never
 * on the API's public one, so the reverse proxy does not expose them.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'postarix_api_' });

export const httpRequests = new Counter({
  name: 'postarix_http_requests_total',
  help: 'HTTP requests handled by the API, by route and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'postarix_http_request_duration_seconds',
  help: 'Time to answer HTTP requests, by route.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const mailLogins = new Counter({
  name: 'postarix_mail_logins_total',
  help: 'Logins of mail apps (IMAP, SMTP, POP3, ManageSieve, DAV) checked by the API, by service and result.',
  labelNames: ['service', 'result'] as const,
  registers: [registry],
});

export const webSignIns = new Counter({
  name: 'postarix_web_sign_ins_total',
  help: 'Password sign-ins to the admin panel and webmail, by result (success, failure, blocked).',
  labelNames: ['result'] as const,
  registers: [registry],
});

const KNOWN_SERVICES = new Set(['imap', 'pop', 'pop3', 'sieve', 'smtp', 'submission', 'http', 'caldav', 'carddav']);

/** The SASL service name as a label, without letting callers create new series at will. */
export function serviceLabel(service: string): string {
  const name = service.trim().toLowerCase();
  return KNOWN_SERVICES.has(name) ? name : 'other';
}

/**
 * Route label for a request: the matched Nest/Express pattern
 * (/api/orgs/:orgId/mailboxes), never the raw path, so ids do not explode
 * the number of series.
 */
function routeLabel(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  if (route && typeof route.path === 'string') return `${req.baseUrl}${route.path}`;
  const path = req.originalUrl.split('?')[0] ?? '';
  if (path.startsWith('/api/auth/')) return '/api/auth/*';
  if (path.startsWith('/api/jmap')) return '/api/jmap/*';
  return 'unmatched';
}

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.once('finish', () => {
    const route = routeLabel(req);
    end({ method: req.method, route });
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

export interface MetricsOptions {
  port: number | undefined;
  /** Rspamd's controller and its read-only password: /metrics/rspamd relays its metrics. */
  rspamdUrl?: string | undefined;
  rspamdPassword?: string | undefined;
}

/**
 * Rspamd's own metrics need its controller password, which Prometheus would
 * otherwise have to hold: the API relays them instead.
 */
async function rspamdMetrics(options: MetricsOptions): Promise<{ status: number; body: string; type: string }> {
  if (!options.rspamdUrl || !options.rspamdPassword) return { status: 404, body: '', type: 'text/plain' };
  try {
    const response = await fetch(new URL('/metrics', options.rspamdUrl), {
      headers: { password: options.rspamdPassword },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.ok ? 200 : 502, body: response.ok ? await response.text() : '', type: response.headers.get('content-type') ?? 'text/plain' };
  } catch {
    return { status: 502, body: '', type: 'text/plain' };
  }
}

/** Starts the metrics listener; returns undefined when METRICS_PORT is unset. */
export async function startMetricsServer(options: MetricsOptions): Promise<Server | undefined> {
  if (!options.port) return undefined;
  const port = options.port;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/metrics') {
      registry.metrics().then(
        (body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body),
        () => res.writeHead(500).end(),
      );
      return;
    }
    if (req.method === 'GET' && path === '/metrics/rspamd') {
      void rspamdMetrics(options).then(({ status, body, type }) => res.writeHead(status, { 'content-type': type }).end(body));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return server;
}
