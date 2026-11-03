import { Redis } from 'ioredis';

/** What Rspamd records about a message it refused (see rspamd.local.lua, POSTARIX_QUARANTINE). */
export interface QuarantinedMessage {
  /** Where the message itself waits in Valkey. */
  key: string;
  envelopeFrom: string;
  fromHeader: string;
  subject: string;
  score: number;
  symbols: string[];
  recipients: string[];
}

export const QUARANTINE_LIST = 'POSTARIX_QUARANTINE_NEW';

/** Where refused messages wait until the API files them. */
export interface QuarantineSource {
  /** Takes up to `count` waiting messages (oldest first), with their content (null if it expired). */
  take(count: number): Promise<{ meta: QuarantinedMessage; raw: Buffer | null }[]>;
  close(): Promise<void>;
}

export class ValkeyQuarantineSource implements QuarantineSource {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }

  async take(count: number): Promise<{ meta: QuarantinedMessage; raw: Buffer | null }[]> {
    const out: { meta: QuarantinedMessage; raw: Buffer | null }[] = [];
    for (let i = 0; i < count; i++) {
      const item = await this.client.lpop(QUARANTINE_LIST);
      if (!item) break;
      let meta: QuarantinedMessage;
      try {
        meta = JSON.parse(item) as QuarantinedMessage;
      } catch {
        continue;
      }
      if (typeof meta.key !== 'string' || !meta.key.startsWith('POSTARIX_QUARANTINE:')) continue;
      const raw = await this.client.getBuffer(meta.key);
      await this.client.del(meta.key);
      out.push({ meta, raw });
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}

export class MemoryQuarantineSource implements QuarantineSource {
  readonly waiting: { meta: QuarantinedMessage; raw: Buffer | null }[] = [];

  async take(count: number): Promise<{ meta: QuarantinedMessage; raw: Buffer | null }[]> {
    return this.waiting.splice(0, count);
  }

  async close(): Promise<void> {}
}
