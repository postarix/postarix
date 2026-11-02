import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { and, eq, isNull } from 'drizzle-orm';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE, DKIM_PUBLISHER, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { auditEvents, organization, user } from '../src/db/schema/index.js';
import type { MemoryDkimPublisher } from '../src/dkim/dkim-publisher.js';
import { authOf, createOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

describe('Deleting an organization', () => {
  let app: INestApplication;
  let db: Database;
  let engine: MemoryMailEngine;
  let publisher: MemoryDkimPublisher;
  let alice: TestUser; // owner of the organization being deleted
  let bob: TestUser; // owner of an unrelated organization
  let root: TestAgent;
  let orgA: string;
  let orgB: string;
  let domainA: { id: string; name: string };
  let domainB: { id: string; name: string };

  const provision = async (agent: TestAgent, orgId: string, prefix: string) => {
    const name = `${prefix}-${Date.now()}.example`;
    const domain = await agent.post(`/api/orgs/${orgId}/domains`).send({ name }).expect(201);
    await agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
    await agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId: domain.body.id, localPart: 'info', password: 'a long mailbox password' })
      .expect(201);
    await agent
      .post(`/api/orgs/${orgId}/aliases`)
      .send({ domainId: domain.body.id, localPart: 'sales', destinations: [`info@${name}`] })
      .expect(201);
    return { id: domain.body.id as string, name };
  };

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    publisher = app.get<MemoryDkimPublisher>(DKIM_PUBLISHER);
    alice = await signUp(app, 'del-alice');
    bob = await signUp(app, 'del-bob');
    orgA = await createOrg(alice, 'Doomed');
    orgB = await createOrg(bob, 'Survivor');
    domainA = await provision(alice.agent, orgA, 'doomed');
    domainB = await provision(bob.agent, orgB, 'survivor');
    const email = `del-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is hidden from everyone but instance administrators, owners included', async () => {
    await alice.agent.delete(`/api/admin/organizations/${orgA}`).send({ confirm: 'Doomed' }).expect(404);
    await bob.agent.delete(`/api/admin/organizations/${orgA}`).send({ confirm: 'Doomed' }).expect(404);
    await alice.agent.get(`/api/orgs/${orgA}/overview`).expect(200);
  });

  it('requires the exact organization name', async () => {
    await root.delete(`/api/admin/organizations/${orgA}`).send({ confirm: 'doomed' }).expect(400);
    await root.delete(`/api/admin/organizations/${orgA}`).send({}).expect(400);
    await root.delete(`/api/admin/organizations/no-such-org`).send({ confirm: 'Doomed' }).expect(404);
    expect(engine.mailboxes.has(`info@${domainA.name}`)).toBe(true);
  });

  it('never deletes an instance administrator’s account along with the organization', async () => {
    await db.update(user).set({ role: 'admin' }).where(eq(user.email, `info@${domainA.name}`));
    const res = await root.delete(`/api/admin/organizations/${orgA}`).send({ confirm: 'Doomed' }).expect(409);
    expect(res.body.message).toContain(`info@${domainA.name}`);
    expect(engine.mailboxes.has(`info@${domainA.name}`)).toBe(true);
    await alice.agent.get(`/api/orgs/${orgA}/overview`).expect(200);
    await db.update(user).set({ role: 'user' }).where(eq(user.email, `info@${domainA.name}`));
  });

  it('removes mailboxes, accounts, aliases, domains and DKIM keys, and nothing of other organizations', async () => {
    const res = await root.delete(`/api/admin/organizations/${orgA}`).send({ confirm: 'Doomed' }).expect(200);
    expect(res.body).toEqual({ aliases: 1, mailboxes: 1, domains: 1 });

    expect(engine.mailboxes.has(`info@${domainA.name}`)).toBe(false);
    expect(publisher.selectors.has(domainA.name)).toBe(false);
    const accounts = await db.select().from(user).where(eq(user.email, `info@${domainA.name}`));
    expect(accounts).toHaveLength(0);
    expect(await db.select().from(organization).where(eq(organization.id, orgA))).toHaveLength(0);
    await alice.agent.get(`/api/orgs/${orgA}/overview`).expect(404);

    // The other organization is untouched.
    expect(engine.mailboxes.has(`info@${domainB.name}`)).toBe(true);
    expect(publisher.selectors.has(domainB.name)).toBe(true);
    const survivors = await bob.agent.get(`/api/orgs/${orgB}/aliases`).expect(200);
    expect(survivors.body.data).toHaveLength(1);
  });

  it('leaves an instance-level audit record', async () => {
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(isNull(auditEvents.organizationId), eq(auditEvents.action, 'organization.deleted'), eq(auditEvents.targetId, orgA)));
    expect(event).toMatchObject({ targetLabel: 'Doomed', details: { aliases: 1, mailboxes: 1, domains: 1 } });
  });
});
