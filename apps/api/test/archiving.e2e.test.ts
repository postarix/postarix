import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { addMember, authOf, createOrg, mailboxInNewOrg, PASSWORD, signIn, signUp, startApp, type TestUser } from './helpers.js';

describe('Archiving and legal hold', () => {
  let app: INestApplication;
  let db: Database;
  let owner: TestUser;
  let admin: TestUser;
  let orgId: string;
  let domainId: string;
  let root: TestAgent;
  const ids: Record<string, string> = {};
  const addresses: Record<string, string> = {};

  const mailbox = async (localPart: string) => {
    const body = (await owner.agent.post(`/api/orgs/${orgId}/mailboxes`).send({ domainId, localPart, password: PASSWORD }).expect(201)).body as { id: string; address: string };
    ids[localPart] = body.id;
    addresses[localPart] = body.address;
  };
  const copies = async (address: string) =>
    (await db.execute<{ archive: string }>(sql`SELECT archive FROM mail.archive_copies WHERE address = ${address}`)).rows.map((r) => r.archive);

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    owner = await signUp(app, 'arch-owner');
    admin = await signUp(app, 'arch-admin');
    orgId = await createOrg(owner, 'Archived');
    await addMember(app, orgId, admin.id, 'admin');
    const domain = await owner.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `arch-${Date.now()}.example` });
    domainId = domain.body.id;
    await owner.agent.post(`/api/orgs/${orgId}/domains/${domainId}/verify`).expect(200);
    await mailbox('archive');
    await mailbox('ann');
    await mailbox('ben');
    await owner.agent.post(`/api/orgs/${orgId}/aliases`).send({ domainId, localPart: 'sales', destinations: [addresses.ann] }).expect(201);
    const email = `arch-root-${Date.now()}@example.test`;
    await createSuperAdmin(authOf(app), { email, password: PASSWORD, name: 'Root' });
    root = await signIn(app, email);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is off by default, and only owners may change it', async () => {
    expect((await owner.agent.get(`/api/orgs/${orgId}/archiving`).expect(200)).body).toEqual({ archiveMailboxId: null, legalHold: false });
    await admin.agent.get(`/api/orgs/${orgId}/archiving`).expect(403);
    await admin.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: ids.archive, legalHold: false }).expect(403);
    expect(await copies(addresses.ann!)).toEqual([]);
  });

  it('copies mail of every mailbox and alias to the archive (not the archive’s own)', async () => {
    await owner.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: ids.archive, legalHold: false }).expect(200);
    expect(await copies(addresses.ann!)).toEqual([addresses.archive]);
    expect(await copies(addresses.ben!)).toEqual([addresses.archive]);
    expect(await copies(`sales@${addresses.ann!.split('@')[1]}`)).toEqual([addresses.archive]);
    expect(await copies(addresses.archive!)).toEqual([]);
    const audit = await owner.agent.get(`/api/orgs/${orgId}/audit`).expect(200);
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain('organization.archiving_on');
  });

  it('keeps the archive mailbox while archiving is on', async () => {
    const res = await owner.agent.delete(`/api/orgs/${orgId}/mailboxes/${ids.archive}`).expect(409);
    expect(res.body.code).toBe('ARCHIVE_MAILBOX');
    await owner.agent.patch(`/api/orgs/${orgId}/mailboxes/${ids.archive}`).send({ status: 'disabled' }).expect(409);
  });

  it('under legal hold, keeps every mailbox and the organization', async () => {
    await owner.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: ids.archive, legalHold: true }).expect(200);
    const res = await owner.agent.delete(`/api/orgs/${orgId}/mailboxes/${ids.ben}`).expect(409);
    expect(res.body.code).toBe('LEGAL_HOLD');
    await owner.agent.patch(`/api/orgs/${orgId}/mailboxes/${ids.ben}`).send({ status: 'disabled' }).expect(409);
    await root.delete(`/api/admin/organizations/${orgId}`).send({ confirm: 'Archived' }).expect(409);
    // Changing the archive needs the hold lifted first.
    await owner.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: ids.ben, legalHold: true }).expect(409);

    await owner.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: ids.archive, legalHold: false }).expect(200);
    await owner.agent.delete(`/api/orgs/${orgId}/mailboxes/${ids.ben}`).expect(204);
  });

  it('applies to its own organization only', async () => {
    const other = await mailboxInNewOrg(app, 'arch-other');
    await other.owner.agent.get(`/api/orgs/${orgId}/archiving`).expect(404);
    await other.owner.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: null, legalHold: false }).expect(404);
    // Another organization's mailbox cannot become this one's archive.
    const theirs = (await other.owner.agent.get(`/api/orgs/${other.orgId}/mailboxes`).expect(200)).body.data[0].id as string;
    await owner.agent.put(`/api/orgs/${orgId}/archiving`).send({ archiveMailboxId: theirs, legalHold: false }).expect(404);
    expect(await copies(other.address)).toEqual([]);
  });

  it('lets an organization without a hold be deleted, archive included', async () => {
    await root.delete(`/api/admin/organizations/${orgId}`).send({ confirm: 'Archived' }).expect(200);
    expect(await copies(addresses.ann!)).toEqual([]);
  });
});
