import { Redis } from 'ioredis';

/**
 * Where Rspamd reads signing keys from. Rspamd's dkim_signing module looks up
 * the selector for a domain in the DKIM_SELECTORS hash, then the private key
 * for "<selector>.<domain>" in the DKIM_KEYS hash.
 */
export interface DkimPublisher {
  publish(domain: string, selector: string, privateKeyPem: string): Promise<void>;
  unpublish(domain: string): Promise<void>;
  /** Domains currently published (used to clean up after missed events). */
  publishedDomains(): Promise<string[]>;
  close(): Promise<void>;
}

export const DKIM_SELECTORS_HASH = 'DKIM_SELECTORS';
export const DKIM_KEYS_HASH = 'DKIM_KEYS';

export class ValkeyDkimPublisher implements DkimPublisher {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }

  async publish(domain: string, selector: string, privateKeyPem: string): Promise<void> {
    const previous = await this.client.hget(DKIM_SELECTORS_HASH, domain);
    const pipeline = this.client
      .multi()
      .hset(DKIM_KEYS_HASH, `${selector}.${domain}`, privateKeyPem)
      .hset(DKIM_SELECTORS_HASH, domain, selector);
    if (previous && previous !== selector) pipeline.hdel(DKIM_KEYS_HASH, `${previous}.${domain}`);
    await pipeline.exec();
  }

  async unpublish(domain: string): Promise<void> {
    const selector = await this.client.hget(DKIM_SELECTORS_HASH, domain);
    const pipeline = this.client.multi().hdel(DKIM_SELECTORS_HASH, domain);
    if (selector) pipeline.hdel(DKIM_KEYS_HASH, `${selector}.${domain}`);
    await pipeline.exec();
  }

  publishedDomains(): Promise<string[]> {
    return this.client.hkeys(DKIM_SELECTORS_HASH);
  }

  async close(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}

/** Keeps published keys in memory (tests, or running without Valkey in development). */
export class MemoryDkimPublisher implements DkimPublisher {
  readonly selectors = new Map<string, string>();
  readonly keys = new Map<string, string>();

  async publish(domain: string, selector: string, privateKeyPem: string): Promise<void> {
    const previous = this.selectors.get(domain);
    if (previous) this.keys.delete(`${previous}.${domain}`);
    this.selectors.set(domain, selector);
    this.keys.set(`${selector}.${domain}`, privateKeyPem);
  }

  async unpublish(domain: string): Promise<void> {
    const selector = this.selectors.get(domain);
    if (selector) this.keys.delete(`${selector}.${domain}`);
    this.selectors.delete(domain);
  }

  async publishedDomains(): Promise<string[]> {
    return [...this.selectors.keys()];
  }

  async close(): Promise<void> {}
}
