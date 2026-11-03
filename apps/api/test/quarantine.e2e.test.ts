import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_ENGINE, QUARANTINE_SOURCE, SYSTEM_MAILER } from '../src/core/tokens.js';
import type { MemorySystemMailer } from '../src/mail/system-mailer.js';
import type { MemoryQuarantineSource } from '../src/quarantine/quarantine-source.js';
import { QuarantineService } from '../src/quarantine/quarantine.js';
import type TestAgent from 'supertest/lib/agent.js';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('Quarantine', () => {
  let app: INestApplication;
  let source: MemoryQuarantineSource;
  let service: QuarantineService;
  let engine: MemoryMailEngine;
  let mailer: MemorySystemMailer;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  const imported: { address: string; mailboxIds: unknown }[] = [];
  const uploads: string[] = [];
  let root: TestAgent;

  const refused = (recipients: string[], subject: string) =>
    source.waiting.push({
      meta: {
        key: `POSTARIX_QUARANTINE:${subject}`,
        envelopeFrom: 'promo@outside.example',
        fromHeader: 'promo@outside.example',
        subject,
        score: 17.5,
        symbols: ['BAYES_SPAM', 'ABUSE_SURBL'],
        recipients,
      },
      raw: Buffer.from(`From: promo@outside.example\r\nSubject: ${subject}\r\n\r\nBuy now\r\n`),
    });

  beforeAll(async () => {
    app = await startApp();
    source = app.get<MemoryQuarantineSource>(QUARANTINE_SOURCE);
    service = app.get(QuarantineService);
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    mailer = app.get<MemorySystemMailer>(SYSTEM_MAILER);
    const email = `quar-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    a = await mailboxInNewOrg(app, 'quar-a');
    b = await mailboxInNewOrg(app, 'quar-b');
    await a.owner.agent
      .post(`/api/orgs/${a.orgId}/aliases`)
      .send({ domainId: a.domainId, localPart: 'sales', destinations: [a.address] })
      .expect(201);
    engine.jmapHandler = async (address, req) => {
      if (req.method === 'GET' && req.path === '') return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct' } });
      if (req.path.startsWith('upload/')) {
        uploads.push(Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString());
        return Response.json({ blobId: 'B1' });
      }
      const body = JSON.parse(Buffer.from(await new Response(req.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString()) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [name, args] = body.methodCalls[0]!;
      if (name === 'Mailbox/get') return Response.json({ methodResponses: [['Mailbox/get', { list: [{ id: 'inbox', role: 'inbox' }] }, '0']] });
      if (name === 'Email/import') {
        imported.push({ address, mailboxIds: (args.emails as { m: { mailboxIds: unknown } }).m.mailboxIds });
        return Response.json({ methodResponses: [['Email/import', { created: { m: { id: 'E1' } } }, '0']] });
      }
      return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    };
  });

  afterAll(async () => {
    engine.jmapHandler = null;
    await app.close();
  });

  it('files refused mail under the mailboxes it was for, also through aliases and +tags', async () => {
    refused([`SALES@${a.domainName}`], 'via-alias');
    refused([a.address.replace('@', '+news@'), `nobody@unknown.example`], 'direct');
    refused([b.address], 'for-b');
    expect(await service.collect()).toBe(3);
    const mine = await a.agent.get('/api/me/quarantine').expect(200);
    expect(mine.body.data.map((i: { subject: string }) => i.subject).sort()).toEqual(['direct', 'via-alias']);
    expect(mine.body.data[0]).toMatchObject({ recipient: a.address, score: 17.5, symbols: ['BAYES_SPAM', 'ABUSE_SURBL'] });
    expect(mine.body.notify).toBe('daily');
  });

  it('lets organization admins see, download and delete their mailboxes’ items only', async () => {
    const list = await a.owner.agent.get(`/api/orgs/${a.orgId}/quarantine`).expect(200);
    expect(list.body.data).toHaveLength(2);
    const id = list.body.data[0].id as string;
    const raw = await a.owner.agent.get(`/api/orgs/${a.orgId}/quarantine/${id}/message`).expect(200);
    expect(raw.headers['content-type']).toContain('message/rfc822');

    const theirs = (await b.owner.agent.get(`/api/orgs/${b.orgId}/quarantine`).expect(200)).body.data[0].id as string;
    await a.owner.agent.get(`/api/orgs/${a.orgId}/quarantine/${theirs}/message`).expect(404);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/quarantine/${theirs}/release`).expect(404);
    await a.owner.agent.delete(`/api/orgs/${a.orgId}/quarantine/${theirs}`).expect(404);
    await a.owner.agent.get(`/api/orgs/${b.orgId}/quarantine`).expect(404);
    await a.agent.delete(`/api/me/quarantine/${theirs}`).expect(404);
    await a.agent.get(`/api/orgs/${a.orgId}/quarantine`).expect(403);
    expect((await b.agent.get('/api/me/quarantine').expect(200)).body.data).toHaveLength(1);
  });

  it('releases an item into its recipient’s inbox', async () => {
    const mine = await a.agent.get('/api/me/quarantine').expect(200);
    const item = mine.body.data.find((i: { subject: string }) => i.subject === 'direct');
    await a.agent.post(`/api/me/quarantine/${item.id}/release`).expect(204);
    expect(imported).toEqual([{ address: a.address, mailboxIds: { inbox: true } }]);
    expect((await a.agent.get('/api/me/quarantine').expect(200)).body.data).toHaveLength(1);
  });

  it('sends digests as often as each mailbox asks, once per item', async () => {
    await b.agent.put('/api/me/quarantine/notify').send({ every: 'never' }).expect(204);
    await b.agent.put('/api/me/quarantine/notify').send({ every: 'monthly' }).expect(400);
    const tomorrow = new Date(Date.now() + 86_400_000 + 60_000);
    mailer.sent.length = 0;
    expect(await service.notify(tomorrow)).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: a.address, subject: '1 message held as spam' });
    expect(mailer.sent[0]!.text).toContain('via-alias');
    expect(await service.notify(tomorrow)).toBe(0);
  });

  it('deletes items after the retention period', async () => {
    await service.housekeeping(new Date(Date.now() + 31 * 86_400_000));
    expect((await a.agent.get('/api/me/quarantine').expect(200)).body.data).toHaveLength(0);
  });

  it('follows the instance’s quarantine settings', async () => {
    try {
      await root
        .put('/api/system/settings')
        .send({
          quarantine: {
            retentionDays: 3,
            maxBytes: 200,
            notifyMaxScore: 20,
            redirectTo: 'spam-desk@example.test',
            bccTo: 'audit@example.test',
            sender: 'quarantine@example.test',
            subject: '{count} for {address}',
            releaseFormat: 'attachment',
            excludedDomains: [b.domainName],
          },
        })
        .expect(200);
      await root.put('/api/system/settings').send({ quarantine: { excludedDomains: ['not a domain!'] } }).expect(400);

      refused([a.address, b.address], 'kept for a only');
      source.waiting.push({
        meta: { key: 'big', envelopeFrom: 'x@outside.example', fromHeader: '', subject: 'too big', score: 9, symbols: [], recipients: [a.address] },
        raw: Buffer.alloc(500, 'x'),
      });
      expect(await service.collect()).toBe(1);
      const mine = (await a.agent.get('/api/me/quarantine').expect(200)).body.data;
      expect(mine.map((i: { subject: string }) => i.subject)).toEqual(['kept for a only']);
      expect((await b.agent.get('/api/me/quarantine').expect(200)).body.data).toHaveLength(0);

      // Score 17.5 is under the cutoff: announced, to the redirect address with a blind copy.
      mailer.sent.length = 0;
      expect(await service.notify(new Date(Date.now() + 86_400_000 + 60_000))).toBe(1);
      expect(mailer.sent[0]).toMatchObject({
        to: 'spam-desk@example.test',
        bcc: 'audit@example.test',
        from: 'quarantine@example.test',
        subject: `1 message for ${a.address}`,
      });
      expect(mailer.sent[0]!.text).toContain('within 3 days');

      // Above the cutoff: kept, never announced.
      source.waiting.push({
        meta: { key: 'obvious', envelopeFrom: 'x@outside.example', fromHeader: '', subject: 'obvious', score: 40, symbols: [], recipients: [a.address] },
        raw: Buffer.from('Subject: obvious\r\n\r\nx\r\n'),
      });
      await service.collect();
      mailer.sent.length = 0;
      expect(await service.notify(new Date(Date.now() + 86_400_000 + 60_000))).toBe(0);
      expect(mailer.sent).toHaveLength(0);

      // Released attached to a note.
      const item = (await a.agent.get('/api/me/quarantine').expect(200)).body.data.find((i: { subject: string }) => i.subject === 'kept for a only');
      uploads.length = 0;
      await a.agent.post(`/api/me/quarantine/${item.id}/release`).expect(204);
      expect(uploads[0]).toContain('Subject: Released from quarantine: kept for a only');
      expect(uploads[0]).toContain('Content-Type: message/rfc822');
      expect(uploads[0]).toContain('Buy now');

      // Retention of 3 days.
      await service.housekeeping(new Date(Date.now() + 4 * 86_400_000));
      expect((await a.agent.get('/api/me/quarantine').expect(200)).body.data).toHaveLength(0);
    } finally {
      await root
        .put('/api/system/settings')
        .send({
          quarantine: {
            retentionDays: null,
            maxBytes: 10 * 1024 * 1024,
            notifyMaxScore: null,
            redirectTo: '',
            bccTo: '',
            sender: '',
            subject: '',
            releaseFormat: 'original',
            excludedDomains: [],
          },
        })
        .expect(200);
    }
  });
});
