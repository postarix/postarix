import type { INestApplication } from '@nestjs/common';
import type { JmapRequest, MemoryMailEngine } from '@postarix/mail-engine';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

type Call = [string, Record<string, unknown>, string];
type Event = Record<string, unknown> & { id: string; uid: string };

// Rooms and equipment: invited like people, they answer by themselves
// (booked when free) and keep the event in their own calendar.
describe('Booking rooms and equipment', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let owner: TestUser;
  let orgId: string;
  let ann: TestAgent;
  let annAddress: string;
  let room: string;
  let projector: string;
  /** Each account's events. */
  let calendars: Map<string, Event[]>;
  const saved = { host: process.env.SUBMISSION_HOST, port: process.env.SUBMISSION_PORT };

  const handle = async (address: string, req: JmapRequest): Promise<Response> => {
    if (req.method === 'GET' && req.path === '') return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': address } });
    if (req.method === 'GET') return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    const body = JSON.parse(Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString()) as { methodCalls: Call[] };
    const [name, args] = body.methodCalls[0]!;
    const events = calendars.get(address) ?? [];
    calendars.set(address, events);
    const reply = (result: Record<string, unknown>) => Response.json({ methodResponses: [[name, result, '0']] });
    switch (name) {
      case 'Calendar/get':
        return reply({ list: [{ id: 'Default', myRights: { mayWriteAll: true } }] });
      case 'CalendarEvent/query': {
        const uid = (args.filter as { uid?: string } | undefined)?.uid;
        return reply({ ids: events.filter((e) => !uid || e.uid === uid).map((e) => e.id) });
      }
      case 'CalendarEvent/get':
        return reply({ list: events.filter((e) => (args.ids as string[]).includes(e.id)) });
      case 'CalendarEvent/set': {
        for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
          const event = events.find((e) => e.id === id);
          if (event) Object.assign(event, patch);
        }
        const created: Record<string, { id: string }> = {};
        for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, Event>)) {
          const id = `${address}-${key}-${events.length}`;
          events.push({ ...value, id, utcStart: '2026-11-20T09:00:00Z', utcEnd: '2026-11-20T10:00:00Z' });
          created[key] = { id };
        }
        const destroyed = (args.destroy as string[] | undefined) ?? [];
        calendars.set(address, events.filter((e) => !destroyed.includes(e.id)));
        return reply({ created, updated: Object.fromEntries(Object.keys(args.update ?? {}).map((k) => [k, null])), destroyed });
      }
      default:
        return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    }
  };

  const meeting = (id: string, uid: string): Event => ({
    id,
    uid,
    title: 'Planning',
    start: '2026-11-20T09:00:00',
    timeZone: 'Etc/UTC',
    duration: 'PT1H',
    utcStart: '2026-11-20T09:00:00Z',
    utcEnd: '2026-11-20T10:00:00Z',
    sequence: 0,
    blobId: 'ics',
    calendarIds: { Default: true },
  });

  beforeAll(async () => {
    process.env.SUBMISSION_HOST = '127.0.0.1';
    process.env.SUBMISSION_PORT = '9'; // nothing listens: emails would fail with 503
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    owner = await signUp(app, 'res-owner');
    orgId = await createOrg(owner, 'Resources');
    const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `res-${Date.now()}.example` });
    await owner.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    const create = async (localPart: string, kind: string, displayName = '') =>
      (await owner.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId: domain.body.id, localPart, password: PASSWORD, kind, displayName }).expect(201)).body as {
        address: string;
        kind: string;
      };
    annAddress = (await create('ann', 'person')).address;
    const r = await create('boardroom', 'room', 'Boardroom');
    expect(r.kind).toBe('room');
    room = r.address;
    projector = (await create('projector', 'equipment', 'Projector')).address;
    ann = await signIn(app, annAddress);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
    Object.assign(process.env, { SUBMISSION_HOST: saved.host, SUBMISSION_PORT: saved.port });
  });

  beforeEach(() => {
    calendars = new Map([[annAddress, [meeting('E1', 'meeting-1')]]]);
    engine.jmapHandler = handle;
  });

  it('lists the organization’s rooms and equipment to its people only', async () => {
    const res = await ann.get('/api/calendar/resources').expect(200);
    expect(res.body.data).toEqual([
      { email: room, name: 'Boardroom', kind: 'room' },
      { email: projector, name: 'Projector', kind: 'equipment' },
    ]);
    const outsider = await mailboxInNewOrg(app, 'res-outsider');
    expect((await outsider.agent.get('/api/calendar/resources').expect(200)).body.data).toEqual([]);
  });

  it('books a free room: it accepts, keeps the event, and gets no email', async () => {
    const res = await ann.put('/api/calendar/events/E1/guests').send({ guests: [room] }).expect(200);
    expect(res.body.notified).toBe(0);
    expect(res.body.guests).toEqual([{ email: room, name: 'Boardroom', status: 'accepted' }]);
    const copy = calendars.get(room)!;
    expect(copy).toHaveLength(1);
    expect(copy[0]).toMatchObject({ uid: 'meeting-1', title: 'Planning', calendarIds: { Default: true } });
  });

  it('declines when the room is taken, and frees it when the event is cancelled', async () => {
    calendars.set(room, [{ ...meeting('R1', 'someone-else'), freeBusyStatus: 'busy' }]);
    const res = await ann.put('/api/calendar/events/E1/guests').send({ guests: [room, projector] }).expect(200);
    expect(res.body.guests).toEqual([
      { email: room, name: 'Boardroom', status: 'declined' },
      { email: projector, name: 'Projector', status: 'accepted' },
    ]);
    expect(calendars.get(room)!.map((e) => e.uid)).toEqual(['someone-else']);
    expect(calendars.get(projector)!.map((e) => e.uid)).toEqual(['meeting-1']);

    await ann.post('/api/calendar/events/E1/cancel').expect(200);
    expect(calendars.get(projector)).toEqual([]);
    expect(calendars.get(room)!.map((e) => e.uid)).toEqual(['someone-else']);
  });

  it('never books another organization’s room', async () => {
    const outsider = await mailboxInNewOrg(app, 'res-intruder');
    calendars.set(outsider.address, [meeting('X1', 'intruder-1')]);
    // To an outsider, the room is just an address: an email invitation (which fails here, nothing listens).
    await outsider.agent.put('/api/calendar/events/X1/guests').send({ guests: [room] }).expect(503);
    expect(calendars.get(room) ?? []).toEqual([]);
  });
});
