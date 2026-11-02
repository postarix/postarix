import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { isPublicAddress } from '../mail/image-proxy.js';

/** Where a person's old mail is. */
export interface ImapSource {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  password: string;
}

/** Something the person can fix (address, password, the server's settings): shown to them as is. */
export class SourceError extends Error {}

/** Standard IMAP ports only: the import must not become a way to probe other services. */
const PORTS: Record<ImapSource['security'], number> = { tls: 993, starttls: 143 };
const TIMEOUT_MS = 30_000;

/**
 * The address to connect to for a source server: a public one only (never
 * this server's own network), resolved once so the name cannot point
 * somewhere else between the check and the connection. Hosts listed in
 * MAIL_IMPORT_ALLOWED_HOSTS (an old server on the local network) are exempt.
 */
export async function sourceAddress(source: Pick<ImapSource, 'host' | 'port' | 'security'>, allowedHosts: string[]): Promise<string> {
  const host = source.host.toLowerCase();
  const allowed = allowedHosts.includes(host);
  if (!allowed && source.port !== PORTS[source.security]) {
    throw new SourceError(`Use port ${PORTS[source.security]} for ${source.security === 'tls' ? 'TLS' : 'STARTTLS'}`);
  }
  let address: string;
  if (net.isIP(host)) {
    address = host;
  } else {
    try {
      address = (await dns.lookup(host, { verbatim: true })).address;
    } catch {
      throw new SourceError(`${source.host} cannot be found`);
    }
  }
  if (!allowed && !isPublicAddress(address)) throw new SourceError(`${source.host} is not a public mail server`);
  return address;
}

/**
 * Signs in to the source server; the caller logs out. `extraCa` adds trusted
 * certificates (an old server with a private CA), on top of the public ones.
 */
export async function connectSource(source: ImapSource, allowedHosts: string[], extraCa?: string): Promise<ImapFlow> {
  const address = await sourceAddress(source, allowedHosts);
  const options: ImapFlowOptions & { doSTARTTLS?: boolean } = {
    host: address,
    port: source.port,
    secure: source.security === 'tls',
    // STARTTLS is required, never skipped when the server does not offer it.
    ...(source.security === 'starttls' ? { doSTARTTLS: true } : {}),
    // The certificate must name the host the person typed, not the address.
    servername: net.isIP(source.host) ? undefined : source.host,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(extraCa ? { ca: [...tls.rootCertificates, extraCa] } : {}) },
    auth: { user: source.username, pass: source.password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: 5 * 60_000,
    disableAutoIdle: true,
  };
  const client = new ImapFlow(options);
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    const authFailed = (error as { authenticationFailed?: boolean }).authenticationFailed;
    const code = (error as { code?: string }).code ?? '';
    if (authFailed) {
      throw new SourceError('The server refused the user name or password (Gmail and others need an app password)');
    }
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) throw new SourceError(`${source.host} has no valid certificate`);
    throw new SourceError(`Could not connect to ${source.host}:${source.port}`);
  }
  return client;
}
