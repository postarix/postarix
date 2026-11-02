import { describe, expect, it } from 'vitest';
import { checkApiRequest } from './jmap-proxy.js';

const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const CAL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
const body = (using: string[], methodCalls: unknown[]) => Buffer.from(JSON.stringify({ using, methodCalls }));
const check = (using: string[], methodCalls: unknown[]) => () => checkApiRequest(body(using, methodCalls));

describe('checkApiRequest', () => {
  it('lets through what the webmail uses', () => {
    for (const name of ['Mailbox/get', 'Email/query', 'Email/get', 'Email/set', 'Email/import', 'Thread/get', 'SearchSnippet/get', 'Blob/copy']) {
      expect(check(MAIL, [[name, {}, 'c']]), name).not.toThrow();
    }
    for (const name of ['Calendar/get', 'CalendarEvent/query', 'CalendarEvent/get', 'CalendarEvent/set']) {
      expect(check(CAL, [[name, {}, 'c']]), name).not.toThrow();
    }
    expect(check(['urn:ietf:params:jmap:core', 'https://cyrusimap.org/ns/jmap/contacts'], [['Contact/set', {}, 'c']])).not.toThrow();
  });

  it('refuses sending, Sieve, backups, administration and unknown methods', () => {
    for (const name of ['EmailSubmission/set', 'Identity/set', 'SieveScript/set', 'VacationResponse/set', 'Backup/restoreMail', 'Admin/migrateCalendars', 'Principal/get', 'CalendarEvent/participantReply', 'Calendar/set']) {
      expect(check(MAIL, [[name, {}, 'c']]), name).toThrow(/not available/);
    }
    for (const capability of ['urn:ietf:params:jmap:submission', 'https://cyrusimap.org/ns/jmap/sieve', 'urn:ietf:params:jmap:principals']) {
      expect(check([...MAIL, capability], [])).toThrow(/Capability not available/);
    }
  });

  it('refuses events that invite people or repeat more often than daily', () => {
    const set = (args: unknown) => check(CAL, [['CalendarEvent/set', args, 'c']]);
    expect(set({ create: { e: { title: 'x', participants: { p: { email: 'victim@other.example' } } } } })).toThrow(/Inviting/);
    expect(set({ update: { e1: { 'participants/p1/email': 'victim@other.example' } } })).toThrow(/Inviting/);
    expect(set({ update: { e1: { replyTo: { imip: 'mailto:a@b.example' } } } })).toThrow(/Inviting/);
    expect(set({ create: { e: { sendSchedulingMessages: true } } })).toThrow(/Inviting/);
    expect(set({ create: { e: { recurrenceRules: [{ frequency: 'secondly' }] } } })).toThrow(/at most daily/);
    expect(set({ update: { e1: { 'recurrenceRules/0/frequency': 'minutely' } } })).toThrow(/at most daily/);
    expect(set({ create: { e: { title: 'Stand-up', recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }] } } })).not.toThrow();
    expect(set({ update: { e1: { title: 'Renamed' } }, destroy: ['e2'] })).not.toThrow();
  });

  it('refuses what is not a JMAP request and re-serializes what it checked', () => {
    expect(() => checkApiRequest(Buffer.from('{oops'))).toThrow(/valid JSON/);
    expect(() => checkApiRequest(Buffer.from('{"using":"x"}'))).toThrow(/Not a JMAP request/);
    const out = checkApiRequest(Buffer.from('{ "using": ["urn:ietf:params:jmap:core"], "methodCalls": [] , "extra": 1 }'));
    expect(JSON.parse(Buffer.from(out).toString())).toEqual({ using: ['urn:ietf:params:jmap:core'], methodCalls: [], extra: 1 });
  });
});
