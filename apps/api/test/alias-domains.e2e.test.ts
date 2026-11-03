import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { createOrg, signUp, startApp, type TestUser } from './helpers.js';

describe('Alias domains', () => {
  let app: INestApplication;
  let db: Database;
  let alice: TestUser;
  let bob: TestUser;
  let orgA: string;
  let orgB: string;
  let main: { id: string; name: string };
  let alias: { id: string; name: string };
  let foreign: { id: string; name: string };

  const domains = (orgId: string) => `/api/orgs/${orgId}/domains`;
  const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows;

  async function domain(owner: TestUser, orgId: string, prefix: string, extra: Record<string, unknown> = {}) {
    const name = `${prefix}-${Date.now()}.example`;
    const created = await owner.agent.post(domains(orgId)).send({ name, ...extra }).expect(201);
    await owner.agent.post(`${domains(orgId)}/${created.body.id}/verify`).expect(200);
    return { id: created.body.id as string, name };
  }

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    alice = await signUp(app, 'ad-alice');
    bob = await signUp(app, 'ad-bob');
    orgA = await createOrg(alice, 'AliasDomA');
    orgB = await createOrg(bob, 'AliasDomB');
    main = await domain(alice, orgA, 'ad-main');
    foreign = await domain(bob, orgB, 'ad-foreign');
    await alice.agent
      .post(`/api/orgs/${orgA}/mailboxes`)
      .send({ domainId: main.id, localPart: 'ann', password: 'a long mailbox password' })
      .expect(201);
    await alice.agent
      .post(`/api/orgs/${orgA}/aliases`)
      .send({ domainId: main.id, localPart: 'team', destinations: [`ann@${main.name}`] })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates an alias domain of a domain of the organization', async () => {
    alias = await domain(alice, orgA, 'ad-alias', { aliasOf: main.id });
    const res = await alice.agent.get(`${domains(orgA)}/${alias.id}`).expect(200);
    expect(res.body).toMatchObject({ aliasOfDomainId: main.id, status: 'active' });
  });

  it('repeats every address of the target domain for Postfix', async () => {
    const target = async (address: string) =>
      (await rows(sql`SELECT destination FROM mail.aliases WHERE address = ${address}`)).map((r) => r.destination);
    expect(await target(`ann@${alias.name}`)).toEqual([`ann@${main.name}`]);
    expect(await target(`team@${alias.name}`)).toEqual([`ann@${main.name}`]);
    expect(await target(`nobody@${alias.name}`)).toEqual([]);
    const senders = await rows(sql`SELECT sender FROM mail.sender_logins WHERE login = ${`ann@${main.name}`} ORDER BY sender`);
    expect(senders.map((r) => r.sender)).toEqual(
      expect.arrayContaining([`ann@${alias.name}`, `team@${alias.name}`, `ann@${main.name}`, `team@${main.name}`]),
    );
  });

  it('has no mailboxes or aliases of its own', async () => {
    const mailbox = await alice.agent
      .post(`/api/orgs/${orgA}/mailboxes`)
      .send({ domainId: alias.id, localPart: 'own', password: 'a long mailbox password' })
      .expect(422);
    expect(mailbox.body.code).toBe('ALIAS_DOMAIN');
    await alice.agent
      .post(`/api/orgs/${orgA}/aliases`)
      .send({ domainId: alias.id, localPart: 'own', destinations: [`ann@${main.name}`] })
      .expect(422);
  });

  it('cannot alias an alias domain', async () => {
    const res = await alice.agent
      .post(domains(orgA))
      .send({ name: `ad-chain-${Date.now()}.example`, aliasOf: alias.id })
      .expect(422);
    expect(res.body.code).toBe('ALIAS_OF_ALIAS_DOMAIN');
  });

  it('stops when the alias domain is disabled', async () => {
    await alice.agent.patch(`${domains(orgA)}/${alias.id}`).send({ enabled: false }).expect(200);
    expect(await rows(sql`SELECT 1 FROM mail.aliases WHERE address = ${`ann@${alias.name}`}`)).toHaveLength(0);
    await alice.agent.patch(`${domains(orgA)}/${alias.id}`).send({ enabled: true }).expect(200);
  });

  it('keeps the target domain while alias domains point at it', async () => {
    const res = await alice.agent.delete(`${domains(orgA)}/${main.id}`).expect(409);
    expect(res.body.message).toMatch(/alias domains/);
  });

  describe('isolation between organizations', () => {
    it("cannot make an alias domain of another organization's domain", async () => {
      await alice.agent
        .post(domains(orgA))
        .send({ name: `ad-steal-${Date.now()}.example`, aliasOf: foreign.id })
        .expect(422);
      await bob.agent
        .post(domains(orgB))
        .send({ name: `ad-steal2-${Date.now()}.example`, aliasOf: main.id })
        .expect(422);
    });
  });
});
