import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { createAuth } from '../auth/auth.js';
import { type Env, loadEnv } from '../config/env.js';
import { createDatabase, type Database, type DatabaseHandle } from '../db/client.js';
import type { MailEngine } from '@postarix/mail-engine';
import { createDnsResolver } from './dns.js';
import { createMailEngine } from './mail-engine.js';
import { AUTH, DATABASE, DATABASE_POOL, DNS_RESOLVER, ENV, MAIL_ENGINE } from './tokens.js';

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
    { provide: MAIL_ENGINE, inject: [ENV], useFactory: (env: Env) => createMailEngine(env) },
    {
      provide: DNS_RESOLVER,
      inject: [ENV],
      useFactory: (env: Env) => createDnsResolver(env.DNS_SERVERS),
    },
  ],
  exports: [ENV, DATABASE, DATABASE_POOL, AUTH, MAIL_ENGINE, DNS_RESOLVER],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: pg.Pool,
    @Inject(MAIL_ENGINE) private readonly mailEngine: MailEngine,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.mailEngine.close();
    await this.pool.end();
  }
}
