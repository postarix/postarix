import { describe, expect, it } from 'vitest';
import type { DnsResolver } from '../core/dns.js';
import { checkDnsRecords } from './dns-check.js';
import type { DnsRecordDto } from './domains.dto.js';

const HOST = 'mail.example.net';
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAabc';

const expected: DnsRecordDto[] = [
  { purpose: 'verification', type: 'TXT', name: 'example.com', value: 'postarix-verification=tok' },
  { purpose: 'mx', type: 'MX', name: 'example.com', value: `10 ${HOST}.` },
  { purpose: 'spf', type: 'TXT', name: 'example.com', value: 'v=spf1 mx -all' },
  { purpose: 'dkim', type: 'TXT', name: 'px1._domainkey.example.com', value: `v=DKIM1; k=rsa; p=${KEY}` },
  { purpose: 'dmarc', type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=quarantine' },
];

const noData = () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' }));

function resolver(txt: Record<string, string[][]>, mx: Record<string, string[]>, cname: Record<string, string[]> = {}): DnsResolver {
  return {
    resolveTxt: (name) => (txt[name] ? Promise.resolve(txt[name]) : noData()),
    resolveMx: (name) => (mx[name] ? Promise.resolve(mx[name].map((exchange) => ({ exchange, priority: 10 }))) : noData()),
    resolveCname: (name) => (cname[name] ? Promise.resolve(cname[name]) : noData()),
  };
}

const statuses = async (dns: DnsResolver) =>
  Object.fromEntries((await checkDnsRecords(dns, expected, HOST)).map((r) => [r.purpose, r.status]));

describe('checkDnsRecords', () => {
  it('reports every record as missing on an empty zone', async () => {
    expect(await statuses(resolver({}, {}))).toEqual({
      verification: 'missing',
      mx: 'missing',
      spf: 'missing',
      dkim: 'missing',
      dmarc: 'missing',
    });
  });

  it('accepts a correctly published zone, including split TXT strings and other SPF mechanisms', async () => {
    const dns = resolver(
      {
        'example.com': [['postarix-verification=tok'], ['v=spf1 include:_spf.other.example mx ~all'], ['google-site-verification=x']],
        'px1._domainkey.example.com': [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B', 'AQEFAAOCAQ8AMIIBCgKCAQEAabc']],
        '_dmarc.example.com': [['v=DMARC1; p=reject; rua=mailto:d@example.com']],
      },
      { 'example.com': ['MAIL.example.net.'] },
    );
    expect(await statuses(dns)).toEqual({ verification: 'ok', mx: 'ok', spf: 'ok', dkim: 'ok', dmarc: 'ok' });
  });

  it('flags records that point elsewhere and shows what is published', async () => {
    const dns = resolver(
      {
        'example.com': [['v=spf1 include:_spf.google.com -all']],
        'px1._domainkey.example.com': [['v=DKIM1; k=rsa; p=SOMETHINGELSE']],
        '_dmarc.example.com': [['v=DMARC1; p=none'], ['v=DMARC1; p=reject']],
      },
      { 'example.com': ['aspmx.l.google.com'] },
    );
    const results = await checkDnsRecords(dns, expected, HOST);
    const byPurpose = Object.fromEntries(results.map((r) => [r.purpose, r]));
    expect(byPurpose.mx).toMatchObject({ status: 'mismatch', found: ['aspmx.l.google.com'] });
    expect(byPurpose.spf).toMatchObject({ status: 'mismatch', found: ['v=spf1 include:_spf.google.com -all'] });
    expect(byPurpose.dkim?.status).toBe('mismatch');
    expect(byPurpose.dmarc?.status).toBe('mismatch');
  });

  it('treats two SPF records as broken', async () => {
    const dns = resolver({ 'example.com': [['v=spf1 mx -all'], ['v=spf1 a -all']] }, {});
    expect((await statuses(dns)).spf).toBe('mismatch');
  });

  it('says "unknown", not "missing", when a lookup fails', async () => {
    const failing: DnsResolver = {
      resolveTxt: () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })),
      resolveMx: () => Promise.reject(Object.assign(new Error('servfail'), { code: 'ESERVFAIL' })),
      resolveCname: () => Promise.reject(Object.assign(new Error('servfail'), { code: 'ESERVFAIL' })),
    };
    expect(new Set(Object.values(await statuses(failing)))).toEqual(new Set(['unknown']));
  });

  it('checks the autoconfig and MTA-STS records', async () => {
    const records: DnsRecordDto[] = [
      { purpose: 'autoconfig', type: 'CNAME', name: 'autoconfig.example.com', value: `${HOST}.` },
      { purpose: 'mta-sts', type: 'CNAME', name: 'mta-sts.example.com', value: `${HOST}.` },
      { purpose: 'mta-sts-id', type: 'TXT', name: '_mta-sts.example.com', value: 'v=STSv1; id=abc' },
    ];
    const dns = resolver({ '_mta-sts.example.com': [['v=STSv1; id=old']] }, {}, { 'autoconfig.example.com': [`${HOST}.`], 'mta-sts.example.com': ['other.host.'] });
    const result = Object.fromEntries((await checkDnsRecords(dns, records, HOST)).map((r) => [r.purpose, r.status]));
    expect(result).toEqual({ autoconfig: 'ok', 'mta-sts': 'mismatch', 'mta-sts-id': 'mismatch' });
  });
});
