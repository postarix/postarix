import { MemorySystemMailer, SmtpSystemMailer, type SystemMailer } from '../mail/system-mailer.js';
import { type CounterStore, MemoryCounterStore, ValkeyCounterStore } from './counter-store.js';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { createAuth } from '../auth/auth.js';
import { SecondFactorPolicy } from '../auth/second-factor-policy.js';
import { type Env, loadEnv } from '../config/env.js';
import { createDatabase, type Database, type DatabaseHandle } from '../db/client.js';
import type { MailEngine } from '@postarix/mail-engine';
import { createDnsResolver } from './dns.js';
import { createMailEngine } from './mail-engine.js';
import { type DkimPublisher, MemoryDkimPublisher, ValkeyDkimPublisher } from '../dkim/dkim-publisher.js';
import { AUTH, DATABASE, DATABASE_POOL, DKIM_PUBLISHER, DNS_RESOLVER, ENV, MAIL_ENGINE, COUNTER_STORE, RATE_LIMIT_STORE, SYSTEM_MAILER } from './tokens.js';
import { MemoryRateLimitStore, type RateLimitStore, ValkeyRateLimitStore } from '../rate-limits/rate-limits.js';

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
      provide: SYSTEM_MAILER,
      inject: [ENV],
      useFactory: (env: Env): SystemMailer =>
        env.MAIL_ENGINE === 'memory' ? new MemorySystemMailer() : new SmtpSystemMailer(env),
    },
    {
      provide: COUNTER_STORE,
      inject: [ENV],
      useFactory: (env: Env): CounterStore =>
        env.VALKEY_URL ? new ValkeyCounterStore(env.VALKEY_URL) : new MemoryCounterStore(),
    },
    {
      provide: AUTH,
      inject: [DATABASE, ENV, COUNTER_STORE],
      useFactory: (db: Database, env: Env, counters: CounterStore) => createAuth(db, env, counters),
    },
    { provide: MAIL_ENGINE, inject: [ENV, DATABASE], useFactory: (env: Env, db: Database) => createMailEngine(env, db) },
    SecondFactorPolicy,
    {
      provide: DNS_RESOLVER,
      inject: [ENV],
      useFactory: (env: Env) => createDnsResolver(env.DNS_SERVERS),
    },
    {
      provide: DKIM_PUBLISHER,
      inject: [ENV],
      useFactory: (env: Env): DkimPublisher =>
        env.VALKEY_URL ? new ValkeyDkimPublisher(env.VALKEY_URL) : new MemoryDkimPublisher(),
    },
    {
      provide: RATE_LIMIT_STORE,
      inject: [ENV],
      useFactory: (env: Env): RateLimitStore =>
        env.VALKEY_URL ? new ValkeyRateLimitStore(env.VALKEY_URL) : new MemoryRateLimitStore(),
    },
  ],
  exports: [
    SecondFactorPolicy,
    ENV,
    DATABASE,
    DATABASE_POOL,
    AUTH,
    MAIL_ENGINE,
    DNS_RESOLVER,
    DKIM_PUBLISHER,
    COUNTER_STORE,
    SYSTEM_MAILER,
    RATE_LIMIT_STORE,
  ],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: pg.Pool,
    @Inject(MAIL_ENGINE) private readonly mailEngine: MailEngine,
    @Inject(DKIM_PUBLISHER) private readonly dkimPublisher: DkimPublisher,
    @Inject(COUNTER_STORE) private readonly counters: CounterStore,
    @Inject(RATE_LIMIT_STORE) private readonly rateLimits: RateLimitStore,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.mailEngine.close();
    await this.dkimPublisher.close();
    await this.rateLimits.close();
    await this.counters.close();
    await this.pool.end();
  }
}
