export interface MailboxUsage {
  /** Bytes currently stored, or null when the engine does not track it (no quota set). */
  usedBytes: number | null;
  /** Quota in bytes, or null when unlimited. */
  quotaBytes: number | null;
}

export interface EngineHealth {
  ok: boolean;
  detail?: string;
}

export interface CreateMailboxOptions {
  /** Storage quota in bytes, or null for unlimited. */
  quotaBytes: number | null;
}

/**
 * Operations Postarix needs from the mailbox store. The API depends only on
 * this interface, so the engine (Cyrus today) can be swapped without changes.
 *
 * Addresses are full, lowercase ASCII email addresses ("alice@example.com").
 */
export interface MailEngine {
  createMailbox(address: string, options: CreateMailboxOptions): Promise<void>;
  deleteMailbox(address: string): Promise<void>;
  renameMailbox(from: string, to: string): Promise<void>;
  setQuota(address: string, quotaBytes: number | null): Promise<void>;
  getUsage(address: string): Promise<MailboxUsage>;
  health(): Promise<EngineHealth>;
  close(): Promise<void>;
}

/** Raised for engine failures that callers may want to report or retry. */
export class MailEngineError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'already_exists' | 'unavailable' | 'rejected',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MailEngineError';
  }
}
