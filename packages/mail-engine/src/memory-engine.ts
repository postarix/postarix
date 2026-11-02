import {
  type JmapRequest,
  type CreateMailboxOptions,
  type EngineHealth,
  type MailboxUsage,
  type MailEngine,
  MailEngineError,
} from './types.js';

interface StoredMailbox {
  quotaBytes: number | null;
  usedBytes: number;
}

/**
 * In-memory engine for tests and for running the API without a mail server.
 * It keeps the same error semantics as the real engines.
 */
export class MemoryMailEngine implements MailEngine {
  readonly mailboxes = new Map<string, StoredMailbox>();
  /** When set, the next call fails with this error (to test rollbacks). */
  failNext: MailEngineError | null = null;
  /** Answers JMAP requests in tests; without it, JMAP is unavailable. */
  jmapHandler: ((address: string, request: JmapRequest) => Promise<Response>) | null = null;

  private checkFailure(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  private get(address: string): StoredMailbox {
    const mailbox = this.mailboxes.get(address);
    if (!mailbox) throw new MailEngineError(`Mailbox ${address} does not exist`, 'not_found');
    return mailbox;
  }

  async createMailbox(address: string, options: CreateMailboxOptions): Promise<void> {
    this.checkFailure();
    if (this.mailboxes.has(address)) {
      throw new MailEngineError(`Mailbox ${address} already exists`, 'already_exists');
    }
    this.mailboxes.set(address, { quotaBytes: options.quotaBytes, usedBytes: 0 });
  }

  async deleteMailbox(address: string): Promise<void> {
    this.checkFailure();
    this.get(address);
    this.mailboxes.delete(address);
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    this.checkFailure();
    const mailbox = this.get(from);
    if (this.mailboxes.has(to)) {
      throw new MailEngineError(`Mailbox ${to} already exists`, 'already_exists');
    }
    this.mailboxes.delete(from);
    this.mailboxes.set(to, mailbox);
  }

  async setQuota(address: string, quotaBytes: number | null): Promise<void> {
    this.checkFailure();
    this.get(address).quotaBytes = quotaBytes;
  }

  async getUsage(address: string): Promise<MailboxUsage> {
    this.checkFailure();
    const { usedBytes, quotaBytes } = this.get(address);
    return { usedBytes, quotaBytes };
  }

  async health(): Promise<EngineHealth> {
    return { ok: true };
  }

  async close(): Promise<void> {}

  async jmap(address: string, request: JmapRequest): Promise<Response> {
    this.checkFailure();
    this.get(address);
    if (!this.jmapHandler) throw new MailEngineError('The memory engine has no JMAP server', 'unavailable');
    return this.jmapHandler(address, request);
  }
}
