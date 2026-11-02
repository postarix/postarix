import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { createAuth } from '../auth/auth.js';
import { type Env, loadEnv } from '../config/env.js';
import { createDatabase, type Database, type DatabaseHandle } from '../db/client.js';
import { AUTH, DATABASE, DATABASE_POOL, ENV } from './tokens.js';

const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

/** Provides configuration, the database and the Better Auth instance to the whole app. */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: DATABASE_HANDLE,
      inject: [ENV],
      useFactory: (env: Env) => createDatabase(env.DATABASE_URL),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_HANDLE],
      useFactory: (handle: DatabaseHandle) => handle.db,
    },
    {
      provide: DATABASE_POOL,
      inject: [DATABASE_HANDLE],
      useFactory: (handle: DatabaseHandle) => handle.pool,
    },
    {
      provide: AUTH,
      inject: [DATABASE, ENV],
      useFactory: (db: Database, env: Env) => createAuth(db, env),
    },
  ],
  exports: [ENV, DATABASE, DATABASE_POOL, AUTH],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
