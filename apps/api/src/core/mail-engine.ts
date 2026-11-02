import { readFileSync } from 'node:fs';
import { CyrusEngine, type MailEngine, MemoryMailEngine } from '@postarix/mail-engine';
import type { Env } from '../config/env.js';

export function createMailEngine(env: Env): MailEngine {
  if (env.MAIL_ENGINE === 'memory') return new MemoryMailEngine();
  const caFile = env.CYRUS_TLS_CA_FILE;
  return new CyrusEngine({
    host: env.CYRUS_HOST,
    port: env.CYRUS_PORT,
    security: env.CYRUS_SECURITY,
    rejectUnauthorized: env.CYRUS_TLS_VERIFY,
    ...(env.CYRUS_TLS_SERVERNAME ? { servername: env.CYRUS_TLS_SERVERNAME } : {}),
    ...(caFile ? { ca: () => readCa(caFile) } : {}),
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
