import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { user } from '../src/db/schema/index.js';
import { authOf, mailboxInNewOrg, PASSWORD, signIn, startApp } from './helpers.js';

describe('Sign in as a mailbox (impersonation)', () => {
  let app: INestApplication;
  let db: Database;
  let root: TestAgent;
  let rootId: string;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let mailboxA: string;
  const suffix = Date.now().toString(36);

  const sessionOf = async (agent: TestAgent) => (await agent.get('/api/auth/get-session').expect(200)).body;
  const strengthen = async (agent: TestAgent) => {
    const id = (await sessionOf(agent)).session.id as string;
    await db.execute(sql`INSERT INTO session_factors (session_id, method) VALUES (${id}, 'two_factor') ON CONFLICT DO NOTHING`);
  };
  const enter = (agent: TestAgent, orgId: string, mailboxId: string, reason = 'Checking unpaid invoices') =>
    agent.post(`/api/orgs/${orgId}/mailboxes/${mailboxId}/impersonate`).send({ reason });

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    const email = `imp-root-${suffix}@example.test`;
    rootId = (await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' })).id;
    root = await signIn(app, email);
    a = await mailboxInNewOrg(app, 'imp-a');
    b = await mailboxInNewOrg(app, 'imp-b');
    mailboxA = (await a.owner.agent.get(`/api/orgs/${a.orgId}/mailboxes`).expect(200)).body.data[0].id;
  });

  afterAll(async () => {
    await root.put('/api/system/settings').send({ impersonation: { allowOrgAdmins: false } });
    await app.close();
  });

  it('needs a second factor and a reason', async () => {
    const weak = await enter(root, a.orgId, mailboxA).expect(403);
    expect(weak.body.code).toBe('SECOND_FACTOR_REQUIRED');
    await strengthen(root);
    await enter(root, a.orgId, mailboxA, '').expect(400);
  });

  it('opens the mailbox for an hour, for its mail only, and goes back to the administrator', async () => {
    const started = await enter(root, a.orgId, mailboxA).expect(200);
    expect(new Date(started.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);

    const inside = await sessionOf(root);
    expect(inside.user.email).toBe(a.address);
    expect(inside.session.impersonatedBy).toBe(rootId);
    await root.get('/api/mail/identities').expect(200);

    // No administration and no account security while inside.
    expect((await root.get(`/api/orgs/${a.orgId}/overview`).expect(403)).body.code).toBe('IMPERSONATING');
    await root.get('/api/system/admins').expect(403);
    await root.get('/api/me/app-passwords').expect(403);
    await root.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'another long password 1' }).expect(403);
    await root.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(403);
    // Nor a second impersonation from inside.
    await enter(root, a.orgId, mailboxA).expect(403);

    await root.post('/api/me/impersonation/stop').expect(204);
    const back = await sessionOf(root);
    expect(back.user.id).toBe(rootId);
    expect(back.session.impersonatedBy ?? null).toBeNull();
    await root.get(`/api/orgs/${a.orgId}/overview`).expect(200);
  });

  it('is recorded, with the reason, in the organization’s activity', async () => {
    const audit = (await a.owner.agent.get(`/api/orgs/${a.orgId}/audit`).expect(200)).body.data as {
      action: string;
      targetLabel: string;
      actorEmail: string;
      details: Record<string, unknown> | null;
    }[];
    const started = audit.find((e) => e.action === 'mailbox.impersonation_started');
    expect(started).toMatchObject({ targetLabel: a.address, actorEmail: `imp-root-${suffix}@example.test` });
    expect(started?.details).toMatchObject({ reason: 'Checking unpaid invoices', viaSuperAdmin: true });
    expect(audit.find((e) => e.action === 'mailbox.impersonation_ended')).toMatchObject({ targetLabel: a.address });
  });

  it('is for instance administrators unless the instance allows organization admins', async () => {
    await strengthen(a.owner.agent);
    expect((await enter(a.owner.agent, a.orgId, mailboxA).expect(403)).body.message).toMatch(/Only instance administrators/);
    await root.put('/api/system/settings').send({ impersonation: { allowOrgAdmins: true } }).expect(200);
    await enter(a.owner.agent, a.orgId, mailboxA).expect(200);
    expect((await sessionOf(a.owner.agent)).user.email).toBe(a.address);
    await a.owner.agent.post('/api/me/impersonation/stop').expect(204);
    // Members are not administrators.
    await enter(a.agent, a.orgId, mailboxA).expect(403);
  });

  it('never reaches another organization’s mailboxes, nor an instance administrator’s', async () => {
    await strengthen(b.owner.agent);
    await enter(b.owner.agent, a.orgId, mailboxA).expect(404);
    await enter(b.owner.agent, b.orgId, mailboxA).expect(404);

    const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, a.address));
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, owner!.id));
    try {
      await enter(root, a.orgId, mailboxA).expect(403);
    } finally {
      await db.update(user).set({ role: 'user' }).where(eq(user.id, owner!.id));
    }
  });

  it('keeps Better Auth’s own impersonation closed, and its grant unforgeable', async () => {
    await root.post('/api/auth/admin/impersonate-user').send({ userId: rootId }).expect(404);
    await root.post('/api/auth/postarix/impersonate').send({ targetUserId: rootId, grant: `${Date.now() + 30_000}.forged` }).expect(403);
  });
});
