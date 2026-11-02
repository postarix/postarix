// Cyrus Murder: moves mailboxes to another backend (Cyrus XFER), with their
// folders, calendars, contacts and filters. Mail that arrives meanwhile waits
// in Postfix' queue; people using the mailbox may be disconnected once.
//
// Usage (in the API container):
//   node dist/cli/move-mailboxes.js --to <backend> <address>…
//   node dist/cli/move-mailboxes.js --to <backend> --organization <organization id>
//   node dist/cli/move-mailboxes.js --list
// Backends are named as in CYRUS_BACKENDS ("b1=cyrus-backend-1" → b1).
import { MurderEngine } from '@postarix/mail-engine';
import { eq, sql } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { createMailEngine } from '../core/mail-engine.js';
import { createDatabase } from '../db/client.js';
import { mailboxes } from '../db/schema/index.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const list = args.includes('--list');
const to = option('--to');
const organization = option('--organization');
const addresses = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
const engine = createMailEngine(env, db);
let failed = 0;
try {
  if (!(engine instanceof MurderEngine)) throw new Error('Moving mailboxes needs a Cyrus Murder (CYRUS_BACKENDS)');
  const fallback = env.CYRUS_DEFAULT_BACKEND ?? env.CYRUS_BACKENDS[0]!.name;
  if (list) {
    const counts = await db.execute<{ server: string | null; count: number }>(sql`SELECT mail_server AS server, count(*)::int AS count FROM mailboxes GROUP BY mail_server`);
    const totals = new Map(engine.backendNames.map((name) => [name, 0]));
    for (const row of counts.rows) totals.set(row.server ?? fallback, (totals.get(row.server ?? fallback) ?? 0) + row.count);
    for (const [name, count] of totals) console.log(`${name}\t${count} mailboxes`);
  } else {
    if (!to || !engine.backendNames.includes(to)) throw new Error(`--to must be one of: ${engine.backendNames.join(', ')}`);
    const targets = organization
      ? (await db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.organizationId, organization))).map((m) => m.address)
      : addresses;
    if (targets.length === 0) throw new Error('No mailboxes to move: give addresses or --organization');
    for (const address of targets) {
      const started = Date.now();
      try {
        await engine.moveMailbox(address, to);
        console.log(`moved ${address} to ${to} (${Math.round((Date.now() - started) / 1000)} s)`);
      } catch (error) {
        failed++;
        console.error(`could not move ${address}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failed++;
} finally {
  await engine.close();
  await pool.end();
}
process.exit(failed ? 1 : 0);
