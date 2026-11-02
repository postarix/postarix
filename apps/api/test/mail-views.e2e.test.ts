import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE, DNS_RESOLVER } from '../src/core/tokens.js';
import type { DnsResolver } from '../src/core/dns.js';
import type { Database } from '../src/db/client.js';
import { createOrg, signUp, startApp, type TestUser } from './helpers.js';

// What Postfix will see: the read-only views in the "mail" schema.
describe('Postfix views', () => {
  let app: INestApplication;
  let db: Database;
  let admin: TestUser;
  let orgId: string;
  let active: { id: string; name: string };
  let pending: { id: string; name: string };

  const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows;

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    admin = await signUp(app, 'views-admin');
    orgId = await createOrg(admin, 'Views');
    const a = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `views-${Date.now()}.example` });
    await admin.agent.post(`/api/orgs/${orgId}/domains/${a.body.id}/verify`).expect(200);
    active = { id: a.body.id, name: a.body.name };
    const p = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `views-p-${Date.now()}.example` });
    pending = { id: p.body.id, name: p.body.name };

    await admin.agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId: active.id, localPart: 'ann', password: 'a long mailbox password' })
      .expect(201);
    const off = await admin.agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId: active.id, localPart: 'off', password: 'a long mailbox password' })
      .expect(201);
    await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${off.body.id}`).send({ status: 'disabled' });
    await admin.agent
      .post(`/api/orgs/${orgId}/aliases`)
      .send({
        domainId: active.id,
        localPart: 'team',
        destinations: [`ann@${active.name}`, 'outside@external.example'],
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists only active domains', async () => {
    const names = (await rows(sql`SELECT name FROM mail.domains`)).map((r) => r.name);
    expect(names).toContain(active.name);
    expect(names).not.toContain(pending.name);
  });

  it('lists only enabled mailboxes', async () => {
    const addresses = (await rows(sql`SELECT address FROM mail.mailboxes`)).map((r) => r.address);
    expect(addresses).toContain(`ann@${active.name}`);
    expect(addresses).not.toContain(`off@${active.name}`);
  });

  it('expands aliases to one row per destination', async () => {
    const result = await rows(
      sql`SELECT destination FROM mail.aliases WHERE address = ${`team@${active.name}`} ORDER BY destination`,
    );
    expect(result.map((r) => r.destination)).toEqual([`ann@${active.name}`, 'outside@external.example']);
  });

  it('lets a mailbox send as itself and as aliases that deliver to it', async () => {
    const logins = async (sender: string) =>
      (await rows(sql`SELECT login FROM mail.sender_logins WHERE sender = ${sender}`)).map((r) => r.login);
    expect(await logins(`ann@${active.name}`)).toEqual([`ann@${active.name}`]);
    expect(await logins(`team@${active.name}`)).toEqual([`ann@${active.name}`]);
    expect(await logins('outside@external.example')).toEqual([]);
  });

  it('does not grant send-as through an alias owned by another organization', async () => {
    const other = await signUp(app, 'views-other');
    const otherOrg = await createOrg(other, 'Views other');
    const d = await other.agent.post(`/api/orgs/${otherOrg}/domains`).send({ name: `views-o-${Date.now()}.example` });
    await other.agent.post(`/api/orgs/${otherOrg}/domains/${d.body.id}/verify`).expect(200);
    await other.agent
      .post(`/api/orgs/${otherOrg}/aliases`)
      .send({ domainId: d.body.id, localPart: 'ceo', destinations: [`ann@${active.name}`] })
      .expect(201);

    // Mail to ceo@ still reaches ann (forwarding works) ...
    const forwarded = await rows(sql`SELECT destination FROM mail.aliases WHERE address = ${`ceo@${d.body.name}`}`);
    expect(forwarded.map((r) => r.destination)).toEqual([`ann@${active.name}`]);
    // ... but ann may not send as ceo@, an address of another organization.
    const logins = await rows(sql`SELECT login FROM mail.sender_logins WHERE sender = ${`ceo@${d.body.name}`}`);
    expect(logins).toEqual([]);
  });
});

describe('DNS domain verification', () => {
  let app: INestApplication;
  let admin: TestUser;
  let orgId: string;
  const saved = process.env.DOMAIN_VERIFICATION;
  let txt: string[][] = [];

  beforeAll(async () => {
    process.env.DOMAIN_VERIFICATION = 'dns';
    app = await startApp();
    const resolver = app.get<DnsResolver>(DNS_RESOLVER);
    resolver.resolveTxt = async () => {
      if (txt.length === 0) throw Object.assign(new Error('no data'), { code: 'ENODATA' });
      return txt;
    };
    admin = await signUp(app, 'dns-admin');
    orgId = await createOrg(admin, 'Dns');
  });

  afterAll(async () => {
    await app.close();
    process.env.DOMAIN_VERIFICATION = saved;
  });

  it('activates only once the TXT record is published', async () => {
    const created = await admin.agent
      .post(`/api/orgs/${orgId}/domains`)
      .send({ name: `dns-${Date.now()}.example` })
      .expect(201);
    const verifyUrl = `/api/orgs/${orgId}/domains/${created.body.id}/verify`;

    const missing = await admin.agent.post(verifyUrl).expect(422);
    expect(missing.body.code).toBe('VERIFICATION_RECORD_MISSING');

    txt = [['v=spf1 -all'], ['postarix-verification=wrong']];
    await admin.agent.post(verifyUrl).expect(422);

    // Long TXT values arrive split into chunks.
    const record = created.body.verificationRecord as string;
    txt = [['v=spf1 -all'], [record.slice(0, 20), record.slice(20)]];
    const verified = await admin.agent.post(verifyUrl).expect(200);
    expect(verified.body.status).toBe('active');
    expect(verified.body.verifiedAt).not.toBeNull();
  });

  it('does not let a second organization activate a name that is already active', async () => {
    const name = `dup-${Date.now()}.example`;
    const first = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name }).expect(201);
    txt = [[first.body.verificationRecord]];
    await admin.agent.post(`/api/orgs/${orgId}/domains/${first.body.id}/verify`).expect(200);

    const other = await signUp(app, 'dns-other');
    const otherOrg = await createOrg(other, 'DnsOther');
    const second = await other.agent.post(`/api/orgs/${otherOrg}/domains`).send({ name }).expect(201);
    txt = [[second.body.verificationRecord]];
    await other.agent.post(`/api/orgs/${otherOrg}/domains/${second.body.id}/verify`).expect(409);
  });

  it('reports resolver failures as temporary', async () => {
    const created = await admin.agent
      .post(`/api/orgs/${orgId}/domains`)
      .send({ name: `fail-${Date.now()}.example` })
      .expect(201);
    const resolver = app.get<DnsResolver>(DNS_RESOLVER);
    const original = resolver.resolveTxt;
    resolver.resolveTxt = async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    };
    await admin.agent.post(`/api/orgs/${orgId}/domains/${created.body.id}/verify`).expect(503);
    resolver.resolveTxt = original;
  });

  it('checks the published records live, for members of the organization only', async () => {
    const created = await admin.agent
      .post(`/api/orgs/${orgId}/domains`)
      .send({ name: `check-${Date.now()}.example` })
      .expect(201);
    const name = created.body.name as string;
    const resolver = app.get<DnsResolver>(DNS_RESOLVER);
    const original = { txt: resolver.resolveTxt, mx: resolver.resolveMx };
    resolver.resolveTxt = async (host) => {
      if (host === name) return [[created.body.verificationRecord], ['v=spf1 mx -all']];
      throw Object.assign(new Error('no data'), { code: 'ENODATA' });
    };
    resolver.resolveMx = async () => [{ exchange: 'elsewhere.example.org', priority: 10 }];
    try {
      const res = await admin.agent.get(`/api/orgs/${orgId}/domains/${created.body.id}/dns-check`).expect(200);
      const byPurpose = Object.fromEntries(
        (res.body.data as { purpose: string; status: string }[]).map((r) => [r.purpose, r.status]),
      );
      expect(byPurpose).toMatchObject({ verification: 'ok', spf: 'ok', mx: 'mismatch', dmarc: 'missing' });

      const outsider = await signUp(app, 'dns-outsider');
      const outsiderOrg = await createOrg(outsider, 'DnsOutsider');
      await outsider.agent.get(`/api/orgs/${orgId}/domains/${created.body.id}/dns-check`).expect(404);
      await outsider.agent.get(`/api/orgs/${outsiderOrg}/domains/${created.body.id}/dns-check`).expect(404);
    } finally {
      resolver.resolveTxt = original.txt;
      resolver.resolveMx = original.mx;
    }
  });
});
