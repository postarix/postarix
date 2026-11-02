import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Remote images in email go through this proxy, so the sender never sees the
 * reader's IP address, browser or cookies, and opening a message does not
 * reveal anything until the reader chooses to load images. URLs are signed
 * (so it is not an open proxy) and every fetch is guarded against SSRF.
 */

const LINK_TTL_SECONDS = 24 * 60 * 60;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
/** Raster types only: SVG can carry scripts. */
export const PROXY_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address is public (not private, loopback, link-local, reserved…). */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d): judge the IPv4 address it carries.
  // (A ::ffff:0:0/96 rule would make BlockList block every IPv4 address.)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (family === 6 && /^::ffff:/i.test(address)) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'postarix', 'image-proxy-v1', 32));
}

function sign(key: Buffer, url: string, expires: number): string {
  return createHmac('sha256', key).update(`${expires}\n${url}`).digest('base64url');
}

/** The proxied URL (path + query) for a remote image. */
export function proxiedImageUrl(secret: string, base: string, url: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const params = new URLSearchParams({ u: url, e: String(expires), s: sign(keyFrom(secret), url, expires) });
  return `${base}?${params.toString()}`;
}

export function verifyImageLink(secret: string, url: string, expires: string, signature: string, now = Date.now()): boolean {
  if (!/^\d{1,12}$/.test(expires) || Number(expires) < Math.floor(now / 1000)) return false;
  const expected = Buffer.from(sign(keyFrom(secret), url, Number(expires)));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class ImageProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchedImage {
  type: string;
  body: Buffer;
}

/** Which addresses and ports may be fetched. Tests relax it; production uses the default. */
export interface FetchPolicy {
  isAllowedAddress: (address: string) => boolean;
  anyPort: boolean;
}

const DEFAULT_POLICY: FetchPolicy = { isAllowedAddress: isPublicAddress, anyPort: false };

/** Only resolves to allowed addresses; used as the socket's lookup, so the checked address is the one connected to. */
const safeLookup = (policy: FetchPolicy) =>
  function lookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = (addresses as dns.LookupAddress[]).filter((a) => policy.isAllowedAddress(a.address));
    if (list.length === 0) {
      return callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
  };

/** Fetches a remote image with SSRF protections, size and type limits. */
export async function fetchRemoteImage(rawUrl: string, policy: FetchPolicy = DEFAULT_POLICY, redirects = 0): Promise<FetchedImage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageProxyError(400, 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageProxyError(400, 'Unsupported URL');
  if (url.username || url.password) throw new ImageProxyError(400, 'Unsupported URL');
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== defaultPort && !policy.anyPort) throw new ImageProxyError(400, 'Unsupported port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !policy.isAllowedAddress(host)) throw new ImageProxyError(403, 'Address not allowed');

  const client = url.protocol === 'https:' ? https : http;
  return new Promise<FetchedImage>((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: safeLookup(policy) as unknown as net.LookupFunction,
        headers: { accept: 'image/*', 'user-agent': 'Postarix-ImageProxy/1.0' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new ImageProxyError(502, 'Too many redirects'));
          const next = new URL(res.headers.location, url).href;
          return fetchRemoteImage(next, policy, redirects + 1).then(resolve, reject);
        }
        if (status !== 200) {
          res.resume();
          return reject(new ImageProxyError(502, `Upstream answered ${status}`));
        }
        const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (!PROXY_IMAGE_TYPES.has(type)) {
          res.resume();
          return reject(new ImageProxyError(415, 'Not a supported image'));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.destroy();
          return reject(new ImageProxyError(413, 'Image too large'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new ImageProxyError(413, 'Image too large'));
          } else chunks.push(chunk);
        });
        res.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
        res.on('error', (error) => reject(new ImageProxyError(502, error.message)));
      },
    );
    req.on('timeout', () => req.destroy(new ImageProxyError(504, 'Upstream timed out')));
    req.on('error', (error) => {
      if (error instanceof ImageProxyError) return reject(error);
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === 'EBLOCKED' ? new ImageProxyError(403, 'Address not allowed') : new ImageProxyError(502, 'Could not fetch the image'));
    });
  });
}
