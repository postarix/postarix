import { readFileSync } from 'node:fs';
import { CyrusEngine, type MailEngine, MemoryMailEngine, MurderEngine } from '@postarix/mail-engine';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { mailboxes } from '../db/schema/index.js';
import { mintJmapToken } from '../jmap/jmap-token.js';

export function createMailEngine(env: Env, db?: Database): MailEngine {
  if (env.MAIL_ENGINE === 'memory') return new MemoryMailEngine();
  if (env.CYRUS_BACKENDS.length === 0) return cyrusEngine(env, env.CYRUS_HOST, env.CYRUS_JMAP_URL);
  if (!db) throw new Error('A Cyrus Murder needs the database (where each mailbox lives)');

  const backends = Object.fromEntries(
    env.CYRUS_BACKENDS.map((b) => [b.name, cyrusEngine(env, b.host, env.CYRUS_JMAP_URL ? `https://${b.host}:8008` : undefined)]),
  );
  const fallback = env.CYRUS_DEFAULT_BACKEND ?? env.CYRUS_BACKENDS[0]!.name;
  return new MurderEngine({
    backends,
    serverNames: Object.fromEntries(env.CYRUS_BACKENDS.map((b) => [b.name, b.host])),
    relocate: async (address, backend) => {
      await db.update(mailboxes).set({ mailServer: backend }).where(eq(mailboxes.address, address));
    },
    locate: async (address) => {
      const [row] = await db.select({ server: mailboxes.mailServer }).from(mailboxes).where(eq(mailboxes.address, address)).limit(1);
      return row ? (row.server ?? fallback) : null;
    },
    // An organization's mailboxes stay together (so that calendars and
    // contacts shared between colleagues work in the webmail); a new
    // organization goes to the backend with the fewest mailboxes.
    // Instance-wide placement, not tenant data access.
    place: async (address, names) => {
      const own = await db.execute<{ server: string | null; count: number }>(sql`
        SELECT m.mail_server AS server, count(*)::int AS count
        FROM mailboxes m
        JOIN mailboxes me ON me.address = ${address} AND m.organization_id = me.organization_id
        WHERE m.address <> ${address}
        GROUP BY m.mail_server ORDER BY count(*) DESC LIMIT 1`);
      let name = own.rows[0] ? (own.rows[0].server ?? fallback) : null;
      if (!name || !names.includes(name)) {
        const counts = new Map(names.map((n) => [n, 0]));
        const result = await db.execute<{ server: string | null; count: number }>(
          sql`SELECT mail_server AS server, count(*)::int AS count FROM mailboxes WHERE address <> ${address} GROUP BY mail_server`,
        );
        for (const row of result.rows) {
          const server = row.server ?? fallback;
          if (counts.has(server)) counts.set(server, counts.get(server)! + row.count);
        }
        name = [...counts].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]![0];
      }
      await db.update(mailboxes).set({ mailServer: name }).where(eq(mailboxes.address, address));
      return name;
    },
  });
}

function cyrusEngine(env: Env, host: string, jmapUrl: string | undefined): CyrusEngine {
  const caFile = env.CYRUS_TLS_CA_FILE;
  return new CyrusEngine({
    host,
    port: env.CYRUS_PORT,
    security: env.CYRUS_SECURITY,
    rejectUnauthorized: env.CYRUS_TLS_VERIFY,
    ...(env.CYRUS_TLS_SERVERNAME ? { servername: env.CYRUS_TLS_SERVERNAME } : {}),
    ...(caFile ? { ca: () => readCa(caFile) } : {}),
    ...(jmapUrl ? { jmap: { url: jmapUrl, password: (address: string) => mintJmapToken(env.AUTH_SECRET, address) } } : {}),
    adminUser: env.CYRUS_ADMIN_USER,
    // Presence is enforced by loadEnv when MAIL_ENGINE is "cyrus".
    adminPassword: env.CYRUS_ADMIN_PASSWORD ?? '',
  });
}

/** Re-read on each connection so renewed certificates are trusted without a restart. */
function readCa(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Without the file only the system roots are trusted; the connection then
    // fails verification instead of silently skipping it.
    return undefined;
  }
}
