import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { isPublicAddress } from '../mail/image-proxy.js';

/**
 * Which identity-provider URLs the server may contact. Organizations type in
 * the issuer URL, so without this they could make the server reach internal
 * services. Origins in TRUSTED_ORIGINS are the operator's escape hatch for an
 * identity provider on a private network.
 */
export class IssuerPolicy {
  private readonly trusted: Set<string>;

  constructor(trustedOrigins: readonly string[]) {
    this.trusted = new Set(trustedOrigins);
  }

  /** Synchronous check of the URL itself (no DNS): fine for URLs the server does not fetch right away. */
  allowsUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (this.trusted.has(parsed.origin)) return true;
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(host)) return isPublicAddress(host);
    if (!host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) return false;
    return true;
  }

  /** Full check before fetching: the URL, and every address its host resolves to. */
  async allowsFetch(url: string): Promise<boolean> {
    if (!this.allowsUrl(url)) return false;
    const parsed = new URL(url);
    if (this.trusted.has(parsed.origin)) return true;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return true;
    try {
      const addresses = await lookup(host, { all: true, verbatim: true });
      return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
    } catch {
      return false;
    }
  }
}
