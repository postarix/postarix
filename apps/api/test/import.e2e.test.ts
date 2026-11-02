import type { INestApplication } from '@nestjs/common';
import type { JmapRequest, MemoryMailEngine } from '@postarix/mail-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { mailboxInNewOrg, newAgent, signUp, startApp } from './helpers.js';

type Call = [string, Record<string, unknown>, string];

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'BEGIN:VEVENT',
  'UID:one@google.com',
  'DTSTART:20261120T090000Z',
  'DTEND:20261120T100000Z',
  'SUMMARY:Planning',
  'ORGANIZER:mailto:boss@outside.example',
  'ATTENDEE:mailto:someone@outside.example',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:two@google.com',
  'DTSTART;VALUE=DATE:20261124',
  'SUMMARY:Holiday',
  'RRULE:FREQ=YEARLY',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Lovelace;Ada;;;',
  'FN:Ada Lovelace',
  'ORG:Analytical Engines;Research',
  'TITLE:Mathematician',
  'EMAIL;TYPE=INTERNET,WORK:ada@engines.example',
  'EMAIL;TYPE=INTERNET,HOME,PREF:ada@home.example',
  'TEL;TYPE=CELL:+44 20 0000 0000',
  'NOTE:Met at the conference',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Garc=C3=ADa;Jos=C3=A9;;;',
  'EMAIL;INTERNET:jose@outside.example',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Already Known',
  'EMAIL:known@outside.example',
  'END:VCARD',
  '',
].join('\r\n');

describe('Importing calendars (.ics) and contacts (.vcf)', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let calls: { address: string; name: string; args: Record<string, unknown> }[];
  let uploads: { address: string; type: string | undefined; body: string }[];

  const handle = async (address: string, req: JmapRequest): Promise<Response> => {
    if (req.method === 'GET' && req.path === '') return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': address } });
    const raw = Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString();
    if (req.path.startsWith('upload/')) {
      uploads.push({ address, type: req.contentType, body: raw });
      return Response.json({ blobId: 'B1' });
    }
    const [name, args] = (JSON.parse(raw) as { methodCalls: Call[] }).methodCalls[0]!;
    calls.push({ address, name, args });
    const reply = (result: Record<string, unknown>) => Response.json({ methodResponses: [[name, result, '0']] });
    const createdAll = () => Object.fromEntries(Object.keys(args.create as object).map((k) => [k, { id: `id-${k}` }]));
    switch (name) {
      case 'Calendar/get':
        return reply({ list: (args.ids as string[] | undefined)?.includes('Nope') ? [] : [{ id: 'Default', myRights: { mayWriteAll: true } }] });
      case 'CalendarEvent/parse':
        return reply({
          parsed: {
            B1: {
              '@type': 'Group',
              entries: [
                {
                  '@type': 'Event',
                  uid: 'one@google.com',
                  title: 'Planning',
                  start: '2026-11-20T09:00:00',
                  timeZone: 'Etc/UTC',
                  duration: 'PT1H',
                  replyTo: { imip: 'mailto:boss@outside.example' },
                  participants: { a: { email: 'someone@outside.example' } },
                },
                {
                  '@type': 'Event',
                  uid: 'two@google.com',
                  title: 'Holiday',
                  start: '2026-11-24T00:00:00',
                  showWithoutTime: true,
                  recurrenceRules: [{ frequency: 'yearly' }],
                  recurrenceOverrides: { '2027-11-24T00:00:00': { title: 'Moved', 'participants/a/email': 'x@y.example' } },
                },
              ],
            },
          },
        });
      case 'CalendarEvent/set':
        return reply({ created: createdAll() });
      case 'Contact/query':
        return reply({ ids: ['K1'] });
      case 'Contact/get':
        return reply({ list: [{ emails: [{ value: 'Known@outside.example' }] }] });
      case 'Contact/set':
        return reply({ created: createdAll() });
      default:
        return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    }
  };

  beforeAll(async () => {
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  beforeEach(() => {
    calls = [];
    uploads = [];
    engine.jmapHandler = handle;
  });

  it('imports events into the person’s own calendar, without guests or organizer', async () => {
    const person = await mailboxInNewOrg(app, 'import-ics');
    const res = await person.agent.post('/api/calendar/import').set('content-type', 'text/calendar').send(ICS).expect(200);
    expect(res.body).toEqual({ imported: 2, skipped: 0 });
    expect(uploads).toEqual([{ address: person.address, type: 'text/calendar', body: ICS }]);
    const set = calls.find((c) => c.name === 'CalendarEvent/set')!;
    expect(set.address).toBe(person.address);
    const created = Object.values(set.args.create as Record<string, Record<string, unknown>>);
    expect(created.map((e) => e.title)).toEqual(['Planning', 'Holiday']);
    for (const event of created) {
      expect(event.calendarIds).toEqual({ Default: true });
      expect(event).not.toHaveProperty('participants');
      expect(event).not.toHaveProperty('replyTo');
    }
    expect(created[1]!.recurrenceOverrides).toEqual({ '2027-11-24T00:00:00': { title: 'Moved' } });
  });

  it('refuses files it cannot or will not read', async () => {
    const person = await mailboxInNewOrg(app, 'import-bad');
    await person.agent.post('/api/calendar/import').set('content-type', 'text/calendar').send('not a calendar').expect(422);
    const minutely = ICS.replace('RRULE:FREQ=YEARLY', 'RRULE:FREQ=MINUTELY');
    await person.agent.post('/api/calendar/import').set('content-type', 'text/calendar').send(minutely).expect(422);
    // Only the file types and routes meant for it.
    await person.agent.post('/api/calendar/import').set('content-type', 'application/octet-stream').send(Buffer.from(ICS)).expect(415);
    await person.agent.post('/api/calendar/import').set('content-type', 'text/calendar').query({ calendarId: 'Nope' }).send(ICS).expect(404);
    expect(uploads).toEqual([]);
  });

  it('imports contacts, skipping people already in the address book', async () => {
    const person = await mailboxInNewOrg(app, 'import-vcf');
    const res = await person.agent.post('/api/contacts/import').set('content-type', 'text/vcard').send(VCF).expect(200);
    expect(res.body).toEqual({ imported: 2, skipped: 1 });
    const set = calls.find((c) => c.name === 'Contact/set')!;
    expect(set.address).toBe(person.address);
    expect(Object.values(set.args.create as object)).toEqual([
      {
        firstName: 'Ada',
        lastName: 'Lovelace',
        company: 'Analytical Engines',
        jobTitle: 'Mathematician',
        nickname: '',
        notes: 'Met at the conference',
        emails: [
          { type: 'personal', value: 'ada@home.example', isDefault: true },
          { type: 'work', value: 'ada@engines.example', isDefault: false },
        ],
        phones: [{ type: 'mobile', value: '+44 20 0000 0000' }],
      },
      {
        firstName: 'José',
        lastName: 'García',
        company: '',
        jobTitle: '',
        nickname: '',
        notes: '',
        emails: [{ type: 'other', value: 'jose@outside.example', isDefault: true }],
        phones: [],
      },
    ]);
    await person.agent.post('/api/contacts/import').set('content-type', 'text/vcard').send('BEGIN:VCARD\r\nEND:VCARD\r\n').expect(422);
  });

  it('needs a signed-in person with a mailbox, and touches only their own data', async () => {
    await newAgent(app).post('/api/calendar/import').set('content-type', 'text/calendar').send(ICS).expect(401);
    await newAgent(app).post('/api/contacts/import').set('content-type', 'text/vcard').send(VCF).expect(401);
    const noMailbox = await signUp(app, 'import-nomailbox');
    await noMailbox.agent.post('/api/calendar/import').set('content-type', 'text/calendar').send(ICS).expect(404);
    const a = await mailboxInNewOrg(app, 'import-a');
    await mailboxInNewOrg(app, 'import-b');
    await a.agent.post('/api/contacts/import').set('content-type', 'text/vcard').send(VCF).expect(200);
    expect(new Set(calls.map((c) => c.address))).toEqual(new Set([a.address]));
  });
});
