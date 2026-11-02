import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { testDatabaseUrl } from './test-env.js';

/**
 * Prepares a clean test database: drops every table, then applies all migrations.
 * Refuses to run unless the database name ends in "_test", to protect real data.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": test database name must end in "_test"`);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  await runMigrations(url);
}
