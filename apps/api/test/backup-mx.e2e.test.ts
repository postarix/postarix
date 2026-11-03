import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('Backup MX domains and MTA-STS per domain', () => {
  let app: INestApplication;
  let db: Database;
  let root: TestAgent;
  let org: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let other: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows;
  const newDomain = async (o: typeof org, label: string) => {
    const name = `${label}-${Date.now()}.example`;
    const res = await o.owner.agent.post(`/api/orgs/${o.orgId}/domains`).send({ name }).expect(201);
    await o.owner.agent.post(`/api/orgs/${o.orgId}/domains/${res.body.id}/verify`).expect(200);
    return { id: res.body.id as string, name };
  };

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    const email = `bmx-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    org = await mailboxInNewOrg(app, 'bmx-a');
    other = await mailboxInNewOrg(app, 'bmx-b');
  });

  afterAll(async () => {
    await app.close();
  });

  it('relays a domain hosted elsewhere, set by instance administrators only', async () => {
    const domain = await newDomain(org, 'backup');
    await org.owner.agent.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ backupMx: true }).expect(403);
    const res = await root
      .patch(`/api/orgs/${org.orgId}/domains/${domain.id}`)
      .send({ backupMx: true, backupMxNexthop: '[MX.Primary.example]:25' })
      .expect(200);
    expect(res.body.backupMx).toEqual({ enabled: true, nexthop: '[mx.primary.example]:25' });
    await root.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ backupMxNexthop: 'not a host!' }).expect(400);

    expect(await rows(sql`SELECT 1 FROM mail.domains WHERE name = ${domain.name}`)).toEqual([]);
    expect(await rows(sql`SELECT nexthop FROM mail.backup_mx_domains WHERE name = ${domain.name}`)).toEqual([{ nexthop: '[mx.primary.example]:25' }]);
    expect(await rows(sql`SELECT transport FROM mail.transport_routes WHERE destination = ${domain.name}`)).toEqual([
      { transport: 'relay:[mx.primary.example]:25' },
    ]);

    // No mailboxes, aliases or alias domains on it.
    await org.owner.agent.post(`/api/orgs/${org.orgId}/mailboxes`).send({ domainId: domain.id, localPart: 'x', password: PASSWORD }).expect(422);
    await org.owner.agent.post(`/api/orgs/${org.orgId}/aliases`).send({ domainId: domain.id, localPart: 'x', destinations: [org.address] }).expect(422);
    await org.owner.agent.post(`/api/orgs/${org.orgId}/domains`).send({ name: `alias-${domain.name}`, aliasOf: domain.id }).expect(422);
    await org.owner.agent.post(`/api/orgs/${org.orgId}/bcc-rules`).send({ address: `@${domain.name}`, direction: 'recipient', destination: org.address }).expect(422);

    // Only a less preferred MX record to publish, and no MTA-STS or autoconfig of its own.
    const dns = await org.owner.agent.get(`/api/orgs/${org.orgId}/domains/${domain.id}/dns-records`).expect(200);
    expect(dns.body.data.map((r: { purpose: string; value: string }) => [r.purpose, r.value.split(' ')[0]])).toEqual([['mx', '20']]);
    await request(app.getHttpServer()).get('/.well-known/mta-sts.txt').set('host', `mta-sts.${domain.name}`).expect(404);

    // Back to a normal domain.
    await root.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ backupMx: false, backupMxNexthop: null }).expect(200);
    expect(await rows(sql`SELECT 1 AS ok FROM mail.domains WHERE name = ${domain.name}`)).toEqual([{ ok: 1 }]);
    expect(await rows(sql`SELECT 1 FROM mail.backup_mx_domains WHERE name = ${domain.name}`)).toEqual([]);
  });

  it('refuses to turn a domain with mailboxes into a backup MX', async () => {
    await root.patch(`/api/orgs/${org.orgId}/domains/${org.domainId}`).send({ backupMx: true }).expect(409);
  });

  it('lets organization admins choose the domain’s MTA-STS mode', async () => {
    const domain = await newDomain(org, 'sts');
    const before = await org.owner.agent.get(`/api/orgs/${org.orgId}/domains/${domain.id}/dns-records`).expect(200);
    const id = (body: { data: { purpose: string; value: string }[] }) => body.data.find((r) => r.purpose === 'mta-sts-id')!.value;

    const res = await org.owner.agent.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ mtaStsMode: 'enforce' }).expect(200);
    expect(res.body.mtaStsMode).toBe('enforce');
    const policy = await request(app.getHttpServer()).get('/.well-known/mta-sts.txt').set('host', `mta-sts.${domain.name}`).expect(200);
    expect(policy.text).toContain('mode: enforce');
    const after = await org.owner.agent.get(`/api/orgs/${org.orgId}/domains/${domain.id}/dns-records`).expect(200);
    // The DNS id changes with the policy, so other servers fetch it again.
    expect(id(after.body)).not.toBe(id(before.body));

    await org.owner.agent.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ mtaStsMode: 'sometimes' }).expect(400);
    // Another organization cannot change it.
    await other.owner.agent.patch(`/api/orgs/${other.orgId}/domains/${domain.id}`).send({ mtaStsMode: 'none' }).expect(404);
    await other.owner.agent.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ mtaStsMode: 'none' }).expect(404);
    await org.owner.agent.patch(`/api/orgs/${org.orgId}/domains/${domain.id}`).send({ mtaStsMode: null }).expect(200);
    const reset = await request(app.getHttpServer()).get('/.well-known/mta-sts.txt').set('host', `mta-sts.${domain.name}`).expect(200);
    expect(reset.text).toContain('mode: testing');
  });
});
