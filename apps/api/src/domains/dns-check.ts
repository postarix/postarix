import type { DnsResolver } from '../core/dns.js';
import { isNoRecordError } from '../core/dns.js';
import type { DnsRecordDto } from './domains.dto.js';

export type DnsRecordStatus = 'ok' | 'missing' | 'mismatch' | 'unknown';

export interface DnsRecordCheckDto extends DnsRecordDto {
  status: DnsRecordStatus;
  /** What is published today, when it differs from what is expected. */
  found: string[];
}

type Lookup = { values: string[] } | { failed: true };

const normalizeHost = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');
const compact = (value: string) => value.replace(/\s+/g, '');

/**
 * Compares the records a domain should publish with what DNS answers today.
 * Lookups that fail (timeouts, SERVFAIL) give "unknown", never "missing".
 */
export async function checkDnsRecords(
  dns: DnsResolver,
  expected: DnsRecordDto[],
  mailHostname: string,
): Promise<DnsRecordCheckDto[]> {
  const cache = new Map<string, Promise<Lookup>>();
  const lookup = (kind: 'TXT' | 'MX', name: string) => {
    const key = `${kind} ${name}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async (): Promise<Lookup> => {
        try {
          if (kind === 'MX') return { values: (await dns.resolveMx(name)).map((r) => normalizeHost(r.exchange)) };
          // A TXT record may be split into several strings; they form one value.
          return { values: (await dns.resolveTxt(name)).map((chunks) => chunks.join('')) };
        } catch (error) {
          return isNoRecordError(error) ? { values: [] } : { failed: true };
        }
      })();
      cache.set(key, pending);
    }
    return pending;
  };

  return Promise.all(
    expected.map(async (record): Promise<DnsRecordCheckDto> => {
      const result = await lookup(record.type, record.name);
      if ('failed' in result) return { ...record, status: 'unknown', found: [] };
      const { values } = result;
      const verdict = (status: DnsRecordStatus, found: string[] = []) => ({ ...record, status, found });

      switch (record.purpose) {
        case 'verification':
          return values.includes(record.value) ? verdict('ok') : verdict('missing');
        case 'mx': {
          if (values.length === 0) return verdict('missing');
          return values.includes(normalizeHost(mailHostname)) ? verdict('ok') : verdict('mismatch', values);
        }
        case 'spf': {
          const spf = values.filter((v) => /^v=spf1(\s|$)/i.test(v));
          if (spf.length === 0) return verdict('missing');
          // Several SPF records make SPF fail outright (RFC 7208 §4.5).
          if (spf.length > 1) return verdict('mismatch', spf);
          const terms = spf[0]!.toLowerCase().split(/\s+/);
          const host = normalizeHost(mailHostname);
          const authorizes = terms.some((t) => /^[+]?mx$/.test(t) || t === `a:${host}` || t === `+a:${host}`);
          return authorizes ? verdict('ok') : verdict('mismatch', spf);
        }
        case 'dkim': {
          const key = /p=([^;]+)/.exec(record.value)?.[1];
          if (values.length === 0) return verdict('missing');
          const published = values.some((v) => key !== undefined && compact(v).includes(`p=${compact(key)}`));
          return published ? verdict('ok') : verdict('mismatch', values);
        }
        case 'dmarc': {
          const dmarc = values.filter((v) => /^v=DMARC1(;|\s|$)/i.test(v));
          if (dmarc.length === 0) return verdict('missing');
          return dmarc.length === 1 ? verdict('ok') : verdict('mismatch', dmarc);
        }
      }
    }),
  );
}
