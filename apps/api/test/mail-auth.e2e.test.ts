import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { mintJmapToken } from '../src/jmap/jmap-token.js';
import { createOrg, newAgent, signUp, startApp, type TestUser } from './helpers.js';

const TOKEN = 'internal-test-token-that-is-long-enough';
const MAILBOX_PASSWORD = 'a long mailbox password';

describe('App passwords and the mail login bridge', () => {
  let app: INestApplication;
  let admin: TestUser;
  let orgId: string;
  let domain: string;
  let domainId: string;
  let address: string;
  let mailboxId: string;
  let owner: ReturnType<typeof newAgent>;

  const mailAuth = (fields: Record<string, string>, token: string | null = TOKEN) => {
    const req = request(app.getHttpServer()).post('/api/internal/mail-auth').type('form');
    if (token !== null) req.set('x-postarix-internal-token', token);
    return req.send(fields);
  };

  beforeAll(async () => {
    app = await startApp();
    admin = await signUp(app, 'ma-admin');
    orgId = await createOrg(admin, 'MailAuth');
    const created = await admin.agent
      .post(`/api/orgs/${orgId}/domains`)
      .send({ name: `auth-${Date.now()}.example` })
      .expect(201);
    domain = created.body.name;
    domainId = created.body.id;
    await admin.agent.post(`/api/orgs/${orgId}/domains/${created.body.id}/verify`).expect(200);
    const mailbox = await admin.agent
      .post(`/api/orgs/${orgId}/mailboxes`)
      .send({ domainId: created.body.id, localPart: 'dana', password: MAILBOX_PASSWORD })
      .expect(201);
    address = mailbox.body.address;
    mailboxId = mailbox.body.id;
    owner = newAgent(app);
    await owner.post('/api/auth/sign-in/email').send({ email: address, password: MAILBOX_PASSWORD }).expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('internal endpoint protection', () => {
    it('refuses requests that came through a reverse proxy, even with the token', async () => {
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' })
        .set('x-forwarded-for', '203.0.113.7')
        .expect(404);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' })
        .set('forwarded', 'for=203.0.113.7')
        .expect(404);
    });

    it('requires the shared token', async () => {
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }, null).expect(401);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }, 'wrong').expect(401);
      await mailAuth(
        { username: address, password: MAILBOX_PASSWORD, service: 'imap' },
        `${TOKEN}x`,
      ).expect(401);
    });
  });

  describe('account password', () => {
    it('works for mail while the user has no second factor', async () => {
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(204);
      await mailAuth({ username: address.toUpperCase(), password: MAILBOX_PASSWORD, service: 'smtp' }).expect(204);
    });

    it('rejects wrong passwords, unknown users and unknown services', async () => {
      await mailAuth({ username: address, password: 'wrong password!!', service: 'imap' }).expect(401);
      await mailAuth({ username: `nobody@${domain}`, password: MAILBOX_PASSWORD, service: 'imap' }).expect(401);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'ftp' }).expect(401);
    });
  });

  describe('app passwords', () => {
    let imapPassword: string;
    let imapPasswordId: string;

    it('are created once, shown once and listed without the secret', async () => {
      const res = await owner
        .post('/api/me/app-passwords')
        .send({ name: 'Thunderbird', scopes: ['imap', 'imap'] })
        .expect(201);
      expect(res.body.password).toMatch(/^([a-z2-7]{4} ){5}[a-z2-7]{4}$/);
      expect(res.body.scopes).toEqual(['imap']);
      imapPassword = res.body.password;
      imapPasswordId = res.body.id;

      const list = await owner.get('/api/me/app-passwords').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(imapPassword.replace(/ /g, ''));
      await owner.post('/api/me/app-passwords').send({ name: 'Thunderbird', scopes: ['smtp'] }).expect(409);
    });

    it('authenticate only for their scopes, however they are typed', async () => {
      await mailAuth({ username: address, password: imapPassword, service: 'imap' }).expect(204);
      await mailAuth({ username: address, password: imapPassword.toUpperCase(), service: 'pop' }).expect(204);
      await mailAuth({ username: address, password: imapPassword.replace(/ /g, '-'), service: 'sieve' }).expect(204);
      await mailAuth({ username: address, password: imapPassword, service: 'smtp' }).expect(401);

      const list = await owner.get('/api/me/app-passwords').expect(200);
      expect(list.body.data[0].lastUsedAt).not.toBeNull();
    });

    it('cannot be listed or revoked by another user', async () => {
      const stranger = await signUp(app, 'ma-stranger');
      const list = await stranger.agent.get('/api/me/app-passwords').expect(200);
      expect(list.body.data).toEqual([]);
      await stranger.agent.delete(`/api/me/app-passwords/${imapPasswordId}`).expect(404);
      await mailAuth({ username: address, password: imapPassword, service: 'imap' }).expect(204);
    });

    it('stop working immediately when revoked', async () => {
      await owner.delete(`/api/me/app-passwords/${imapPasswordId}`).expect(204);
      await mailAuth({ username: address, password: imapPassword, service: 'imap' }).expect(401);
    });

    it('become the only option once 2FA is enabled', async () => {
      const smtp = await owner
        .post('/api/me/app-passwords')
        .send({ name: 'Phone', scopes: ['smtp', 'imap'] })
        .expect(201);
      await app
        .get<Database>(DATABASE)
        .execute(sql`UPDATE "user" SET two_factor_enabled = true WHERE email = ${address}`);

      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(401);
      await mailAuth({ username: address, password: smtp.body.password, service: 'smtp' }).expect(204);

      await app
        .get<Database>(DATABASE)
        .execute(sql`UPDATE "user" SET two_factor_enabled = false WHERE email = ${address}`);
    });
  });

  describe('webmail login tokens', () => {
    it('are accepted only by the JMAP service and only for their own address', async () => {
      const secret = process.env.AUTH_SECRET!;
      const token = mintJmapToken(secret, address);
      const jmap = { service: 'http', instance: 'jmap' };
      await mailAuth({ username: address, password: token, ...jmap }).expect(204);
      // Not on CalDAV/CardDAV, IMAP or SMTP.
      await mailAuth({ username: address, password: token, service: 'http' }).expect(401);
      await mailAuth({ username: address, password: token, service: 'imap' }).expect(401);
      await mailAuth({ username: address, password: token, service: 'smtp' }).expect(401);
      await mailAuth({ username: address, password: mintJmapToken(secret, `other@${domain}`), ...jmap }).expect(401);
      await mailAuth({ username: address, password: mintJmapToken('x'.repeat(40), address), ...jmap }).expect(401);
    });

    it('are the only thing the JMAP service accepts', async () => {
      const dav = await owner.post('/api/me/app-passwords').send({ name: 'Calendar', scopes: ['dav'] }).expect(201);
      await mailAuth({ username: address, password: dav.body.password, service: 'http' }).expect(204);
      await mailAuth({ username: address, password: dav.body.password, service: 'http', instance: 'jmap' }).expect(401);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'http', instance: 'jmap' }).expect(401);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'http', instance: 'other' }).expect(400);
    });
  });

  describe('account state', () => {
    it('refuses disabled mailboxes', async () => {
      await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${mailboxId}`).send({ status: 'disabled' }).expect(200);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(401);
      await admin.agent.patch(`/api/orgs/${orgId}/mailboxes/${mailboxId}`).send({ status: 'active' }).expect(200);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(204);
    });

    it('refuses banned users', async () => {
      const db = app.get<Database>(DATABASE);
      await db.execute(sql`UPDATE "user" SET banned = true WHERE email = ${address}`);
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(401);
      await db.execute(sql`UPDATE "user" SET banned = false WHERE email = ${address}`);
    });

    it('locks the account password after repeated failures, but not app passwords', async () => {
      const created = await owner
        .post('/api/me/app-passwords')
        .send({ name: 'Lockout client', scopes: ['imap'] })
        .expect(201);
      for (let i = 0; i < 10; i++) {
        await mailAuth({ username: address, password: `wrong password ${i}`, service: 'imap' }).expect(401);
      }
      // The right account password is now refused ...
      await mailAuth({ username: address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(401);
      // ... while existing clients with an app password keep working.
      await mailAuth({ username: address, password: created.body.password, service: 'imap' }).expect(204);
    });

    it('counts parallel failures before checking them', async () => {
      const other = await admin.agent
        .post(`/api/orgs/${orgId}/mailboxes`)
        .send({ domainId, localPart: 'parallel', password: MAILBOX_PASSWORD })
        .expect(201);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          mailAuth({ username: other.body.address, password: `wrong password ${i}`, service: 'imap' }).expect(401),
        ),
      );
      await mailAuth({ username: other.body.address, password: MAILBOX_PASSWORD, service: 'imap' }).expect(401);
    });
  });
});
