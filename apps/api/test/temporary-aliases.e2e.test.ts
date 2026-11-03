import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TemporaryAliasesService } from '../src/aliases/temporary-aliases.js';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { mailboxInNewOrg, startApp } from './helpers.js';

describe('Temporary addresses', () => {
  let app: INestApplication;
  let db: Database;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
    a = await mailboxInNewOrg(app, 'tmp-a');
    b = await mailboxInNewOrg(app, 'tmp-b');
  });

  afterAll(async () => {
    await app.close();
  });

  it('makes an address on the person’s domain that delivers to them until it expires', async () => {
    const res = await a.agent.post('/api/me/temporary-addresses').send({ hours: 48, note: 'Shop sign-up' }).expect(201);
    expect(res.body.address).toMatch(new RegExp(`^tmp\\.[a-z0-9]{10}@${a.domainName.replace(/\./g, '\\.')}$`));
    expect(res.body.note).toBe('Shop sign-up');
    const routed = await db.execute(sql`SELECT destination FROM mail.aliases WHERE address = ${res.body.address}`);
    expect(routed.rows).toEqual([{ destination: a.address }]);
    const admin = await a.owner.agent.get(`/api/orgs/${a.orgId}/aliases`).expect(200);
    expect(admin.body.data.find((x: { address: string }) => x.address === res.body.address).expiresAt).toBe(res.body.expiresAt);

    await db.execute(sql`UPDATE aliases SET expires_at = now() - interval '1 minute' WHERE id = ${res.body.id}`);
    expect((await db.execute(sql`SELECT 1 FROM mail.aliases WHERE address = ${res.body.address}`)).rows).toHaveLength(0);
    expect((await a.agent.get('/api/me/temporary-addresses').expect(200)).body.data).toHaveLength(0);
    expect(await app.get(TemporaryAliasesService).deleteExpired()).toBeGreaterThan(0);
  });

  it('extends and deletes only the person’s own', async () => {
    const mine = await a.agent.post('/api/me/temporary-addresses').send({ hours: 1 }).expect(201);
    const extended = await a.agent.patch(`/api/me/temporary-addresses/${mine.body.id}`).send({ hours: 720 }).expect(200);
    expect(Date.parse(extended.body.expiresAt)).toBeGreaterThan(Date.now() + 700 * 3600_000);
    await b.agent.patch(`/api/me/temporary-addresses/${mine.body.id}`).send({ hours: 1 }).expect(404);
    await b.agent.delete(`/api/me/temporary-addresses/${mine.body.id}`).expect(404);
    expect((await b.agent.get('/api/me/temporary-addresses').expect(200)).body.data).toHaveLength(0);
    await a.agent.post('/api/me/temporary-addresses').send({ hours: 0 }).expect(400);
    await a.agent.post('/api/me/temporary-addresses').send({ hours: 24 * 366 }).expect(400);
    await a.agent.delete(`/api/me/temporary-addresses/${mine.body.id}`).expect(204);
  });

  it('counts against the domain’s alias limit', async () => {
    await db.execute(sql`UPDATE domains SET max_aliases = 0 WHERE id = ${a.domainId}`);
    await a.agent.post('/api/me/temporary-addresses').send({ hours: 1 }).expect(409);
    await db.execute(sql`UPDATE domains SET max_aliases = NULL WHERE id = ${a.domainId}`);
  });
});
