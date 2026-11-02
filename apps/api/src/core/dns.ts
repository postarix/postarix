import { Resolver } from 'node:dns/promises';

/** The subset of DNS lookups the API needs; replaceable in tests. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export function createDnsResolver(servers: readonly string[]): DnsResolver {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  if (servers.length > 0) resolver.setServers([...servers]);
  return { resolveTxt: (hostname) => resolver.resolveTxt(hostname) };
}
