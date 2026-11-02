import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Auth } from '../src/auth/auth.js';
import { createApp } from '../src/bootstrap.js';
import { AUTH } from '../src/core/tokens.js';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct horse battery staple';

export interface TestUser {
  id: string;
  email: string;
  agent: TestAgent;
}

export async function startApp(): Promise<INestApplication> {
  const app = await createApp();
  await app.init();
  return app;
}

export function authOf(app: INestApplication): Auth {
  return app.get<Auth>(AUTH);
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.test`;
}

/** A supertest agent that keeps cookies and sends the Origin header Better Auth expects. */
export function newAgent(app: INestApplication): TestAgent {
  return request.agent(app.getHttpServer()).set('Origin', ORIGIN);
}

export async function signUp(app: INestApplication, prefix: string): Promise<TestUser> {
  const agent = newAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: prefix });
  if (res.status !== 200) {
    throw new Error(`sign-up failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.user.id as string, email, agent };
}

export async function signIn(app: INestApplication, email: string): Promise<TestAgent> {
  const agent = newAgent(app);
  const res = await agent.post('/api/auth/sign-in/email').send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return agent;
}

export async function createOrg(user: TestUser, name: string): Promise<string> {
  const slug = `${name.toLowerCase()}-${Date.now()}-${++counter}`;
  const res = await user.agent.post('/api/auth/organization/create').send({ name, slug });
  if (res.status !== 200) {
    throw new Error(`organization create failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

export async function addMember(
  app: INestApplication,
  organizationId: string,
  userId: string,
  role: 'member' | 'admin' | 'owner',
): Promise<void> {
  await authOf(app).api.addMember({ body: { organizationId, userId, role } });
}

/**
 * An organization (owned by a fresh account) with a verified domain and one
 * mailbox, signed in as that mailbox. Used by cross-organization tests.
 */
export async function mailboxInNewOrg(
  app: INestApplication,
  prefix: string,
  localPart = 'user',
): Promise<{ agent: TestAgent; address: string; orgId: string; domainId: string; domainName: string; owner: TestUser }> {
  const owner = await signUp(app, `${prefix}-owner`);
  const orgId = await createOrg(owner, prefix);
  const domainName = `${prefix}-${Date.now()}-${++counter}.example`;
  const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name: domainName });
  await owner.agent.post(`/api/orgs/${orgId}/domains/${domain.body.id}/verify`).expect(200);
  const mailbox = await owner.agent
    .post(`/api/orgs/${orgId}/mailboxes`)
    .send({ domainId: domain.body.id, localPart, password: PASSWORD })
    .expect(201);
  const address = mailbox.body.address as string;
  return { agent: await signIn(app, address), address, orgId, domainId: domain.body.id as string, domainName, owner };
}
