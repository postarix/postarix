import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/tokens.js';
import type { Database } from '../src/db/client.js';
import { startApp } from './helpers.js';

/** The database functions Postfix uses to rewrite senders of forwarded mail. */
describe('Sender rewriting for forwarded mail (SRS)', () => {
  let app: INestApplication;
  let db: Database;
  const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows[0]?.value as string | null;

  beforeAll(async () => {
    app = await startApp();
    db = app.get<Database>(DATABASE);
  });
  afterAll(async () => {
    await app.close();
  });

  it('rewrites a sender and finds it again', async () => {
    const srs = await one(sql`SELECT mail.srs_forward('Ana.Lopez@Example.org', 'mail.postarix.test') AS value`);
    expect(srs).toMatch(/^SRS0=[0-9a-f]{8}=[a-z2-7]{2}=example\.org=Ana\.Lopez@mail\.postarix\.test$/);
    // Postfix looks addresses up in lower case.
    expect(await one(sql`SELECT mail.srs_reverse(${srs!.toLowerCase()}) AS value`)).toBe('ana.lopez@example.org');
    expect(await one(sql`SELECT mail.srs_reverse(${srs}) AS value`)).toBe('Ana.Lopez@example.org');
  });

  it('refuses forged, altered and expired addresses', async () => {
    const srs = (await one(sql`SELECT mail.srs_forward('ana@example.org', 'mail.postarix.test') AS value`))!;
    const altered = srs.replace('=ana@', '=eve@');
    expect(await one(sql`SELECT mail.srs_reverse(${altered}) AS value`)).toBeNull();
    expect(await one(sql`SELECT mail.srs_reverse('SRS0=00000000=aa=example.org=ana@mail.postarix.test') AS value`)).toBeNull();
    const old = await one(sql`SELECT mail.srs_day(now() - interval '30 days') AS value`);
    // Correctly signed, but 30 days old (the database owner may compute hashes).
    const oldHash = await one(sql`SELECT mail.srs_hash(${old}, 'example.org', 'ana') AS value`);
    const expired = `SRS0=${oldHash}=${old}=example.org=ana@mail.postarix.test`;
    const fresh = srs;
    expect(await one(sql`SELECT mail.srs_reverse(${fresh}) AS value`)).toBe('ana@example.org');
    expect(await one(sql`SELECT mail.srs_reverse(${expired}) AS value`)).toBeNull();
    expect(await one(sql`SELECT mail.srs_reverse('ana@example.org') AS value`)).toBeNull();
  });

  it('leaves the null sender, the server itself and SRS addresses alone', async () => {
    expect(await one(sql`SELECT mail.srs_forward('', 'mail.postarix.test') AS value`)).toBeNull();
    expect(await one(sql`SELECT mail.srs_forward('@mail.postarix.test', 'mail.postarix.test') AS value`)).toBeNull();
    expect(await one(sql`SELECT mail.srs_forward('x@mail.postarix.test', 'mail.postarix.test') AS value`)).toBeNull();
    expect(await one(sql`SELECT mail.srs_forward('SRS0=abcd1234=aa=b.org=c@other.example', 'mail.postarix.test') AS value`)).toBeNull();
  });
});
