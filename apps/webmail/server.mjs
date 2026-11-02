// Serves the built webmail (dist/) with strict security headers. Optionally
// forwards /api to the Postarix API (API_PROXY_URL) for setups without a
// reverse proxy in front; /api/internal is never forwarded.
// No dependencies: Node.js only.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? '0.0.0.0';
const apiProxy = process.env.API_PROXY_URL ? new URL(process.env.API_PROXY_URL) : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
}

/** True for /api/internal in any spelling (case, repeated slashes, percent-encoding, dot segments). */
export function isInternalPath(rawPath) {
  let decoded = rawPath;
  try {
    for (let i = 0; i < 3 && decoded.includes('%'); i++) decoded = decodeURIComponent(decoded);
  } catch {
    return true;
  }
  const normalized = new URL(decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), 'http://x').pathname.toLowerCase();
  return /^\/api\/internal(\/|$)/.test(normalized);
}

/**
 * Where a request is forwarded: always the API's origin. (`new URL(path, base)`
 * would treat "//host/x" as another host.)
 */
export function forwardUrl(path, target) {
  return new URL(`${target.origin}/${path.replace(/^\/+/, '')}`);
}

async function proxy(req, res, target) {
  if (isInternalPath(req.url.split('?')[0])) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"statusCode":404,"message":"Not found"}');
    return;
  }
  const url = forwardUrl(req.url, target);
  const headers = { ...req.headers, host: target.host };
  // Do not pass on client-supplied forwarding headers.
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']) delete headers[name];
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req),
      duplex: 'half',
      redirect: 'manual',
      signal: abort.signal,
    });
    const out = {};
    upstream.headers.forEach((value, name) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(name)) out[name] = value;
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(upstream.status, out);
    if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) res.flushHeaders();
    if (upstream.body) Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"statusCode":502,"message":"Bad gateway"}');
    else res.destroy();
  }
}

async function serveFile(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) {
    res.writeHead(400).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  const isAsset = pathname.startsWith('/assets/');
  if (!info?.isFile()) {
    if (isAsset || path.extname(pathname)) {
      securityHeaders(res);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    // Client-side routes all serve the app.
    file = path.join(root, 'index.html');
    info = await stat(file);
  }
  securityHeaders(res);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (/^\/+api(\/|$)/i.test(pathname)) {
    if (apiProxy) return void proxy(req, res, apiProxy);
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"statusCode":404,"message":"Not found"}');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  serveFile(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => console.error(`Postarix webmail on ${host}:${port}${apiProxy ? `, /api → ${apiProxy.origin}` : ''}`));
}
