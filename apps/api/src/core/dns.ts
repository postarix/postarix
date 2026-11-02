import { Resolver } from 'node:dns/promises';

/** The subset of DNS lookups the API needs; replaceable in tests. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveMx(hostname: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCname(hostname: string): Promise<string[]>;
}

export function createDnsResolver(servers: readonly string[]): DnsResolver {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  if (servers.length > 0) resolver.setServers([...servers]);
  return {
    resolveTxt: (hostname) => resolver.resolveTxt(hostname),
    resolveMx: (hostname) => resolver.resolveMx(hostname),
    resolveCname: (hostname) => resolver.resolveCname(hostname),
  };
}

/** Whether a DNS error means "no such record" (as opposed to a failed lookup). */
export function isNoRecordError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}
