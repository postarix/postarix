import { CyrusEngine, type MailEngine, MemoryMailEngine } from '@postarix/mail-engine';
import type { Env } from '../config/env.js';

export function createMailEngine(env: Env): MailEngine {
  if (env.MAIL_ENGINE === 'memory') return new MemoryMailEngine();
  return new CyrusEngine({
    host: env.CYRUS_HOST,
    port: env.CYRUS_PORT,
    security: env.CYRUS_SECURITY,
    rejectUnauthorized: env.CYRUS_TLS_VERIFY,
    adminUser: env.CYRUS_ADMIN_USER,
    // Presence is enforced by loadEnv when MAIL_ENGINE is "cyrus".
    adminPassword: env.CYRUS_ADMIN_PASSWORD ?? '',
  });
}
