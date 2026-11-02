// Creates the first instance super-admin. Public sign-up is disabled by default,
// so this is how a fresh installation gets its first account.
//
// Usage:
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' ADMIN_NAME='Your Name' \
//     pnpm --filter @postarix/api create-admin
import { createAuth } from '../src/auth/auth.js';
import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { createSuperAdmin } from '../src/auth/create-super-admin.js';

const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  process.exit(1);
}

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  const user = await createSuperAdmin(createAuth(db, env), {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    name: ADMIN_NAME ?? 'Administrator',
  });
  console.log(`Super-admin created: ${user.email}`);
} finally {
  await pool.end();
}
