import type { INestApplication } from '@nestjs/common';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { authOf, createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp } from './helpers.js';

const GiB = 1024 ** 3;

describe('Domain and mailbox templates', () => {
  let app: INestApplication;
  let root: TestAgent;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  beforeAll(async () => {
    app = await startApp();
    const email = `tpl-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    a = await mailboxInNewOrg(app, 'tpl-a');
    b = await mailboxInNewOrg(app, 'tpl-b');
  });

  afterAll(async () => {
    // Domain templates are instance-wide: leave none behind for other tests.
    const list = await root.get('/api/system/domain-templates').expect(200);
    for (const t of list.body.data as { id: string }[]) await root.delete(`/api/system/domain-templates/${t.id}`).expect(204);
    await app.close();
  });

  it('gives new domains the default domain template, limits included, and lets instance admins pick another', async () => {
    await a.owner.agent.get('/api/system/domain-templates').expect(404);
    await root
      .post('/api/system/domain-templates')
      .send({ name: 'Bad', settings: { maxMailboxQuotaBytes: 2 * GiB } })
      .expect(400);
    const small = await root
      .post('/api/system/domain-templates')
      .send({
        name: 'Small',
        isDefault: true,
        settings: { defaultMailboxQuotaBytes: GiB, maxMailboxQuotaBytes: 2 * GiB, maxMailboxes: 5, rateLimit: { messages: 100, per: 'hour' }, mtaStsMode: 'enforce' },
      })
      .expect(201);
    const large = await root.post('/api/system/domain-templates').send({ name: 'Large', isDefault: true, settings: { maxMailboxes: 500 } }).expect(201);
    // Only one default: the newer one.
    let list = await root.get('/api/system/domain-templates').expect(200);
    expect(list.body.data.map((t: { name: string; isDefault: boolean }) => [t.name, t.isDefault])).toEqual([
      ['Large', true],
      ['Small', false],
    ]);
    await root.patch(`/api/system/domain-templates/${small.body.id}`).send({ isDefault: true }).expect(200);
    await root.post('/api/system/domain-templates').send({ name: 'small', settings: {} }).expect(409);

    // An organization admin's new domain gets the default template.
    const created = await a.owner.agent.post(`/api/orgs/${a.orgId}/domains`).send({ name: `tpl-${Date.now()}.example` }).expect(201);
    expect(created.body).toMatchObject({
      defaultMailboxQuotaBytes: GiB,
      limits: { maxMailboxes: 5, maxMailboxQuotaBytes: 2 * GiB },
      rateLimit: { messages: 100, per: 'hour' },
      mtaStsMode: 'enforce',
    });
    // Only instance administrators choose one.
    await a.owner.agent.post(`/api/orgs/${a.orgId}/domains`).send({ name: `tpl2-${Date.now()}.example`, templateId: large.body.id }).expect(403);
    const picked = await root.post(`/api/orgs/${a.orgId}/domains`).send({ name: `tpl3-${Date.now()}.example`, templateId: large.body.id }).expect(201);
    expect(picked.body.limits.maxMailboxes).toBe(500);
    await root.post(`/api/orgs/${a.orgId}/domains`).send({ name: `tpl4-${Date.now()}.example`, templateId: '00000000-0000-4000-8000-000000000000' }).expect(422);

    list = await root.get('/api/system/domain-templates').expect(200);
    for (const t of list.body.data as { id: string }[]) await root.delete(`/api/system/domain-templates/${t.id}`).expect(204);
  });

  it('gives new mailboxes the organization’s default mailbox template', async () => {
    const template = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/mailbox-templates`)
      .send({
        name: 'Staff',
        isDefault: true,
        settings: { quotaBytes: 2 * GiB, allowedProtocols: ['imap', 'smtp'], tlsRequiredIn: true, quarantineNotify: 'weekly', spamScores: { junkScore: 4, rejectScore: 12 } },
      })
      .expect(201);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/mailbox-templates`).send({ name: 'Bad', settings: { allowedProtocols: ['telnet'] } }).expect(400);

    const mailbox = await a.owner.agent.post(`/api/orgs/${a.orgId}/mailboxes`).send({ domainId: a.domainId, localPart: 'tpl-default', password: PASSWORD }).expect(201);
    expect(mailbox.body).toMatchObject({
      quotaBytes: 2 * GiB,
      allowedProtocols: ['imap', 'smtp'],
      tlsRequiredIn: true,
      quarantineNotify: 'weekly',
      spamScores: { junkScore: 4, rejectScore: 12 },
    });
    // What the request says wins over the template.
    const explicit = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/mailboxes`)
      .send({ domainId: a.domainId, localPart: 'tpl-explicit', password: PASSWORD, quotaBytes: GiB, templateId: template.body.id })
      .expect(201);
    expect(explicit.body.quotaBytes).toBe(GiB);
    expect(explicit.body.tlsRequiredIn).toBe(true);
    // null: no template at all, not even the default one.
    const plain = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/mailboxes`)
      .send({ domainId: a.domainId, localPart: 'tpl-none', password: PASSWORD, templateId: null })
      .expect(201);
    expect(plain.body).toMatchObject({ quotaBytes: null, tlsRequiredIn: false, quarantineNotify: 'daily' });
  });

  it('keeps each organization’s mailbox templates to itself', async () => {
    const template = await a.owner.agent.post(`/api/orgs/${a.orgId}/mailbox-templates`).send({ name: 'Private', settings: { tlsRequiredOut: true } }).expect(201);
    expect((await b.owner.agent.get(`/api/orgs/${b.orgId}/mailbox-templates`).expect(200)).body.data).toEqual([]);
    await b.owner.agent.get(`/api/orgs/${a.orgId}/mailbox-templates`).expect(404);
    await b.owner.agent.patch(`/api/orgs/${b.orgId}/mailbox-templates/${template.body.id}`).send({ name: 'Mine' }).expect(404);
    await b.owner.agent.delete(`/api/orgs/${b.orgId}/mailbox-templates/${template.body.id}`).expect(404);
    // Nor use it for their own mailboxes.
    await b.owner.agent
      .post(`/api/orgs/${b.orgId}/mailboxes`)
      .send({ domainId: b.domainId, localPart: 'stolen', password: PASSWORD, templateId: template.body.id })
      .expect(422);
    await a.agent.get(`/api/orgs/${a.orgId}/mailbox-templates`).expect(403);
    await a.owner.agent.delete(`/api/orgs/${a.orgId}/mailbox-templates/${template.body.id}`).expect(204);
  });

  it('works without any template', async () => {
    const owner = await signUp(app, 'tpl-none');
    const orgId = await createOrg(owner, 'tpl-none');
    const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `none-${Date.now()}.example` }).expect(201);
    expect(domain.body.limits.maxMailboxes).toBeNull();
  });
});
