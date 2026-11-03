import type { INestApplication } from '@nestjs/common';
import { MailEngineError, type MemoryMailEngine } from '@postarix/mail-engine';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE, MAIL_ENGINE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { user } from '../src/db/schema/index.js';
import { addMember, createOrg, newAgent, signUp, startApp, type TestUser } from './helpers.js';

describe('Mailboxes and aliases API', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let alice: TestUser; // owner of org A
  let bob: TestUser; // owner of org B
  let carol: TestUser; // member of org A
  let orgA: string;
  let orgB: string;
  let domainA: { id: string; name: string };
  let pendingDomainA: string;
  let domainB: { id: string; name: string };

  const url = (orgId: string, resource: string) => `/api/orgs/${orgId}/${resource}`;

  async function activeDomain(owner: TestUser, orgId: string, name: string) {
    const created = await owner.agent.post(url(orgId, 'domains')).send({ name }).expect(201);
    const verified = await owner.agent
      .post(`${url(orgId, 'domains')}/${created.body.id}/verify`)
      .expect(200);
    expect(verified.body.status).toBe('active');
    return { id: created.body.id as string, name: created.body.name as string };
  }

  beforeAll(async () => {
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    alice = await signUp(app, 'mb-alice');
    bob = await signUp(app, 'mb-bob');
    carol = await signUp(app, 'mb-carol');
    orgA = await createOrg(alice, 'MailA');
    orgB = await createOrg(bob, 'MailB');
    await addMember(app, orgA, carol.id, 'member');
    domainA = await activeDomain(alice, orgA, `a-${Date.now()}.example`);
    domainB = await activeDomain(bob, orgB, `b-${Date.now()}.example`);
    const pending = await alice.agent
      .post(url(orgA, 'domains'))
      .send({ name: `pending-${Date.now()}.example` })
      .expect(201);
    pendingDomainA = pending.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const newMailbox = (localPart: string, extra: Record<string, unknown> = {}) => ({
    domainId: domainA.id,
    localPart,
    password: 'a long mailbox password',
    ...extra,
  });

  describe('mailboxes', () => {
    it('creates the account, the row and the engine mailbox', async () => {
      const res = await alice.agent
        .post(url(orgA, 'mailboxes'))
        .send(newMailbox('Info', { displayName: 'Info desk', quotaBytes: 50 * 1024 * 1024 }))
        .expect(201);
      expect(res.body).toMatchObject({
        address: `info@${domainA.name}`,
        localPart: 'info',
        displayName: 'Info desk',
        quotaBytes: 50 * 1024 * 1024,
        status: 'active',
      });
      expect(engine.mailboxes.get(`info@${domainA.name}`)).toEqual({
        quotaBytes: 50 * 1024 * 1024,
        usedBytes: 0,
      });

      // The mailbox owner can sign in to the web with the same credentials.
      const owner = newAgent(app);
      await owner
        .post('/api/auth/sign-in/email')
        .send({ email: `info@${domainA.name}`, password: 'a long mailbox password' })
        .expect(200);
    });

    it('refuses a pending domain, a foreign domain and invalid input', async () => {
      await alice.agent
        .post(url(orgA, 'mailboxes'))
        .send({ ...newMailbox('x'), domainId: pendingDomainA })
        .expect(422);
      // Another organization's domain is "unknown", not "forbidden".
      const foreign = await alice.agent
        .post(url(orgA, 'mailboxes'))
        .send({ ...newMailbox('x'), domainId: domainB.id })
        .expect(422);
      expect(foreign.body.code).toBe('UNKNOWN_DOMAIN');
      await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('a+b')).expect(400);
      await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('a/b')).expect(400);
      await alice.agent
        .post(url(orgA, 'mailboxes'))
        .send(newMailbox('short', { password: 'short' }))
        .expect(400);
      await alice.agent
        .post(url(orgA, 'mailboxes'))
        .send(newMailbox('tiny', { quotaBytes: 1000 }))
        .expect(400);
    });

    it('refuses an address already used by a mailbox', async () => {
      await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('info')).expect(409);
    });

    it('rolls everything back when the mail server fails', async () => {
      engine.failNext = new MailEngineError('down', 'unavailable');
      await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('rollback')).expect(503);

      const address = `rollback@${domainA.name}`;
      expect(engine.mailboxes.has(address)).toBe(false);
      const users = await app.get<Database>(DATABASE).select().from(user).where(eq(user.email, address));
      expect(users).toEqual([]);
      // And the address is free again.
      await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('rollback')).expect(201);
    });

    it('updates quota, name and status', async () => {
      const created = await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('quota')).expect(201);
      const res = await alice.agent
        .patch(`${url(orgA, 'mailboxes')}/${created.body.id}`)
        .send({ quotaBytes: 10 * 1024 * 1024, displayName: 'Quota', status: 'disabled' })
        .expect(200);
      expect(res.body).toMatchObject({ quotaBytes: 10 * 1024 * 1024, displayName: 'Quota', status: 'disabled' });
      expect(engine.mailboxes.get(`quota@${domainA.name}`)?.quotaBytes).toBe(10 * 1024 * 1024);

      const usage = await alice.agent.get(`${url(orgA, 'mailboxes')}/${created.body.id}/usage`).expect(200);
      expect(usage.body).toEqual({ usedBytes: 0, quotaBytes: 10 * 1024 * 1024 });
    });

    it('resets the password and signs the user out', async () => {
      const created = await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('reset')).expect(201);
      const owner = newAgent(app);
      await owner
        .post('/api/auth/sign-in/email')
        .send({ email: `reset@${domainA.name}`, password: 'a long mailbox password' })
        .expect(200);
      await owner.get('/api/me/app-passwords').expect(200);

      await alice.agent
        .post(`${url(orgA, 'mailboxes')}/${created.body.id}/password`)
        .send({ password: 'a brand new long password' })
        .expect(204);
      await owner.get('/api/me/app-passwords').expect(401);
    });

    it('deletes the engine mailbox, the row and the account', async () => {
      const created = await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('gone')).expect(201);
      await alice.agent.delete(`${url(orgA, 'mailboxes')}/${created.body.id}`).expect(204);
      expect(engine.mailboxes.has(`gone@${domainA.name}`)).toBe(false);
      await alice.agent.get(`${url(orgA, 'mailboxes')}/${created.body.id}`).expect(404);
      const users = await app
        .get<Database>(DATABASE)
        .select()
        .from(user)
        .where(eq(user.email, `gone@${domainA.name}`));
      expect(users).toEqual([]);
    });

    it('leaves accounts that administer the instance to instance administrators', async () => {
      const created = await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('chief')).expect(201);
      const db = app.get<Database>(DATABASE);
      await db.update(user).set({ role: 'admin' }).where(eq(user.email, `chief@${domainA.name}`));
      const path = `${url(orgA, 'mailboxes')}/${created.body.id}`;
      await alice.agent.post(`${path}/password`).send({ password: 'a takeover long password' }).expect(403);
      await alice.agent.delete(path).expect(403);
      await alice.agent.patch(path).send({ status: 'disabled' }).expect(403);
      await alice.agent.patch(path).send({ displayName: 'Not the chief' }).expect(403);
      expect(engine.mailboxes.has(`chief@${domainA.name}`)).toBe(true);
      await db.update(user).set({ role: 'user' }).where(eq(user.email, `chief@${domainA.name}`));
      await alice.agent.delete(path).expect(204);
    });

    it('blocks deleting a domain that still has mailboxes', async () => {
      await alice.agent.delete(`${url(orgA, 'domains')}/${domainA.id}`).expect(409);
    });

    it('is admin-only and isolated between organizations', async () => {
      const list = await alice.agent.get(url(orgA, 'mailboxes')).expect(200);
      const someId = list.body.data[0].id as string;

      await carol.agent.get(url(orgA, 'mailboxes')).expect(403);
      await carol.agent.post(url(orgA, 'mailboxes')).send(newMailbox('carol')).expect(403);

      await bob.agent.get(url(orgA, 'mailboxes')).expect(404);
      await bob.agent.get(`${url(orgB, 'mailboxes')}/${someId}`).expect(404);
      await bob.agent.patch(`${url(orgB, 'mailboxes')}/${someId}`).send({ displayName: 'x' }).expect(404);
      await bob.agent
        .post(`${url(orgB, 'mailboxes')}/${someId}/password`)
        .send({ password: 'a long hijacked password' })
        .expect(404);
      await bob.agent.delete(`${url(orgB, 'mailboxes')}/${someId}`).expect(404);
      const own = await bob.agent.get(url(orgB, 'mailboxes')).expect(200);
      expect(own.body.data.map((m: { id: string }) => m.id)).not.toContain(someId);

      await alice.agent.get(`${url(orgA, 'mailboxes')}/${someId}`).expect(200);
    });

    it("sets send-as addresses on the organization's own domains only", async () => {
      const list = await alice.agent.get(url(orgA, 'mailboxes')).expect(200);
      const id = list.body.data[0].id as string;
      const sendAs = `${url(orgA, 'mailboxes')}/${id}/send-as`;
      const res = await alice.agent
        .put(sendAs)
        .send({ senders: [`News@${domainA.name}`, `@${domainA.name}`, `news@${domainA.name}`] })
        .expect(200);
      expect(res.body.senders).toEqual([`@${domainA.name}`, `news@${domainA.name}`]);
      expect((await alice.agent.get(sendAs).expect(200)).body.senders).toHaveLength(2);

      const foreign = await alice.agent.put(sendAs).send({ senders: [`ceo@${domainB.name}`] }).expect(422);
      expect(foreign.body.code).toBe('SEND_AS_FOREIGN_DOMAIN');
      await alice.agent.put(sendAs).send({ senders: ['someone@external.example'] }).expect(422);
      await alice.agent.put(sendAs).send({ senders: ['not an address'] }).expect(400);

      // Isolation: another organization can neither read nor change it.
      await bob.agent.get(`${url(orgB, 'mailboxes')}/${id}/send-as`).expect(404);
      await bob.agent.put(`${url(orgB, 'mailboxes')}/${id}/send-as`).send({ senders: [] }).expect(404);
      await bob.agent.get(`${url(orgA, 'mailboxes')}/${id}/send-as`).expect(404);
      await carol.agent.put(sendAs).send({ senders: [] }).expect(403);
      expect((await alice.agent.get(sendAs).expect(200)).body.senders).toHaveLength(2);
      await alice.agent.put(sendAs).send({ senders: [] }).expect(200);
    });
  });

  describe('aliases', () => {
    it('creates an alias with normalized, de-duplicated destinations', async () => {
      const res = await alice.agent
        .post(url(orgA, 'aliases'))
        .send({
          domainId: domainA.id,
          localPart: 'sales',
          destinations: [`INFO@${domainA.name}`, `info@${domainA.name}`, 'Partner@External.example'],
        })
        .expect(201);
      expect(res.body).toMatchObject({
        address: `sales@${domainA.name}`,
        destinations: [`info@${domainA.name}`, 'partner@external.example'],
        enabled: true,
      });
    });

    it('rejects collisions, loops, bad destinations and foreign domains', async () => {
      const base = { domainId: domainA.id, destinations: ['x@external.example'] };
      await alice.agent.post(url(orgA, 'aliases')).send({ ...base, localPart: 'info' }).expect(409);
      await alice.agent.post(url(orgA, 'aliases')).send({ ...base, localPart: 'sales' }).expect(409);
      await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ ...base, localPart: 'loop', destinations: [`loop@${domainA.name}`] })
        .expect(400);
      await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ ...base, localPart: 'bad', destinations: ['a,b@example.com'] })
        .expect(400);
      await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ ...base, localPart: 'none', destinations: [] })
        .expect(400);
      await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ ...base, domainId: domainB.id, localPart: 'steal' })
        .expect(422);
    });

    it('creates one catch-all per domain, and discarding aliases', async () => {
      const catchAll = await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ domainId: domainA.id, localPart: '', destinations: [`info@${domainA.name}`] })
        .expect(201);
      expect(catchAll.body).toMatchObject({ address: `@${domainA.name}`, catchAll: true, discard: false });
      await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ domainId: domainA.id, localPart: '', destinations: [`info@${domainA.name}`] })
        .expect(409);
      await bob.agent
        .post(url(orgB, 'aliases'))
        .send({ domainId: domainA.id, localPart: '', destinations: ['x@external.example'] })
        .expect(422);

      const dropped = await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ domainId: domainA.id, localPart: 'old', discard: true })
        .expect(201);
      expect(dropped.body).toMatchObject({ discard: true, destinations: [] });
      // Without discarding, it needs a destination again.
      await alice.agent.patch(`${url(orgA, 'aliases')}/${dropped.body.id}`).send({ discard: false }).expect(400);
      await alice.agent.delete(`${url(orgA, 'aliases')}/${dropped.body.id}`).expect(204);
      await alice.agent.delete(`${url(orgA, 'aliases')}/${catchAll.body.id}`).expect(204);
    });

    it('refuses a mailbox on an address used by an alias', async () => {
      await alice.agent.post(url(orgA, 'mailboxes')).send(newMailbox('sales')).expect(409);
    });

    it('updates and deletes, isolated between organizations', async () => {
      const created = await alice.agent
        .post(url(orgA, 'aliases'))
        .send({ domainId: domainA.id, localPart: 'temp', destinations: ['t@external.example'] })
        .expect(201);
      const id = created.body.id as string;

      await bob.agent.patch(`${url(orgB, 'aliases')}/${id}`).send({ enabled: false }).expect(404);
      await bob.agent.delete(`${url(orgB, 'aliases')}/${id}`).expect(404);
      await bob.agent.get(url(orgA, 'aliases')).expect(404);
      await carol.agent.get(url(orgA, 'aliases')).expect(403);

      const updated = await alice.agent
        .patch(`${url(orgA, 'aliases')}/${id}`)
        .send({ enabled: false, destinations: ['u@external.example'] })
        .expect(200);
      expect(updated.body).toMatchObject({ enabled: false, destinations: ['u@external.example'] });
      await alice.agent.delete(`${url(orgA, 'aliases')}/${id}`).expect(204);
      await alice.agent.get(`${url(orgA, 'aliases')}/${id}`).expect(404);
    });
  });
});
