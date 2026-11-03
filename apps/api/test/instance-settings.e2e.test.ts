import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { MAIL_ENGINE, SYSTEM_MAILER } from '../src/core/tokens.js';
import type { MemorySystemMailer } from '../src/mail/system-mailer.js';
import { QuotaWarningsService } from '../src/mailboxes/quota-warnings.js';
import { authOf, mailboxInNewOrg, newAgent, PASSWORD, signIn, startApp } from './helpers.js';

describe('Instance settings', () => {
  let app: INestApplication;
  let root: TestAgent;
  let org: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  beforeAll(async () => {
    app = await startApp();
    const email = `settings-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
    org = await mailboxInNewOrg(app, 'settings');
  });

  afterAll(async () => {
    // Back to the defaults for the other test files.
    await root
      .put('/api/system/settings')
      .send({
        signIn: { maxFailures: 10, lockMinutes: 15 },
        passwords: { minLength: 12, requireMixed: false },
        quota: { warnAtPercent: 90 },
        branding: { productName: 'Postarix', loginMessage: '', announcement: '', supportUrl: '' },
      })
      .expect(200);
    await app.close();
  });

  it('starts from the defaults, and is for instance administrators only', async () => {
    const res = await root.get('/api/system/settings').expect(200);
    expect(res.body).toMatchObject({
      signIn: { maxFailures: 10, lockMinutes: 15 },
      passwords: { minLength: 12, requireMixed: false },
      quota: { warnAtPercent: 90 },
      branding: { productName: 'Postarix' },
    });
    await org.owner.agent.get('/api/system/settings').expect(404);
    await org.owner.agent.put('/api/system/settings').send({ quota: { warnAtPercent: 50 } }).expect(404);
  });

  it('shows the branding to everyone, signed in or not', async () => {
    await root
      .put('/api/system/settings')
      .send({ branding: { productName: 'Acme Mail', loginMessage: 'Help: +1 555 0100', announcement: 'Maintenance on Sunday' } })
      .expect(200);
    const res = await request(app.getHttpServer()).get('/api/branding').expect(200);
    expect(res.body).toMatchObject({ productName: 'Acme Mail', loginMessage: 'Help: +1 555 0100', announcement: 'Maintenance on Sunday', passwordMinLength: 12 });
    await root.put('/api/system/settings').send({ branding: { supportUrl: 'javascript:alert(1)' } }).expect(400);
    await root.put('/api/system/settings').send({ signIn: { maxFailures: 1 } }).expect(400);
    await root.put('/api/system/settings').send({ unknown: {} }).expect(400);
  });

  it('applies the password policy to new mailboxes and password changes', async () => {
    await root.put('/api/system/settings').send({ passwords: { minLength: 16, requireMixed: true } }).expect(200);
    const tooShort = await org.owner.agent
      .post(`/api/orgs/${org.orgId}/mailboxes`)
      .send({ domainId: org.domainId, localPart: 'short', password: 'Abcdefgh1234!' })
      .expect(422);
    expect(tooShort.body.code).toBe('PASSWORD_POLICY');
    await org.owner.agent
      .post(`/api/orgs/${org.orgId}/mailboxes`)
      .send({ domainId: org.domainId, localPart: 'plain', password: 'all lowercase but long enough' })
      .expect(422);
    await org.owner.agent
      .post(`/api/orgs/${org.orgId}/mailboxes`)
      .send({ domainId: org.domainId, localPart: 'mixed', password: 'Mixed Case and 42 digits' })
      .expect(201);
    const change = await org.agent
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'short Pass 1' });
    expect(change.status).toBe(400);
    await root.put('/api/system/settings').send({ passwords: { minLength: 12, requireMixed: false } }).expect(200);
  });

  it('locks accounts after the configured number of failed passwords', async () => {
    await root.put('/api/system/settings').send({ signIn: { maxFailures: 3, lockMinutes: 5 } }).expect(200);
    const created = await org.owner.agent
      .post(`/api/orgs/${org.orgId}/mailboxes`)
      .send({ domainId: org.domainId, localPart: 'lockme', password: PASSWORD })
      .expect(201);
    const email = created.body.address as string;
    for (let i = 0; i < 3; i++) {
      await newAgent(app).post('/api/auth/sign-in/email').send({ email, password: 'wrong password, again' });
    }
    const locked = await newAgent(app).post('/api/auth/sign-in/email').send({ email, password: PASSWORD });
    expect(locked.status).toBe(429);
  });

  it('tells people when their mailbox is nearly full, once', async () => {
    const engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    const mailer = app.get<MemorySystemMailer>(SYSTEM_MAILER);
    const warnings = app.get(QuotaWarningsService);
    const created = await org.owner.agent
      .post(`/api/orgs/${org.orgId}/mailboxes`)
      .send({ domainId: org.domainId, localPart: 'full', password: PASSWORD, quotaBytes: 100 * 1024 * 1024 })
      .expect(201);
    const address = created.body.address as string;
    engine.mailboxes.get(address)!.usedBytes = 95 * 1024 * 1024;
    mailer.sent.length = 0;
    await warnings.check();
    expect(mailer.sent.filter((m) => m.to === address)).toEqual([expect.objectContaining({ subject: 'Your mailbox is 95% full' })]);
    await warnings.check();
    expect(mailer.sent.filter((m) => m.to === address)).toHaveLength(1);
    // A week later it is said again.
    await warnings.check(new Date(Date.now() + 8 * 86_400_000));
    expect(mailer.sent.filter((m) => m.to === address)).toHaveLength(2);
  });
});
