import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { session, user } from '../src/db/schema/index.js';
import { authOf, newAgent, PASSWORD, signIn, startApp } from './helpers.js';

// Runs the app with production defaults: no public sign-up and only
// super-admins may create organizations.
describe('secure defaults', () => {
  let app: INestApplication;
  const saved = {
    ALLOW_SIGNUP: process.env.ALLOW_SIGNUP,
    ALLOW_USER_CREATE_ORG: process.env.ALLOW_USER_CREATE_ORG,
  };

  beforeAll(async () => {
    delete process.env.ALLOW_SIGNUP;
    delete process.env.ALLOW_USER_CREATE_ORG;
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
    Object.assign(process.env, saved);
  });

  it('refuses public sign-up', async () => {
    const email = `stranger-${Date.now()}@example.test`;
    const res = await newAgent(app)
      .post('/api/auth/sign-up/email')
      .send({ email, password: PASSWORD, name: 'Stranger' });
    expect(res.status).toBe(400);
    expect(res.body.code).toMatch(/SIGN_UP_DISABLED|SIGNUP_DISABLED/);
    const rows = await app
      .get<Database>(DATABASE)
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    expect(rows).toEqual([]);
  });

  it('only lets super-admins create organizations', async () => {
    const auth = authOf(app);
    const userEmail = `regular-${Date.now()}@example.test`;
    await auth.api.createUser({ body: { email: userEmail, password: PASSWORD, name: 'Regular' } });
    const regular = await signIn(app, userEmail);
    const denied = await regular
      .post('/api/auth/organization/create')
      .send({ name: 'Nope', slug: `nope-${Date.now()}` });
    expect(denied.status).toBe(403);

    const adminEmail = `root2-${Date.now()}@example.test`;
    await createSuperAdmin(auth, { email: adminEmail, password: PASSWORD, name: 'Root' });
    const admin = await signIn(app, adminEmail);
    const allowed = await admin
      .post('/api/auth/organization/create')
      .send({ name: 'Yes', slug: `yes-${Date.now()}` });
    expect(allowed.status).toBe(200);
  });

  it('ignores a client-supplied IP header', async () => {
    // The API overwrites x-postarix-client-ip with the socket address; spoofing must not stick.
    const adminEmail = `root3-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email: adminEmail, password: PASSWORD, name: 'Root' });
    const res = await newAgent(app)
      .post('/api/auth/sign-in/email')
      .set('x-postarix-client-ip', '203.0.113.99')
      .set('x-forwarded-for', '203.0.113.98')
      .send({ email: adminEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    const token = res.body.token as string;
    const [row] = await app
      .get<Database>(DATABASE)
      .select({ ipAddress: session.ipAddress })
      .from(session)
      .where(eq(session.token, token));
    expect(row).toBeDefined();
    expect(row?.ipAddress).not.toBe('203.0.113.99');
    expect(row?.ipAddress).not.toBe('203.0.113.98');
    expect(row?.ipAddress).toBeTruthy();
  });
});
