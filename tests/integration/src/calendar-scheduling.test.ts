import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, unique } from './support.js';

const PASSWORD = 'scheduling mailbox password';
const CALENDARS = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
const MAIL = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const CONTACTS = ['urn:ietf:params:jmap:core', 'https://cyrusimap.org/ns/jmap/contacts'];
type MethodResponse = [string, Record<string, unknown>, string];

interface Invitation {
  method: string;
  title: string;
  actionable: boolean;
  applied: boolean;
  myStatus: string | null;
  attendees: { email: string; status: string }[];
}

describe('Invitations, free/busy and sharing (real mail between colleagues)', () => {
  const admin = new ApiClient();
  const ann = new ApiClient();
  const ben = new ApiClient();
  const outsider = new ApiClient();
  let annAddress: string;
  let benAddress: string;
  let outsiderAddress: string;

  const call = async (client: ApiClient, using: string[], methodCalls: MethodResponse[]) =>
    (await client.ok<{ methodResponses: MethodResponse[] }>('POST', '/api/jmap/', { using, methodCalls })).methodResponses;

  /** The id of the message with this subject in the person's mail, once it arrives. */
  async function waitForEmail(client: ApiClient, account: string, subject: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      const [[, result]] = (await call(client, MAIL, [['Email/query', { accountId: account, filter: { subject } }, 'q']])) as [MethodResponse];
      const ids = result.ids as string[];
      if (ids.length) return ids[0]!;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`No message "${subject}" for ${account}`);
  }

  async function eventsWithUid(client: ApiClient, account: string, title: string) {
    const [, [, got]] = (await call(client, CALENDARS, [
      ['CalendarEvent/query', { accountId: account, filter: { after: '2026-12-01T00:00:00', before: '2026-12-31T00:00:00' } }, 'q'],
      [
        'CalendarEvent/get',
        { accountId: account, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['title', 'participants', 'uid'] },
        'g',
      ],
    ])) as [MethodResponse, MethodResponse];
    return (got.list as { id: string; title: string; participants?: Record<string, { email: string; participationStatus: string }> }[]).filter(
      (e) => e.title === title,
    );
  }

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Scheduling', slug: unique('scheduling') });
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('sched')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    const create = async (localPart: string) =>
      (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD })).address;
    annAddress = await create('ann');
    benAddress = await create('ben');
    await ann.signIn(annAddress, PASSWORD);
    await ben.signIn(benAddress, PASSWORD);

    const otherOrg = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Elsewhere', slug: unique('sched-else') });
    const otherDomain = await admin.ok<{ id: string }>('POST', `/api/orgs/${otherOrg.id}/domains`, { name: `${unique('sched-else')}.test` });
    await admin.ok('POST', `/api/orgs/${otherOrg.id}/domains/${otherDomain.id}/verify`);
    outsiderAddress = (
      await admin.ok<{ address: string }>('POST', `/api/orgs/${otherOrg.id}/mailboxes`, { domainId: otherDomain.id, localPart: 'olga', password: PASSWORD })
    ).address;
    await outsider.signIn(outsiderAddress, PASSWORD);
  });

  it('keeps everyone’s free/busy private over CalDAV', async () => {
    const otherDav = (await outsider.ok<{ password: string }>('POST', '/api/me/app-passwords', { name: 'Phone', scopes: ['dav'] })).password;
    const res = await fetch(`${config.davUrl}/dav/calendars/user/${outsiderAddress}/${annAddress}.Default/`, {
      method: 'REPORT',
      headers: {
        authorization: `Basic ${Buffer.from(`${outsiderAddress}:${otherDav}`).toString('base64')}`,
        depth: '1',
        'content-type': 'application/xml',
      },
      body: '<?xml version="1.0"?><C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:time-range start="20261201T000000Z" end="20261231T000000Z"/></C:free-busy-query>',
    });
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('VFREEBUSY');
  });

  it('invites a colleague, who accepts, and the organizer sees the answer', async () => {
    const title = unique('planning');
    const [[, created]] = (await call(ann, CALENDARS, [
      [
        'CalendarEvent/set',
        {
          accountId: annAddress,
          create: { e: { '@type': 'Event', calendarIds: { Default: true }, title, start: '2026-12-08T10:00:00', timeZone: 'Europe/Madrid', duration: 'PT1H' } },
        },
        's',
      ],
    ])) as [MethodResponse];
    const eventId = (created.created as Record<string, { id: string }>).e!.id;

    const set = await ann.ok<{ guests: { email: string; status: string }[]; notified: number }>('PUT', `/api/calendar/events/${eventId}/guests`, {
      guests: [benAddress],
    });
    expect(set).toEqual({ guests: [{ email: benAddress, name: null, status: 'needs-action' }], notified: 1 });

    // Ben gets the invitation and accepts it.
    const invitationId = await waitForEmail(ben, benAddress, `Invitation: ${title}`);
    const rendered = await ben.ok<{ calendar: boolean }>('GET', `/api/mail/messages/${invitationId}`);
    expect(rendered.calendar).toBe(true);
    const invitation = await ben.ok<Invitation>('GET', `/api/mail/messages/${invitationId}/invitation`);
    expect(invitation).toMatchObject({ method: 'REQUEST', title, actionable: true, myStatus: 'needs-action' });
    const answered = await ben.ok<Invitation>('POST', `/api/mail/messages/${invitationId}/invitation/respond`, { response: 'accepted' });
    expect(answered.myStatus).toBe('accepted');
    expect(await eventsWithUid(ben, benAddress, title)).toHaveLength(1);

    // Ann gets the answer and applies it to her event.
    const replyId = await waitForEmail(ann, annAddress, `Accepted: ${title}`);
    const reply = await ann.ok<Invitation>('GET', `/api/mail/messages/${replyId}/invitation`);
    expect(reply).toMatchObject({ method: 'REPLY', actionable: true, applied: false, attendees: [{ email: benAddress, status: 'accepted' }] });
    // Ben cannot apply Ann's mail, and it is not his to apply anyway.
    expect((await ben.request('POST', `/api/mail/messages/${replyId}/invitation/apply`)).status).toBe(404);
    expect((await ann.ok<Invitation>('POST', `/api/mail/messages/${replyId}/invitation/apply`)).applied).toBe(true);
    const [mine] = await eventsWithUid(ann, annAddress, title);
    expect(Object.values(mine!.participants!).find((p) => p.email === benAddress)?.participationStatus).toBe('accepted');

    // Busy for colleagues; nothing for people elsewhere.
    const busy = await ann.ok<{ data: { email: string; busy: { start: string; end: string }[] }[]; unavailable: string[] }>(
      'GET',
      `/api/calendar/availability?emails=${encodeURIComponent(`${benAddress},${outsiderAddress}`)}&from=2026-12-08T00:00:00Z&to=2026-12-09T00:00:00Z`,
    );
    expect(busy.data).toEqual([{ email: benAddress, busy: [{ start: '2026-12-08T09:00:00.000Z', end: '2026-12-08T10:00:00.000Z' }] }]);
    expect(busy.unavailable).toEqual([outsiderAddress]);
    const theirs = await outsider.ok<{ data: unknown[] }>(
      'GET',
      `/api/calendar/availability?emails=${encodeURIComponent(annAddress)}&from=2026-12-08T00:00:00Z&to=2026-12-09T00:00:00Z`,
    );
    expect(theirs.data).toEqual([]);

    // Ann cancels: Ben's copy goes once he applies the cancellation.
    expect(await ann.ok('POST', `/api/calendar/events/${eventId}/cancel`)).toEqual({ notified: 1 });
    const cancelId = await waitForEmail(ben, benAddress, `Cancelled: ${title}`);
    expect((await ben.ok<Invitation>('GET', `/api/mail/messages/${cancelId}/invitation`)).actionable).toBe(true);
    await ben.ok('POST', `/api/mail/messages/${cancelId}/invitation/apply`);
    expect(await eventsWithUid(ben, benAddress, title)).toHaveLength(0);
  });

  it('shares calendars and contacts with colleagues only, with the access given', async () => {
    await expect(
      ann.ok('PUT', '/api/calendar/sharing/calendars/Default', { shares: [{ email: outsiderAddress, access: 'read' }] }),
    ).rejects.toThrow(/422/);
    await ann.ok('PUT', '/api/calendar/sharing/calendars/Default', { shares: [{ email: benAddress, access: 'read' }] });
    await ann.ok('PUT', '/api/calendar/sharing/address-books/Default', { shares: [{ email: benAddress, access: 'read' }] });
    const sharing = await ann.ok<{ calendars: { id: string; shares: unknown[] }[] }>('GET', '/api/calendar/sharing');
    expect(sharing.calendars.find((c) => c.id === 'Default')?.shares).toEqual([{ email: benAddress, access: 'read' }]);

    // Ben reads Ann's calendar but cannot write to it.
    const [[, calendars]] = (await call(ben, CALENDARS, [['Calendar/get', { accountId: annAddress }, 'c']])) as [MethodResponse];
    expect((calendars.list as { id: string; myRights: { mayWriteAll: boolean } }[])[0]!.myRights.mayWriteAll).toBe(false);
    const [[, write]] = (await call(ben, CALENDARS, [
      [
        'CalendarEvent/set',
        {
          accountId: annAddress,
          create: { e: { '@type': 'Event', calendarIds: { Default: true }, title: 'sneaky', start: '2026-12-09T10:00:00', duration: 'PT1H' } },
        },
        's',
      ],
    ])) as [MethodResponse];
    expect(write.created ?? null).toBeNull();

    // And reads her contacts.
    const name = unique('Lucía');
    await call(ann, CONTACTS, [['Contact/set', { accountId: annAddress, create: { c: { firstName: name, lastName: 'Gómez' } } }, 's']]);
    const [, [, contacts]] = (await call(ben, CONTACTS, [
      ['Contact/query', { accountId: annAddress }, 'q'],
      ['Contact/get', { accountId: annAddress, '#ids': { resultOf: 'q', name: 'Contact/query', path: '/ids' }, properties: ['firstName'] }, 'g'],
    ])) as [MethodResponse, MethodResponse];
    expect((contacts.list as { firstName: string }[]).map((c) => c.firstName)).toContain(name);

    // The outsider sees nothing of it.
    const [[kind]] = (await call(outsider, CALENDARS, [['Calendar/get', { accountId: annAddress }, 'c']])) as [MethodResponse];
    expect(kind).toBe('error');

    // Stopping sharing takes the access away.
    await ann.ok('PUT', '/api/calendar/sharing/calendars/Default', { shares: [] });
    await ann.ok('PUT', '/api/calendar/sharing/address-books/Default', { shares: [] });
    const [[after]] = (await call(ben, CALENDARS, [['Calendar/get', { accountId: annAddress }, 'c']])) as [MethodResponse];
    expect(after).toBe('error');
  });
});
