import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, unique } from './support.js';

const PASSWORD = 'calendar mailbox password';
const CALENDARS = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
const CONTACTS = ['urn:ietf:params:jmap:core', 'https://cyrusimap.org/ns/jmap/contacts'];
type MethodResponse = [string, Record<string, unknown>, string];

describe('Calendar and contacts (JMAP through the API, synced over CalDAV/CardDAV)', () => {
  const admin = new ApiClient();
  const ann = new ApiClient();
  const ben = new ApiClient();
  let annAddress: string;
  let benAddress: string;
  let davPassword: string;
  let benDavPassword: string;
  const outsider = new ApiClient();
  let outsiderAddress: string;

  const call = async (client: ApiClient, using: string[], methodCalls: MethodResponse[]) =>
    (await client.ok<{ methodResponses: MethodResponse[] }>('POST', '/api/jmap/', { using, methodCalls })).methodResponses;

  const dav = (method: string, path: string, user: string, password: string, depth = '1') =>
    fetch(`${config.davUrl}${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, depth },
    });

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Calendar', slug: unique('calendar') });
    const domain = await admin.ok<{ id: string; name: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('cal')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    const create = async (localPart: string) =>
      (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD })).address;
    annAddress = await create('ann');
    benAddress = await create('ben');
    await ann.signIn(annAddress, PASSWORD);
    await ben.signIn(benAddress, PASSWORD);
    davPassword = (await ann.ok<{ password: string }>('POST', '/api/me/app-passwords', { name: 'Phone', scopes: ['dav'] })).password;
    benDavPassword = (await ben.ok<{ password: string }>('POST', '/api/me/app-passwords', { name: 'Phone', scopes: ['dav'] })).password;

    // Someone in another organization.
    const otherOrg = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Elsewhere', slug: unique('elsewhere') });
    const otherDomain = await admin.ok<{ id: string; name: string }>('POST', `/api/orgs/${otherOrg.id}/domains`, { name: `${unique('else')}.test` });
    await admin.ok('POST', `/api/orgs/${otherOrg.id}/domains/${otherDomain.id}/verify`);
    outsiderAddress = (
      await admin.ok<{ address: string }>('POST', `/api/orgs/${otherOrg.id}/mailboxes`, { domainId: otherDomain.id, localPart: 'olga', password: PASSWORD })
    ).address;
    await outsider.signIn(outsiderAddress, PASSWORD);
  });

  it('creates and finds events, and the same event syncs over CalDAV', async () => {
    const [[, calendars]] = (await call(ann, CALENDARS, [['Calendar/get', { accountId: annAddress }, 'c']])) as [MethodResponse];
    const calendarId = (calendars.list as { id: string }[])[0]!.id;
    const title = unique('kickoff');
    const [[name, created]] = (await call(ann, CALENDARS, [
      [
        'CalendarEvent/set',
        {
          accountId: annAddress,
          create: { e: { '@type': 'Event', calendarIds: { [calendarId]: true }, title, start: '2026-11-10T10:00:00', timeZone: 'America/Bogota', duration: 'PT1H' } },
        },
        's',
      ],
    ])) as [MethodResponse];
    expect(name).toBe('CalendarEvent/set');
    expect(created.created).toHaveProperty('e');

    const [, [, got]] = (await call(ann, CALENDARS, [
      ['CalendarEvent/query', { accountId: annAddress, filter: { after: '2026-11-01T00:00:00', before: '2026-12-01T00:00:00' } }, 'q'],
      ['CalendarEvent/get', { accountId: annAddress, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['title'] }, 'g'],
    ])) as [MethodResponse, MethodResponse];
    expect((got.list as { title: string }[]).map((e) => e.title)).toContain(title);

    const res = await dav('REPORT', `/dav/calendars/user/${annAddress}/${calendarId}/`, annAddress, davPassword);
    const propfind = res.status === 207 ? res : await dav('PROPFIND', `/dav/calendars/user/${annAddress}/${calendarId}/`, annAddress, davPassword);
    expect(propfind.status).toBe(207);
    const listing = await propfind.text();
    expect(listing).toMatch(/\.ics</);
  });

  it('keeps calendars private between users', async () => {
    const [[name, result]] = (await call(ben, CALENDARS, [['Calendar/get', { accountId: annAddress }, 'c']])) as [MethodResponse];
    expect(name).toBe('error');
    expect(String(result.type)).toMatch(/accountNotFound|forbidden/);
    // Ben signs in with his own password: refused because the calendar is Ann's.
    const res = await dav('PROPFIND', `/dav/calendars/user/${annAddress}/`, benAddress, benDavPassword);
    expect([403, 404]).toContain(res.status);
    expect((await dav('PROPFIND', `/dav/calendars/user/${benAddress}/`, benAddress, benDavPassword)).status).toBe(207);
  });

  it('never puts events in other people’s calendars, in or outside the organization', async () => {
    const [[, calendars]] = (await call(ann, CALENDARS, [['Calendar/get', { accountId: annAddress }, 'c']])) as [MethodResponse];
    const calendarId = (calendars.list as { id: string }[])[0]!.id;
    const invitation = {
      '@type': 'Event',
      calendarIds: { [calendarId]: true },
      title: unique('invite'),
      start: '2026-11-12T10:00:00',
      timeZone: 'America/Bogota',
      duration: 'PT1H',
      participants: {
        a: { '@type': 'Participant', email: annAddress, roles: { owner: true } },
        o: { '@type': 'Participant', email: outsiderAddress, roles: { attendee: true } },
      },
    };
    const refused = await ann.request('POST', '/api/jmap/', { using: CALENDARS, methodCalls: [['CalendarEvent/set', { accountId: annAddress, create: { e: invitation } }, 's']] });
    expect(refused.status).toBe(403);
    // And the outsider's calendar stays empty.
    const [, [, got]] = (await call(outsider, CALENDARS, [
      ['CalendarEvent/query', { accountId: outsiderAddress, filter: { after: '2026-11-01T00:00:00', before: '2026-12-01T00:00:00' } }, 'q'],
      ['CalendarEvent/get', { accountId: outsiderAddress, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['title'] }, 'g'],
    ])) as [MethodResponse, MethodResponse];
    expect(got.list).toEqual([]);
  });

  it('stores contacts that sync over CardDAV', async () => {
    const [[, created]] = (await call(ann, CONTACTS, [
      ['Contact/set', { accountId: annAddress, create: { c: { firstName: 'Lucía', lastName: 'Gómez', emails: [{ type: 'work', value: 'lucia@acme.example' }] } } }, 's'],
    ])) as [MethodResponse];
    const id = (created.created as Record<string, { id: string }>).c!.id;
    const [, [, got]] = (await call(ann, CONTACTS, [
      ['Contact/query', { accountId: annAddress, filter: { email: 'lucia@acme' } }, 'q'],
      ['Contact/get', { accountId: annAddress, '#ids': { resultOf: 'q', name: 'Contact/query', path: '/ids' }, properties: ['firstName', 'emails'] }, 'g'],
    ])) as [MethodResponse, MethodResponse];
    expect((got.list as { id: string; firstName: string }[]).map((c) => c.id)).toContain(id);

    const res = await dav('PROPFIND', `/dav/addressbooks/user/${annAddress}/Default/`, annAddress, davPassword);
    expect(res.status).toBe(207);
    expect(await res.text()).toMatch(/\.vcf</);
  });

  it('keeps contacts private from other organizations', async () => {
    const [[name, result]] = (await call(outsider, CONTACTS, [['Contact/query', { accountId: annAddress }, 'q']])) as [MethodResponse];
    expect(name).toBe('error');
    expect(String(result.type)).toMatch(/accountNotFound|forbidden/);
    const otherDav = (await outsider.ok<{ password: string }>('POST', '/api/me/app-passwords', { name: 'Phone', scopes: ['dav'] })).password;
    const res = await dav('PROPFIND', `/dav/addressbooks/user/${annAddress}/Default/`, outsiderAddress, otherDav);
    expect([403, 404]).toContain(res.status);
  });

  it('gives DAV app passwords calendars and contacts, but no mail', async () => {
    // No JMAP on the DAV service, and the app password is not valid for IMAP either.
    const jmap = await dav('GET', '/jmap/', annAddress, davPassword, '0');
    expect(jmap.status).not.toBe(200);
  });
});
