import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../config/env.js';
import { ENV } from '../core/tokens.js';
import { isPublicAddress } from '../mail/image-proxy.js';
import { IssuerPolicy } from '../sso/issuer-policy.js';

/** How long fetched keys are trusted before asking again. */
const CACHE_MS = 10 * 60_000;
/** A key id not in the cached set makes us ask again, at most this often. */
const REFRESH_MIN_MS = 60_000;
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

/** Whether a JWKS URL may be stored: https, public host (checked again when fetched). */
export function jwksUrlAllowed(url: string, policy: IssuerPolicy): boolean {
  try {
    if (new URL(url).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return policy.allowsUrl(url);
}

/** Fetches a JWKS over https from a public address only (checked on the connected address), no redirects, 64 KB at most. */
export function fetchJwks(url: string, trusted: (origin: string) => boolean): Promise<JSONWebKeySet> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('JWKS URLs must use https'));
  const allowedAddress = (address: string) => trusted(parsed.origin) || isPublicAddress(address);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowedAddress(host)) return Promise.reject(new Error('JWKS address not allowed'));
  return new Promise((resolve, reject) => {
    const req = https.get(
      parsed,
      {
        headers: { accept: 'application/json, application/jwk-set+json', 'user-agent': 'Postarix-JWKS/1.0' },
        timeout: TIMEOUT_MS,
        lookup: ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
          dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error, '');
            const list = (addresses as dns.LookupAddress[]).filter((a) => allowedAddress(a.address));
            if (list.length === 0) return callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: 'EBLOCKED' }), '');
            if (options.all) return callback(null, list);
            callback(null, list[0]!.address, list[0]!.family);
          });
        }) as unknown as net.LookupFunction,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`The JWKS URL answered ${res.statusCode ?? 0}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new Error('The JWKS is too large'));
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const set = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JSONWebKeySet;
            if (!Array.isArray(set?.keys)) throw new Error('not a JWKS');
            resolve(set);
          } catch {
            reject(new Error('The JWKS URL did not return a key set'));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The JWKS URL timed out')));
    req.on('error', reject);
  });
}

/**
 * Connected applications' public keys fetched from their JWKS URL, cached
 * for 10 minutes; an unknown key id fetches again (at most once a minute).
 */
@Injectable()
export class JwksCache {
  private readonly entries = new Map<string, { set: JWTVerifyGetKey; fetchedAt: number }>();
  private readonly policy: IssuerPolicy;
  /** Replaced in tests. */
  fetcher: (url: string) => Promise<JSONWebKeySet>;

  constructor(@Inject(ENV) env: Env) {
    this.policy = new IssuerPolicy(env.SSO_TRUSTED_ISSUERS);
    const trusted = new Set(env.SSO_TRUSTED_ISSUERS.map((o) => o.replace(/\/+$/, '')));
    this.fetcher = (url) => fetchJwks(url, (origin) => trusted.has(origin));
  }

  allowsUrl(url: string): boolean {
    return jwksUrlAllowed(url, this.policy);
  }

  private async load(url: string, force: boolean): Promise<JWTVerifyGetKey> {
    const cached = this.entries.get(url);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age < CACHE_MS && (!force || age < REFRESH_MIN_MS)) return cached.set;
    const set = createLocalJWKSet(await this.fetcher(url));
    this.entries.set(url, { set, fetchedAt: Date.now() });
    return set;
  }

  /** A key resolver for jose: the cached set, fetched again when it does not know the key. */
  keySet(url: string): JWTVerifyGetKey {
    return async (header, token) => {
      try {
        return await (await this.load(url, false))(header, token);
      } catch {
        return (await this.load(url, true))(header, token);
      }
    };
  }
}
