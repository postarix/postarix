import type { INestApplication } from '@nestjs/common';
import type { JmapRequest, MemoryMailEngine } from '@postarix/mail-engine';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { createOrg, mailboxInNewOrg, newAgent, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

type Call = [string, Record<string, unknown>, string];

const INVITE = (organizer: string, attendee: string, method = 'REQUEST', partstat = 'NEEDS-ACTION') =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'UID:event-uid-1',
    'SEQUENCE:1',
    'DTSTAMP:20261102T100000Z',
    'DTSTART:20261120T090000Z',
    'DURATION:PT1H',
    'SUMMARY:Planning',
    `ORGANIZER:mailto:${organizer}`,
    `ATTENDEE;PARTSTAT=${partstat}:mailto:${attendee}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

// Authorization and isolation of calendar features. Calendar behaviour itself
// (Cyrus, real mail) is covered by the integration tests; sending here points
// nowhere, so a request that passes every check ends with 503.
describe('Calendar: guests, free/busy, sharing and invitations', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let admin: TestUser;
  let ann: TestAgent;
  let annAddress: string;
  let benAddress: string;
  let outsider: { agent: TestAgent; address: string };
  let seen: { address: string; method: string }[];
  let event: Record<string, unknown> | null;
  let message: { from: string; ics: string } | null;
  const saved = { host: process.env.SUBMISSION_HOST, port: process.env.SUBMISSION_PORT };

  const handle = async (address: string, req: JmapRequest): Promise<Response> => {
    if (req.method === 'GET' && req.path === '') return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': address } });
    if (req.method === 'GET' && req.path.startsWith('download/')) {
      return new Response(req.path.includes('/msgics/') ? (message?.ics ?? '') : INVITE(address, 'guest@outside.example'));
    }
    const body = JSON.parse(Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString()) as {
      methodCalls: Call[];
    };
    const [name, args] = body.methodCalls[0]!;
    seen.push({ address, method: name });
    const reply = (result: Record<string, unknown>) => Response.json({ methodResponses: [[name, result, '0']] });
    switch (name) {
      case 'Calendar/get':
        return reply({ list: [{ id: 'Default', name: 'Personal', includeInAvailability: 'all', myRights: { mayWriteAll: true } }] });
      case 'CalendarEvent/get':
        return reply({ list: event ? [event] : [] });
      case 'CalendarEvent/query':
        if ((args.filter as { uid?: string } | undefined)?.uid) return reply({ ids: event ? [event.id] : [] });
        return reply({ ids: ['E1'] });
      case 'CalendarEvent/set':
        return reply({ updated: { E1: null }, created: { invitation: { id: 'E2' } }, destroyed: args.destroy ?? [] });
      case 'CalendarEvent/parse':
        return reply({
          parsed: {
            msgics: {
              '@type': 'Event',
              uid: 'event-uid-1',
              title: 'Planning',
              start: '2026-11-20T09:00:00',
              timeZone: 'Etc/UTC',
              duration: 'PT1H',
              participants: {
                a: { '@type': 'Participant', email: annAddress, participationStatus: 'needs-action', roles: { attendee: true } },
              },
            },
          },
        });
      case 'Email/get':
        return reply({
          list: message
            ? [
                {
                  id: 'M1',
                  from: [{ email: message.from }],
                  bodyStructure: {
                    type: 'multipart/alternative',
                    size: 0,
                    subParts: [
                      { partId: '1', blobId: 'text', type: 'text/plain', size: 10 },
                      { partId: '2', blobId: 'msgics', type: 'text/calendar', size: 400 },
                    ],
                  },
                },
              ]
            : [],
        });
      default:
        return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    }
  };

  beforeAll(async () => {
    process.env.SUBMISSION_HOST = '127.0.0.1';
    process.env.SUBMISSION_PORT = '9'; // discard: nothing listens
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    admin = await signUp(app, 'cal-admin');
    const orgId = await createOrg(admin, 'Calendar');
    const domain = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `cal-${Date.now()}.example` });
    await admin.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    const create = async (localPart: string) =>
      (await admin.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId: domain.body.id, localPart, password: PASSWORD }).expect(201))
        .body.address as string;
    annAddress = await create('ann');
    benAddress = await create('ben');
    ann = await signIn(app, annAddress);
    outsider = await mailboxInNewOrg(app, 'cal-outsider');
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
    Object.assign(process.env, { SUBMISSION_HOST: saved.host, SUBMISSION_PORT: saved.port });
  });

  beforeEach(() => {
    seen = [];
    message = null;
    event = {
      id: 'E1',
      uid: 'event-uid-1',
      title: 'Planning',
      start: '2026-11-20T09:00:00',
      timeZone: 'Etc/UTC',
      duration: 'PT1H',
      utcStart: '2026-11-20T09:00:00Z',
      utcEnd: '2026-11-20T10:00:00Z',
      freeBusyStatus: 'busy',
      calendarIds: { Default: true },
      sequence: 0,
      blobId: 'eventics',
    };
    engine.jmapHandler = handle;
  });

  it('makes the calendars of new mailboxes private', () => {
    expect(engine.restricted.has(annAddress)).toBe(true);
    expect(engine.restricted.has(benAddress)).toBe(true);
  });

  it('needs a signed-in person with a mailbox', async () => {
    const anonymous = newAgent(app);
    await anonymous.get('/api/calendar/sharing').expect(401);
    await anonymous.put('/api/calendar/events/E1/guests').send({ guests: [] }).expect(401);
    await anonymous.get('/api/mail/messages/M1/invitation').expect(401);
    await admin.agent.get('/api/calendar/sharing').expect(404);
  });

  it('shows colleagues’ busy times but nothing about people in other organizations', async () => {
    const query = { emails: `${benAddress},${outsider.address},nobody@nowhere.example`, from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' };
    const res = await ann.get('/api/calendar/availability').query(query).expect(200);
    expect(res.body.data).toEqual([{ email: benAddress, busy: [{ start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:00:00.000Z' }] }]);
    expect(res.body.unavailable).toEqual([outsider.address, 'nobody@nowhere.example']);
    // Only Ben's calendar was read, and only times are returned.
    expect(new Set(seen.map((s) => s.address))).toEqual(new Set([benAddress]));
    expect(JSON.stringify(res.body)).not.toContain('Planning');

    // And the outsider learns nothing about Ann's organization.
    seen = [];
    const theirs = await outsider.agent.get('/api/calendar/availability').query({ ...query, emails: annAddress }).expect(200);
    expect(theirs.body).toEqual({ data: [], unavailable: [annAddress] });
    expect(seen).toEqual([]);
  });

  it('skips free and declined events, and limits what can be asked', async () => {
    event!.freeBusyStatus = 'free';
    const free = await ann.get('/api/calendar/availability').query({ emails: benAddress, from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' });
    expect(free.body.data).toEqual([{ email: benAddress, busy: [] }]);
    event!.freeBusyStatus = 'busy';
    event!.participants = { b: { email: benAddress, participationStatus: 'declined' } };
    const declined = await ann.get('/api/calendar/availability').query({ emails: benAddress, from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' });
    expect(declined.body.data).toEqual([{ email: benAddress, busy: [] }]);

    await ann.get('/api/calendar/availability').query({ emails: benAddress, from: '2026-11-20T00:00:00Z', to: '2027-03-01T00:00:00Z' }).expect(422);
    await ann.get('/api/calendar/availability').query({ emails: benAddress, from: '2026-11-21T00:00:00Z', to: '2026-11-20T00:00:00Z' }).expect(422);
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@x.example`).join(',');
    await ann.get('/api/calendar/availability').query({ emails: many, from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }).expect(400);
  });

  it('shares calendars and contacts only inside the organization', async () => {
    const shared = await ann
      .put('/api/calendar/sharing/calendars/Default')
      .send({ shares: [{ email: benAddress, access: 'read' }] })
      .expect(200);
    expect(shared.body).toEqual({ id: 'Default', name: 'Personal', shares: [{ email: benAddress, access: 'read' }] });
    await ann.put('/api/calendar/sharing/address-books/Default').send({ shares: [{ email: benAddress, access: 'write' }] }).expect(200);

    const refused = await ann
      .put('/api/calendar/sharing/calendars/Default')
      .send({ shares: [{ email: benAddress, access: 'write' }, { email: outsider.address, access: 'read' }] })
      .expect(422);
    expect(refused.body.message).toContain(outsider.address);
    await ann.put('/api/calendar/sharing/calendars/Default').send({ shares: [{ email: annAddress, access: 'read' }] }).expect(422);
    await ann.put('/api/calendar/sharing/address-books/Other').send({ shares: [] }).expect(404);
    await ann.put('/api/calendar/sharing/folders/Default').send({ shares: [] }).expect(400);

    const list = await ann.get('/api/calendar/sharing').expect(200);
    expect(list.body).toEqual({
      calendars: [{ id: 'Default', name: 'Personal', shares: [{ email: benAddress, access: 'read' }] }],
      addressBooks: [{ id: 'Default', name: 'Contacts', shares: [{ email: benAddress, access: 'write' }] }],
    });
    // The outsider's sharing is about their own calendars only.
    const theirs = await outsider.agent.get('/api/calendar/sharing').expect(200);
    expect(theirs.body.calendars[0].shares).toEqual([]);

    await ann.put('/api/calendar/sharing/calendars/Default').send({ shares: [] }).expect(200);
    await ann.put('/api/calendar/sharing/address-books/Default').send({ shares: [] }).expect(200);
  });

  it('invites guests to the person’s own events only', async () => {
    // Reaches sending (nothing listens) after updating the event.
    await ann.put('/api/calendar/events/E1/guests').send({ guests: ['guest@outside.example'] }).expect(503);
    expect(seen.map((s) => s.method)).toContain('CalendarEvent/set');
    expect(new Set(seen.map((s) => s.address))).toEqual(new Set([annAddress]));

    event!.replyTo = { imip: 'mailto:someone@else.example' };
    await ann.put('/api/calendar/events/E1/guests').send({ guests: ['guest@outside.example'] }).expect(403);
    event = null;
    await ann.put('/api/calendar/events/E1/guests').send({ guests: ['guest@outside.example'] }).expect(404);
    await ann.put('/api/calendar/events/E1/guests').send({ guests: ['not an address'] }).expect(400);
    const tooMany = Array.from({ length: 51 }, (_, i) => `g${i}@x.example`);
    await ann.put('/api/calendar/events/E1/guests').send({ guests: tooMany }).expect(400);
    await ann.put('/api/calendar/events/..%2Fx/guests').send({ guests: [] }).expect(400);
  });

  it('reads invitations in the person’s mail and answers them', async () => {
    message = { from: 'boss@outside.example', ics: INVITE('boss@outside.example', annAddress) };
    event = null;
    const res = await ann.get('/api/mail/messages/M1/invitation').expect(200);
    expect(res.body).toMatchObject({
      method: 'REQUEST',
      uid: 'event-uid-1',
      title: 'Planning',
      attendee: annAddress,
      myStatus: 'needs-action',
      actionable: true,
      organizer: { email: 'boss@outside.example' },
    });
    await ann.post('/api/mail/messages/M1/invitation/respond').send({ response: 'accepted' }).expect(503);
    expect(seen.map((s) => s.method)).toContain('CalendarEvent/set');
    await ann.post('/api/mail/messages/M1/invitation/respond').send({ response: 'maybe' }).expect(400);

    // Not addressed to Ann.
    message = { from: 'boss@outside.example', ics: INVITE('boss@outside.example', 'other@outside.example') };
    expect((await ann.get('/api/mail/messages/M1/invitation').expect(200)).body.actionable).toBe(false);
    await ann.post('/api/mail/messages/M1/invitation/respond').send({ response: 'accepted' }).expect(403);

    // Messages without one.
    message = null;
    await ann.get('/api/mail/messages/M1/invitation').expect(404);
  });

  it('applies replies and cancellations only from the person they speak for', async () => {
    event!.replyTo = { imip: `mailto:${annAddress}` };
    event!.participants = {
      o: { email: annAddress, roles: { owner: true }, participationStatus: 'accepted' },
      g: { email: 'guest@outside.example', participationStatus: 'needs-action' },
    };
    message = { from: 'guest@outside.example', ics: INVITE(annAddress, 'guest@outside.example', 'REPLY', 'ACCEPTED') };
    expect((await ann.get('/api/mail/messages/M1/invitation').expect(200)).body).toMatchObject({ method: 'REPLY', actionable: true, applied: false });
    seen = [];
    await ann.post('/api/mail/messages/M1/invitation/apply').expect(200);
    expect(seen.map((s) => s.method)).toContain('CalendarEvent/set');

    // Someone else claiming to be the guest.
    message = { from: 'mallory@outside.example', ics: INVITE(annAddress, 'guest@outside.example', 'REPLY', 'DECLINED') };
    expect((await ann.get('/api/mail/messages/M1/invitation').expect(200)).body.actionable).toBe(false);
    await ann.post('/api/mail/messages/M1/invitation/apply').expect(403);

    // A cancellation from someone who is not the organizer of Ann's copy.
    event!.replyTo = { imip: 'mailto:boss@outside.example' };
    message = { from: 'mallory@outside.example', ics: INVITE('boss@outside.example', annAddress, 'CANCEL') };
    await ann.post('/api/mail/messages/M1/invitation/apply').expect(403);
    message = { from: 'boss@outside.example', ics: INVITE('boss@outside.example', annAddress, 'CANCEL') };
    seen = [];
    await ann.post('/api/mail/messages/M1/invitation/apply').expect(200);
    expect(seen.map((s) => s.method)).toContain('CalendarEvent/set');
  });

  it('looks invitations up in the person’s own mailbox only', async () => {
    message = { from: 'boss@outside.example', ics: INVITE('boss@outside.example', annAddress) };
    seen = [];
    await outsider.agent.get('/api/mail/messages/M1/invitation').expect(200);
    expect(new Set(seen.map((s) => s.address))).toEqual(new Set([outsider.address]));
  });
});
