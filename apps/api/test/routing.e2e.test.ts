import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('Outgoing routing (smart hosts, routes, TLS policies)', () => {
  let app: INestApplication;
  let db: Database;
  let root: TestAgent;
  let org: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let other: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let relayId: string;

  const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows;

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    const email = `route-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    org = await mailboxInNewOrg(app, 'route-a');
    other = await mailboxInNewOrg(app, 'route-b');
  });

  afterAll(async () => {
    await app.close();
  });

  it('manages smart hosts without ever showing their passwords', async () => {
    const created = await root
      .post('/api/system/relay-hosts')
      .send({ host: '[SMTP.Relay.example]:587', username: 'apikey', password: 's3cret:with:colons' })
      .expect(201);
    relayId = created.body.id;
    expect(created.body).toMatchObject({ host: '[smtp.relay.example]:587', username: 'apikey', hasPassword: true, enabled: true });
    expect(JSON.stringify(created.body)).not.toContain('s3cret');
    const list = await root.get('/api/system/relay-hosts').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('s3cret');
    await root.post('/api/system/relay-hosts').send({ host: 'not a host!' }).expect(400);
    await root.post('/api/system/relay-hosts').send({ host: 'smtp.example', username: 'a:b' }).expect(400);
    expect(await rows(sql`SELECT credentials FROM mail.smtp_credentials WHERE nexthop = '[smtp.relay.example]:587'`)).toEqual([
      { credentials: 'apikey:s3cret:with:colons' },
    ]);
  });

  it('lets only instance administrators send a domain or a mailbox through a smart host', async () => {
    await org.owner.agent.patch(`/api/orgs/${org.orgId}/domains/${org.domainId}`).send({ relayHostId: relayId }).expect(403);
    const domain = await root.patch(`/api/orgs/${org.orgId}/domains/${org.domainId}`).send({ relayHostId: relayId }).expect(200);
    expect(domain.body.relayHostId).toBe(relayId);
    expect(await rows(sql`SELECT relayhost FROM mail.relayhost_by_sender WHERE sender = ${`@${org.domainName}`}`)).toEqual([
      { relayhost: '[smtp.relay.example]:587' },
    ]);

    const mailboxes = await root.get(`/api/orgs/${org.orgId}/mailboxes`).expect(200);
    const id = mailboxes.body.data[0].id as string;
    await org.owner.agent.patch(`/api/orgs/${org.orgId}/mailboxes/${id}`).send({ relayHostId: null }).expect(403);
    await root.patch(`/api/orgs/${org.orgId}/mailboxes/${id}`).send({ relayHostId: relayId }).expect(200);
    expect(await rows(sql`SELECT relayhost FROM mail.relayhost_by_sender WHERE sender = ${org.address}`)).toHaveLength(1);
    await root
      .patch(`/api/orgs/${org.orgId}/mailboxes/${id}`)
      .send({ relayHostId: '00000000-0000-4000-8000-000000000000' })
      .expect(422);

    // A disabled smart host is not used.
    await root.patch(`/api/system/relay-hosts/${relayId}`).send({ enabled: false }).expect(200);
    expect(await rows(sql`SELECT 1 FROM mail.relayhost_by_sender WHERE sender = ${org.address}`)).toHaveLength(0);
    // Deleting it leaves the domain on direct delivery.
    await root.delete(`/api/system/relay-hosts/${relayId}`).expect(204);
    const after = await root.get(`/api/orgs/${org.orgId}/domains/${org.domainId}`).expect(200);
    expect(after.body.relayHostId).toBeNull();
  });

  it('routes outside destinations, never hosted domains', async () => {
    const route = await root
      .post('/api/system/transports')
      .send({ destination: 'Partner.Example', nexthop: '[mx.partner.example]:2525', username: 'u', password: 'p' })
      .expect(201);
    expect(route.body).toMatchObject({ destination: 'partner.example', nexthop: '[mx.partner.example]:2525', hasPassword: true });
    expect(await rows(sql`SELECT transport FROM mail.transport_routes WHERE destination = 'partner.example'`)).toEqual([
      { transport: 'smtp:[mx.partner.example]:2525' },
    ]);
    await root.post('/api/system/transports').send({ destination: 'partner.example', nexthop: 'other.example' }).expect(409);
    const hosted = await root.post('/api/system/transports').send({ destination: other.domainName, nexthop: 'x.example' }).expect(422);
    expect(hosted.body.code).toBe('DESTINATION_HOSTED');
    await root.post('/api/system/transports').send({ destination: `ann@${other.domainName}`, nexthop: 'x.example' }).expect(422);
    await root.delete(`/api/system/transports/${route.body.id}`).expect(204);
  });

  it('sets TLS policies per destination', async () => {
    const policy = await root
      .post('/api/system/tls-policies')
      .send({ destination: 'bank.example', policy: 'secure', parameters: 'match=.bank.example protocols=>=TLSv1.2' })
      .expect(201);
    expect(await rows(sql`SELECT policy FROM mail.tls_policies WHERE destination = 'bank.example'`)).toEqual([
      { policy: 'secure match=.bank.example protocols=>=TLSv1.2' },
    ]);
    await root.post('/api/system/tls-policies').send({ destination: 'x.example', policy: 'paranoid' }).expect(400);
    await root.post('/api/system/tls-policies').send({ destination: 'x.example', policy: 'may', parameters: 'a b' }).expect(400);
    await root.patch(`/api/system/tls-policies/${policy.body.id}`).send({ enabled: false }).expect(200);
    expect(await rows(sql`SELECT 1 FROM mail.tls_policies WHERE destination = 'bank.example'`)).toHaveLength(0);
  });

  it('is for instance administrators only', async () => {
    for (const path of ['relay-hosts', 'transports', 'tls-policies']) {
      await org.owner.agent.get(`/api/system/${path}`).expect(404);
      await org.owner.agent.post(`/api/system/${path}`).send({}).expect(404);
    }
  });
});
