import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalSecret } from '../src/config/internal-secrets.js';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { authOf, mailboxInNewOrg, newAgent, PASSWORD, signIn, startApp } from './helpers.js';

function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const TOKEN = internalSecret('internal-test-token-that-is-long-enough', 'mail-auth');

describe('Ending open mail sessions when access ends', () => {
  let app: INestApplication;
  const node = `cyrus-${Date.now().toString(36)}`;

  const poll = (name = node, token: string | null = TOKEN) => {
    const req = request(app.getHttpServer()).get('/api/internal/sessions/disconnects').query({ node: name, wait: 0 });
    if (token) req.set('x-postarix-internal-token', token);
    return req;
  };
  const lines = (text: string) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, username] = line.split(' ');
        return { id: Number(id), username: username! };
      });
  const ack = (last: number, name = node) =>
    request(app.getHttpServer())
      .post('/api/internal/sessions/disconnects/ack')
      .type('form')
      .set('x-postarix-internal-token', TOKEN)
      .send({ node: name, last: String(last) })
      .expect(204);
  /** Everything a node has not applied yet, acknowledged. */
  const drain = async (name = node) => {
    const pending = lines((await poll(name).expect(200)).text);
    if (pending.length) await ack(pending.at(-1)!.id, name);
    return pending.map((p) => p.username);
  };

  beforeAll(async () => {
    app = await startApp();
    await drain();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is only for the mail containers', async () => {
    await poll(node, null).expect(401);
    await poll(node, 'wrong').expect(401);
    await poll(node).set('x-forwarded-for', '203.0.113.9').expect(404);
    await poll('bad node name').expect(400);
  });

  it('asks Cyrus to end the sessions of a mailbox that is disabled, then allowed again', async () => {
    const a = await mailboxInNewOrg(app, 'sd-dis');
    const id = (await a.owner.agent.get(`/api/orgs/${a.orgId}/mailboxes`).expect(200)).body.data[0].id;
    expect(await drain()).toEqual([]);
    await a.owner.agent.patch(`/api/orgs/${a.orgId}/mailboxes/${id}`).send({ status: 'disabled' }).expect(200);
    expect(await drain()).toEqual([a.address]);
    // Already applied: not handed out again.
    expect(await drain()).toEqual([]);
  });

  it('on a password change, an app password revoked, a ban and a deleted mailbox', async () => {
    const b = await mailboxInNewOrg(app, 'sd-many');
    const id = (await b.owner.agent.get(`/api/orgs/${b.orgId}/mailboxes`).expect(200)).body.data[0].id;
    await drain();

    await b.agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'another long password 77' }).expect(200);
    expect(await drain()).toEqual([b.address]);

    const agent = await signIn(app, b.address, 'another long password 77');
    const created = await agent.post('/api/me/app-passwords').send({ name: 'Phone', scopes: ['imap'] }).expect(201);
    expect(await drain()).toEqual([]);
    await agent.delete(`/api/me/app-passwords/${created.body.id}`).expect(204);
    expect(await drain()).toEqual([b.address]);

    await b.owner.agent.post(`/api/orgs/${b.orgId}/mailboxes/${id}/password`).send({ password: 'a reset long password 9' });
    expect(await drain()).toEqual([b.address]);

    const rootEmail = `sd-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email: rootEmail, password: PASSWORD, name: 'Root' });
    const root = await signIn(app, rootEmail);
    const [owner] = (await b.owner.agent.get(`/api/orgs/${b.orgId}/mailboxes`).expect(200)).body.data;
    expect(owner.address).toBe(b.address);
    const userId = (await root.get('/api/auth/admin/list-users').query({ searchValue: b.address, searchField: 'email' })).body.users?.[0]?.id;
    expect(userId).toBeTruthy();
    await root.post('/api/auth/admin/ban-user').send({ userId }).expect(200);
    expect(await drain()).toContain(b.address);

    await b.owner.agent.delete(`/api/orgs/${b.orgId}/mailboxes/${id}`).expect(204);
    expect(await drain()).toContain(b.address);
  });

  it('when a second factor is turned on (the password stops working for mail apps), not at each sign-in', async () => {
    const d = await mailboxInNewOrg(app, 'sd-2fa');
    await drain();
    const enabled = await d.agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const secret = new URL(enabled.body.totpURI as string).searchParams.get('secret')!;
    await d.agent.post('/api/auth/two-factor/verify-totp').send({ code: totp(secret) }).expect(200);
    expect(await drain()).toEqual([d.address]);

    const agent = newAgent(app);
    await agent.post('/api/auth/sign-in/email').send({ email: d.address, password: PASSWORD }).expect(200);
    await agent.post('/api/auth/two-factor/verify-totp').send({ code: totp(secret) }).expect(200);
    expect(await drain()).toEqual([]);
  });

  it('keeps the requests for a node that was away, and starts a new node at the latest', async () => {
    const away = `${node}-away`;
    await drain(away); // known from now on
    const c = await mailboxInNewOrg(app, 'sd-away');
    const id = (await c.owner.agent.get(`/api/orgs/${c.orgId}/mailboxes`).expect(200)).body.data[0].id;
    await c.owner.agent.patch(`/api/orgs/${c.orgId}/mailboxes/${id}`).send({ status: 'no_login' }).expect(200);
    // The node comes back later: it still gets it.
    expect(await drain(away)).toContain(c.address);
    // A node never seen before has no older sessions to end.
    expect(await drain(`${node}-new`)).toEqual([]);
  });

  it('holds the poll open until there is something', async () => {
    await drain();
    const started = Date.now();
    await request(app.getHttpServer())
      .get('/api/internal/sessions/disconnects')
      .query({ node, wait: 2 })
      .set('x-postarix-internal-token', TOKEN)
      .expect(200, '');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });
});
