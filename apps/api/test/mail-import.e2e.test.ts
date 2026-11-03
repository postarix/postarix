import type { INestApplication } from '@nestjs/common';
import type { JmapRequest, MemoryMailEngine } from '@postarix/mail-engine';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { mailImports } from '../src/db/schema/mail.js';
import type * as ImapSourceModule from '../src/mail-import/imap-source.js';
import { MailImportService } from '../src/mail-import/mail-import.service.js';
import { mailboxInNewOrg, newAgent, signUp, startApp } from './helpers.js';

// The source server: a fake IMAP account with three folders.
const source = vi.hoisted(() => {
  const folders: Record<string, { uidValidity: bigint; messages: { uid: number; flags: string[]; raw: string }[] }> = {
    INBOX: {
      uidValidity: 7n,
      messages: [
        { uid: 3, flags: ['\\Seen'], raw: 'Subject: one\r\n\r\nHello' },
        { uid: 9, flags: ['\\Flagged', '$Custom'], raw: 'Subject: two\r\n\r\nHi' },
      ],
    },
    '[Gmail]/All Mail': { uidValidity: 1n, messages: [{ uid: 1, flags: [], raw: 'Subject: dup\r\n\r\nx' }] },
    'Work/Projects': { uidValidity: 5n, messages: [{ uid: 1, flags: [], raw: 'Subject: plan\r\n\r\nPlan' }] },
  };
  const connects: { host: string; username: string; password: string }[] = [];
  return { folders, connects };
});

vi.mock('../src/mail-import/imap-source.js', async (original) => {
  const actual = await original<typeof ImapSourceModule>();
  return {
    ...actual,
    connectSource: async (s: { host: string; port: number; security: 'tls' | 'starttls'; username: string; password: string }, allowed: string[]) => {
      // The real checks, with the test's server name standing for a public address.
      await actual.sourceAddress({ ...s, host: s.host === 'imap.example.com' ? '93.184.215.14' : s.host }, allowed);
      if (s.password !== 'app password') throw new actual.SourceError('The server refused the user name or password');
      source.connects.push({ host: s.host, username: s.username, password: s.password });
      const client = {
        mailbox: null as { exists: number; uidValidity: bigint } | null,
        list: async () => [
          { path: 'INBOX', delimiter: '/', flags: new Set<string>(), specialUse: '\\Inbox' },
          { path: '[Gmail]', delimiter: '/', flags: new Set(['\\Noselect']) },
          { path: '[Gmail]/All Mail', delimiter: '/', flags: new Set<string>(), specialUse: '\\All' },
          { path: 'Work/Projects', delimiter: '/', flags: new Set<string>() },
        ],
        getMailboxLock: async (path: string) => {
          const folder = source.folders[path]!;
          client.mailbox = { exists: folder.messages.length, uidValidity: folder.uidValidity };
          client.current = path;
          return { release: () => undefined };
        },
        current: '',
        search: async ({ uid }: { uid: string }) => {
          const from = Number(uid.split(':')[0]);
          const uids = source.folders[client.current]!.messages.map((m) => m.uid);
          // Like IMAP, "n:*" always matches the last message.
          return [...new Set([...uids.filter((u) => u >= from), Math.max(...uids)])];
        },
        fetchOne: async (uid: string) => {
          const message = source.folders[client.current]!.messages.find((m) => m.uid === Number(uid));
          return message ? { source: Buffer.from(message.raw), flags: new Set(message.flags), internalDate: new Date('2024-05-01T10:00:00Z') } : false;
        },
        logout: async () => undefined,
      };
      return client;
    },
  };
});

describe('Importing mail from another IMAP account', () => {
  let app: INestApplication;
  let db: Database;
  let engine: MemoryMailEngine;
  let service: MailImportService;
  let imported: { address: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean>; receivedAt: string; raw: string }[];
  let created: { address: string; name: string; parentId: string | null }[];
  const blobs = new Map<string, string>();

  const handle = async (address: string, req: JmapRequest): Promise<Response> => {
    if (req.method === 'GET' && req.path === '') return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': address } });
    const raw = Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString();
    if (req.path.startsWith('upload/')) {
      const blobId = `B${blobs.size + 1}`;
      blobs.set(blobId, raw);
      return Response.json({ blobId });
    }
    const [name, args] = (JSON.parse(raw) as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls[0]!;
    const reply = (result: Record<string, unknown>) => Response.json({ methodResponses: [[name, result, '0']] });
    switch (name) {
      case 'Mailbox/get':
        return reply({ list: [{ id: 'inbox-id', name: 'Inbox', parentId: null, role: 'inbox' }] });
      case 'Mailbox/set': {
        const f = (args.create as Record<string, { name: string; parentId: string | null }>).f!;
        created.push({ address, ...f });
        return reply({ created: { f: { id: `folder-${f.name}` } } });
      }
      case 'Email/import': {
        const m = (args.emails as Record<string, { blobId: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean>; receivedAt: string }>).m!;
        imported.push({ address, mailboxIds: m.mailboxIds, keywords: m.keywords, receivedAt: m.receivedAt, raw: blobs.get(m.blobId)! });
        return reply({ created: { m: { id: `E${imported.length}` } } });
      }
      default:
        return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    }
  };

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    service = app.get(MailImportService);
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  beforeEach(() => {
    imported = [];
    created = [];
    source.connects.length = 0;
    engine.jmapHandler = handle;
  });

  const start = { host: 'imap.example.com', username: 'ann@gmail.example', password: 'app password' };
  // Runs whatever is queued, as the background worker does.
  const work = async () => {
    const queued = await db.select({ id: mailImports.id }).from(mailImports).where(eq(mailImports.status, 'queued'));
    for (const { id } of queued) {
      await db.update(mailImports).set({ status: 'running', lockedAt: new Date() }).where(eq(mailImports.id, id));
      await service.run(id);
    }
  };

  it('copies every folder with its flags, skipping virtual ones, then forgets the password', async () => {
    const person = await mailboxInNewOrg(app, 'imap-import');
    const res = await person.agent.post('/api/me/mail-imports').send(start).expect(201);
    expect(res.body).toMatchObject({ host: 'imap.example.com', username: 'ann@gmail.example', status: 'queued' });
    expect(res.body).not.toHaveProperty('password');
    const [stored] = await db.select().from(mailImports).where(eq(mailImports.id, res.body.id));
    expect(stored!.password).toMatch(/^enc:v1:/);

    await work();
    expect(imported.map((m) => [m.raw.split('\r\n')[0], Object.keys(m.mailboxIds)[0], m.keywords])).toEqual([
      ['Subject: one', 'inbox-id', { $seen: true }],
      ['Subject: two', 'inbox-id', { $flagged: true }],
      ['Subject: plan', 'folder-Projects', {}],
    ]);
    expect(new Set(imported.map((m) => m.address))).toEqual(new Set([person.address]));
    expect(imported[0]!.receivedAt).toBe('2024-05-01T10:00:00.000Z');
    expect(created).toEqual([
      { address: person.address, name: 'Work', parentId: null },
      { address: person.address, name: 'Projects', parentId: 'folder-Work' },
    ]);

    const list = await person.agent.get('/api/me/mail-imports').expect(200);
    expect(list.body.data[0]).toMatchObject({ status: 'done', imported: 3, skipped: 0, error: null });
    const [done] = await db.select().from(mailImports).where(eq(mailImports.id, res.body.id));
    expect(done!.password).toBeNull();

    // Importing the same account again copies only what is new.
    source.folders.INBOX!.messages.push({ uid: 12, flags: [], raw: 'Subject: three\r\n\r\nNew' });
    imported = [];
    await person.agent.post('/api/me/mail-imports').send(start).expect(201);
    await work();
    expect(imported.map((m) => m.raw.split('\r\n')[0])).toEqual(['Subject: three']);
    source.folders.INBOX!.messages.pop();
  });

  it('resumes where it stopped, and only copies new messages', async () => {
    const person = await mailboxInNewOrg(app, 'imap-resume');
    const res = await person.agent.post('/api/me/mail-imports').send(start).expect(201);
    await db
      .update(mailImports)
      .set({ progress: { INBOX: { uidValidity: '7', lastUid: 3 }, 'Work/Projects': { uidValidity: '5', lastUid: 1 } } })
      .where(eq(mailImports.id, res.body.id));
    await work();
    expect(imported.map((m) => m.raw.split('\r\n')[0])).toEqual(['Subject: two']);
  });

  it('checks the account before queuing, and refuses servers on private networks', async () => {
    const person = await mailboxInNewOrg(app, 'imap-check');
    const wrong = await person.agent.post('/api/me/mail-imports').send({ ...start, password: 'wrong' }).expect(422);
    expect(wrong.body.message).toMatch(/refused the user name or password/);
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254']) {
      const res = await person.agent.post('/api/me/mail-imports').send({ ...start, host }).expect(422);
      expect(res.body.message).toMatch(/not a public mail server/);
    }
    await person.agent.post('/api/me/mail-imports').send({ ...start, port: 25 }).expect(422);
    await person.agent.post('/api/me/mail-imports').send({ ...start, host: 'bad host!' }).expect(400);
    expect(source.connects).toEqual([]);
  });

  it('runs one import at a time per person, and can be cancelled', async () => {
    const person = await mailboxInNewOrg(app, 'imap-cancel');
    const first = await person.agent.post('/api/me/mail-imports').send(start).expect(201);
    await person.agent.post('/api/me/mail-imports').send(start).expect(409);
    const cancelled = await person.agent.post(`/api/me/mail-imports/${first.body.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    const [row] = await db.select().from(mailImports).where(eq(mailImports.id, first.body.id));
    expect(row!.password).toBeNull();
    await person.agent.post('/api/me/mail-imports').send(start).expect(201);
    await db.execute(sql`UPDATE mail_imports SET status = 'cancelled' WHERE user_id = ${row!.userId}`);
  });

  it('shows and cancels only the person’s own imports', async () => {
    const ann = await mailboxInNewOrg(app, 'imap-ann');
    const ben = await mailboxInNewOrg(app, 'imap-ben');
    const job = await ann.agent.post('/api/me/mail-imports').send(start).expect(201);
    expect((await ben.agent.get('/api/me/mail-imports').expect(200)).body.data).toEqual([]);
    await ben.agent.post(`/api/me/mail-imports/${job.body.id}/cancel`).expect(404);
    expect((await ann.agent.get('/api/me/mail-imports').expect(200)).body.data[0].status).toBe('queued');
    await newAgent(app).get('/api/me/mail-imports').expect(401);
    const noMailbox = await signUp(app, 'imap-nomailbox');
    await noMailbox.agent.post('/api/me/mail-imports').send(start).expect(404);
    await ann.agent.post(`/api/me/mail-imports/${job.body.id}/cancel`).expect(200);
  });

  describe('administrators’ sync jobs', () => {
    const setup = async (prefix: string) => {
      const org = await mailboxInNewOrg(app, prefix);
      const list = await org.owner.agent.get(`/api/orgs/${org.orgId}/mailboxes`).expect(200);
      const mailboxId = (list.body.data as { id: string; address: string }[]).find((m) => m.address === org.address)!.id;
      return { ...org, mailboxId };
    };

    it('copies into a mailbox of the organization, and a recurring job runs again with only what is new', async () => {
      const org = await setup('sync-admin');
      const res = await org.owner.agent
        .post(`/api/orgs/${org.orgId}/sync-jobs`)
        .send({ ...start, mailboxId: org.mailboxId, intervalMinutes: 30 })
        .expect(201);
      expect(res.body).toMatchObject({ mailboxAddress: org.address, intervalMinutes: 30, status: 'queued' });
      expect(res.body).not.toHaveProperty('password');
      await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs`).send({ ...start, mailboxId: org.mailboxId }).expect(409);

      await work();
      expect(new Set(imported.map((m) => m.address))).toEqual(new Set([org.address]));
      expect(imported).toHaveLength(3);
      const [done] = await db.select().from(mailImports).where(eq(mailImports.id, res.body.id));
      expect(done).toMatchObject({ status: 'done', imported: 3 });
      expect(done!.password).toMatch(/^enc:v1:/);
      expect(done!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);

      // Not due yet: nothing happens.
      await service.requeueDue();
      expect((await db.select().from(mailImports).where(eq(mailImports.id, res.body.id)))[0]!.status).toBe('done');
      // Due: it runs again and copies only the new message.
      source.folders.INBOX!.messages.push({ uid: 20, flags: [], raw: 'Subject: later\r\n\r\nNew' });
      imported = [];
      await db.update(mailImports).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(mailImports.id, res.body.id));
      await service.requeueDue();
      await work();
      expect(imported.map((m) => m.raw.split('\r\n')[0])).toEqual(['Subject: later']);
      source.folders.INBOX!.messages.pop();

      // Run now, then cancel: the password is gone and it stops recurring.
      const now = await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs/${res.body.id}/run`).expect(200);
      expect(now.body.status).toBe('queued');
      await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs/${res.body.id}/run`).expect(409);
      const cancelled = await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs/${res.body.id}/cancel`).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', nextRunAt: null });
      expect((await db.select().from(mailImports).where(eq(mailImports.id, res.body.id)))[0]!.password).toBeNull();
      await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs/${res.body.id}/run`).expect(409);

      const listed = await org.owner.agent.get(`/api/orgs/${org.orgId}/sync-jobs?mailboxId=${org.mailboxId}`).expect(200);
      expect(listed.body.data.map((j: { id: string }) => j.id)).toEqual([res.body.id]);
      // The person's own list shows only what they started.
      expect((await org.agent.get('/api/me/mail-imports').expect(200)).body.data).toEqual([]);
      await org.owner.agent.delete(`/api/orgs/${org.orgId}/sync-jobs/${res.body.id}`).expect(204);
      expect((await org.owner.agent.get(`/api/orgs/${org.orgId}/sync-jobs`).expect(200)).body.data).toEqual([]);
    });

    it('checks the account and the interval before saving', async () => {
      const org = await setup('sync-check');
      await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs`).send({ ...start, password: 'wrong', mailboxId: org.mailboxId }).expect(422);
      await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs`).send({ ...start, mailboxId: org.mailboxId, intervalMinutes: 1 }).expect(400);
      await org.owner.agent.post(`/api/orgs/${org.orgId}/sync-jobs`).send({ ...start, mailboxId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      // Members who are not administrators cannot use it.
      await org.agent.get(`/api/orgs/${org.orgId}/sync-jobs`).expect(403);
    });

    it('keeps each organization’s jobs and mailboxes to itself', async () => {
      const a = await setup('sync-iso-a');
      const b = await setup('sync-iso-b');
      const job = await a.owner.agent.post(`/api/orgs/${a.orgId}/sync-jobs`).send({ ...start, mailboxId: a.mailboxId }).expect(201);
      // B cannot sync into A's mailbox, nor see or touch A's job, from its own organization or A's.
      await b.owner.agent.post(`/api/orgs/${b.orgId}/sync-jobs`).send({ ...start, mailboxId: a.mailboxId }).expect(404);
      expect((await b.owner.agent.get(`/api/orgs/${b.orgId}/sync-jobs`).expect(200)).body.data).toEqual([]);
      await b.owner.agent.get(`/api/orgs/${a.orgId}/sync-jobs`).expect(404);
      for (const action of ['run', 'cancel']) await b.owner.agent.post(`/api/orgs/${b.orgId}/sync-jobs/${job.body.id}/${action}`).expect(404);
      await b.owner.agent.delete(`/api/orgs/${b.orgId}/sync-jobs/${job.body.id}`).expect(404);
      await b.owner.agent.delete(`/api/orgs/${a.orgId}/sync-jobs/${job.body.id}`).expect(404);
      expect((await a.owner.agent.get(`/api/orgs/${a.orgId}/sync-jobs`).expect(200)).body.data[0].status).toBe('queued');
      await a.owner.agent.post(`/api/orgs/${a.orgId}/sync-jobs/${job.body.id}/cancel`).expect(200);
    });
  });
});
