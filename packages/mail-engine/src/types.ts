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

/** An HTTP request to the engine's JMAP endpoint (RFC 8620), made on behalf of a mailbox owner. */
export interface JmapRequest {
  method: 'GET' | 'POST';
  /**
   * Path below the JMAP root, without a leading slash: "" for the session
   * resource and the API, "upload/<accountId>/", "download/…", "eventsource/".
   */
  path: string;
  /** Raw query string, without the leading "?". */
  query: string;
  contentType?: string | undefined;
  accept?: string | undefined;
  lastEventId?: string | undefined;
  body?: ReadableStream<Uint8Array> | Uint8Array | undefined;
  signal?: AbortSignal | undefined;
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
  /**
   * Performs a JMAP request as the owner of `address`. URLs inside responses
   * (the session resource) are the engine's own; callers rewrite them.
   */
  jmap(address: string, request: JmapRequest): Promise<Response>;
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
