import { Redis } from 'ioredis';

/** Valkey hashes Rspamd reads (see rspamd.local.lua, POSTARIX_SPAM_*). */
export const SPAM_SCORES_HASH = 'POSTARIX_SPAM_SCORES';
export const SPAM_LISTS_HASH = 'POSTARIX_SPAM_LISTS';

/** Fields of Valkey hashes, written whole or one at a time. */
export interface HashStore {
  set(hash: string, field: string, value: string | null): Promise<void>;
  replaceAll(hash: string, values: Map<string, string>): Promise<void>;
  close(): Promise<void>;
}

export class ValkeyHashStore implements HashStore {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }

  async set(hash: string, field: string, value: string | null): Promise<void> {
    if (value === null) await this.client.hdel(hash, field);
    else await this.client.hset(hash, field, value);
  }

  async replaceAll(hash: string, values: Map<string, string>): Promise<void> {
    const pipeline = this.client.multi().del(hash);
    if (values.size > 0) pipeline.hset(hash, Object.fromEntries(values));
    await pipeline.exec();
  }

  async close(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}

export class MemoryHashStore implements HashStore {
  readonly hashes = new Map<string, Map<string, string>>();

  private hash(name: string): Map<string, string> {
    let hash = this.hashes.get(name);
    if (!hash) {
      hash = new Map();
      this.hashes.set(name, hash);
    }
    return hash;
  }

  async set(hash: string, field: string, value: string | null): Promise<void> {
    if (value === null) this.hash(hash).delete(field);
    else this.hash(hash).set(field, value);
  }

  async replaceAll(hash: string, values: Map<string, string>): Promise<void> {
    this.hashes.set(hash, new Map(values));
  }

  async close(): Promise<void> {}
}
