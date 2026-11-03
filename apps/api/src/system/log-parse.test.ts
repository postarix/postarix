import { describe, expect, it } from 'vitest';
import { parseLogLine } from './log-parse.js';

const now = new Date('2026-11-03T15:00:00Z');

describe('parsing service log lines', () => {
  it('reads syslog lines (Postfix, Cyrus) with their process and a level from the message', () => {
    expect(parseLogLine('Nov 03 09:10:57 mail postfix/smtpd[14960]: connect from localhost[127.0.0.1]', now)).toEqual({
      time: '2026-11-03T09:10:57.000Z',
      level: 'info',
      source: 'postfix/smtpd',
      message: 'connect from localhost[127.0.0.1]',
    });
    expect(parseLogLine('Nov  3 09:10:57 mail postfix/smtpd[1]: warning: hostname x does not resolve', now).level).toBe('warning');
    expect(parseLogLine('Nov  3 09:10:57 mail postfix/cleanup[1]: 4E51: milter-reject: END-OF-MESSAGE from x: 5.7.1 Spam message rejected', now).level).toBe(
      'warning',
    );
    expect(parseLogLine('Nov  3 09:10:57 mail postfix/master[1]: fatal: bind 0.0.0.0 port 25: Address in use', now).level).toBe('error');
    expect(parseLogLine('Nov 03 09:11:00 mail imaps[200]: login: x [1.2.3.4] ann@example.com plaintext User logged in', now).source).toBe('imaps');
    // December lines read in early January belong to the year before.
    expect(parseLogLine('Dec 31 23:59:00 mail postfix/qmgr[1]: x', new Date('2027-01-01T00:10:00Z')).time).toBe('2026-12-31T23:59:00.000Z');
  });

  it('reads Rspamd, Unbound, the API, ClamAV, CrowdSec and lego lines', () => {
    expect(parseLogLine('2026-11-03 12:25:03 #41(rspamd_proxy) <33c412>; proxy; rspamd_task_write_log: id: <a@b>', now)).toEqual({
      time: '2026-11-03T12:25:03.000Z',
      level: 'info',
      source: 'rspamd_proxy/proxy',
      message: 'rspamd_task_write_log: id: <a@b>',
    });
    expect(parseLogLine('[1793708775] unbound[1:0] error: could not open port 53', now)).toMatchObject({ level: 'error', source: 'unbound' });
    expect(parseLogLine('[Nest] 1  - 11/03/2026, 1:16:51 PM   WARN [MailImportService] Mail import x failed: y', now)).toMatchObject({
      level: 'warning',
      source: 'MailImportService',
      message: 'Mail import x failed: y',
    });
    expect(parseLogLine('{"level":"error","timestamp":1793708775000,"context":"Quarantine","message":"Could not file"}', now)).toEqual({
      time: '2026-11-03T12:26:15.000Z',
      level: 'error',
      source: 'Quarantine',
      message: 'Could not file',
    });
    expect(parseLogLine('Mon Nov  3 12:00:00 2026 -> ERROR: Can\'t open file', now)).toMatchObject({ level: 'error', time: '2026-11-03T12:00:00.000Z' });
    expect(parseLogLine('time="2026-11-03T12:00:00Z" level=warning msg="ban on ip 1.2.3.4" type=crowdsec', now)).toEqual({
      time: '2026-11-03T12:00:00.000Z',
      level: 'warning',
      source: 'crowdsec',
      message: 'ban on ip 1.2.3.4',
    });
    expect(parseLogLine('2026/11/03 12:00:00 [INFO] [mail.example.com] acme: Obtaining bundled SAN certificate', now)).toMatchObject({
      time: '2026-11-03T12:00:00.000Z',
      level: 'info',
    });
  });

  it('keeps anything else whole', () => {
    expect(parseLogLine('something odd happened', now)).toEqual({ time: null, level: 'info', source: null, message: 'something odd happened' });
    expect(parseLogLine('an error occurred', now).level).toBe('error');
  });
});
