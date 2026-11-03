import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('BCC rules and recipient maps', () => {
  let app: INestApplication;
  let db: Database;
  let root: TestAgent;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows;

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    const email = `rules-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    a = await mailboxInNewOrg(app, 'bcc-a');
    b = await mailboxInNewOrg(app, 'bcc-b');
  });

  afterAll(async () => {
    await app.close();
  });

  it('copies mail of an address or a whole domain, also on its alias domains', async () => {
    const rule = await a.owner.agent
      .post(`/api/orgs/${a.orgId}/bcc-rules`)
      .send({ address: a.address.toUpperCase(), direction: 'recipient', destination: 'Audit@Elsewhere.example' })
      .expect(201);
    expect(rule.body).toMatchObject({ address: a.address, direction: 'recipient', destination: 'audit@elsewhere.example', enabled: true, domainId: a.domainId });
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: `*@${a.domainName}`, direction: 'sender', destination: 'sent@elsewhere.example' }).expect(201);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: a.address, direction: 'recipient', destination: 'audit@elsewhere.example' }).expect(409);

    expect(await rows(sql`SELECT direction, destination FROM mail.bcc_targets WHERE address IN (${a.address}, ${`@${a.domainName}`}) ORDER BY direction`)).toEqual([
      { direction: 'recipient', destination: 'audit@elsewhere.example' },
      { direction: 'sender', destination: 'sent@elsewhere.example' },
    ]);

    // An alias domain repeats the rules.
    const alias = await a.owner.agent.post(`/api/orgs/${a.orgId}/domains`).send({ name: `alias-${a.domainName}`, aliasOf: a.domainId }).expect(201);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/domains/${alias.body.id}/verify`).expect(200);
    const local = a.address.split('@')[0];
    expect(await rows(sql`SELECT destination FROM mail.bcc_targets WHERE address = ${`${local}@alias-${a.domainName}`}`)).toEqual([
      { destination: 'audit@elsewhere.example' },
    ]);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: `@alias-${a.domainName}`, direction: 'sender', destination: 'x@elsewhere.example' }).expect(422);

    // Disabled: no copies.
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/bcc-rules/${rule.body.id}`).send({ enabled: false }).expect(200);
    expect(await rows(sql`SELECT 1 FROM mail.bcc_targets WHERE address = ${a.address} AND direction = 'recipient'`)).toEqual([]);
  });

  it('refuses addresses outside the organization and copies to the same address', async () => {
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: 'someone@gmail.example', direction: 'recipient', destination: 'x@elsewhere.example' }).expect(422);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: a.address, direction: 'sender', destination: a.address }).expect(422);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: 'not an address', direction: 'sender', destination: 'x@elsewhere.example' }).expect(400);
    await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: a.address, direction: 'both', destination: 'x@elsewhere.example' }).expect(400);
    // Members who are not administrators cannot see them.
    await a.agent.get(`/api/orgs/${a.orgId}/bcc-rules`).expect(403);
  });

  it('keeps each organization’s rules to itself', async () => {
    const rule = await a.owner.agent.post(`/api/orgs/${a.orgId}/bcc-rules`).send({ address: a.address, direction: 'sender', destination: 'iso@elsewhere.example' }).expect(201);
    // B cannot copy A's mail, nor see, change or remove A's rules.
    await b.owner.agent.post(`/api/orgs/${b.orgId}/bcc-rules`).send({ address: a.address, direction: 'recipient', destination: 'spy@elsewhere.example' }).expect(422);
    await b.owner.agent.post(`/api/orgs/${b.orgId}/bcc-rules`).send({ address: `@${a.domainName}`, direction: 'recipient', destination: 'spy@elsewhere.example' }).expect(422);
    expect((await b.owner.agent.get(`/api/orgs/${b.orgId}/bcc-rules`).expect(200)).body.data).toEqual([]);
    await b.owner.agent.get(`/api/orgs/${a.orgId}/bcc-rules`).expect(404);
    await b.owner.agent.patch(`/api/orgs/${b.orgId}/bcc-rules/${rule.body.id}`).send({ enabled: false }).expect(404);
    await b.owner.agent.delete(`/api/orgs/${b.orgId}/bcc-rules/${rule.body.id}`).expect(404);
    await b.owner.agent.delete(`/api/orgs/${a.orgId}/bcc-rules/${rule.body.id}`).expect(404);
    const list = await a.owner.agent.get(`/api/orgs/${a.orgId}/bcc-rules`).expect(200);
    expect(list.body.data.find((r: { id: string }) => r.id === rule.body.id).enabled).toBe(true);
    await a.owner.agent.delete(`/api/orgs/${a.orgId}/bcc-rules/${rule.body.id}`).expect(204);
  });

  it('lets instance administrators rewrite recipients, without chains', async () => {
    await a.owner.agent.get('/api/system/recipient-maps').expect(404);
    const created = await root.post('/api/system/recipient-maps').send({ address: 'Old@Partner.example', destination: 'new@partner.example' }).expect(201);
    expect(created.body).toMatchObject({ address: 'old@partner.example', destination: 'new@partner.example', enabled: true });
    expect(await rows(sql`SELECT destination FROM mail.recipient_maps WHERE address = 'old@partner.example'`)).toEqual([{ destination: 'new@partner.example' }]);
    await root.post('/api/system/recipient-maps').send({ address: 'old@partner.example', destination: 'other@partner.example' }).expect(409);
    // Chains and loops are refused.
    await root.post('/api/system/recipient-maps').send({ address: 'new@partner.example', destination: 'old@partner.example' }).expect(422);
    await root.post('/api/system/recipient-maps').send({ address: 'older@partner.example', destination: 'old@partner.example' }).expect(422);
    await root.post('/api/system/recipient-maps').send({ address: 'x@partner.example', destination: 'x@partner.example' }).expect(422);
    const domainWide = await root.post('/api/system/recipient-maps').send({ address: '@gone.example', destination: 'catch@partner.example' }).expect(201);

    await root.patch(`/api/system/recipient-maps/${created.body.id}`).send({ enabled: false }).expect(200);
    expect(await rows(sql`SELECT 1 FROM mail.recipient_maps WHERE address = 'old@partner.example'`)).toEqual([]);
    await root.delete(`/api/system/recipient-maps/${created.body.id}`).expect(204);
    await root.delete(`/api/system/recipient-maps/${domainWide.body.id}`).expect(204);
    await root.delete(`/api/system/recipient-maps/${created.body.id}`).expect(404);
  });
});
