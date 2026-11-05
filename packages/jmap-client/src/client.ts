import { CAPABILITIES, type Id, type Invocation, type MethodError, type ResultReference, type Session } from './types';

export class JmapRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JmapRequestError';
  }
}

/** A method call answered with an error (RFC 8620 §3.6.2). */
export class JmapMethodError extends Error {
  constructor(
    readonly method: string,
    readonly error: MethodError,
  ) {
    super(`${method}: ${error.type}${error.description ? ` (${error.description})` : ''}`);
    this.name = 'JmapMethodError';
  }
}

export interface ClientOptions {
  /** Session resource URL, e.g. "/api/jmap/". */
  sessionUrl: string;
  fetch?: typeof fetch;
}

/** Builds a request with several method calls; later calls can reference earlier results. */
export class RequestBuilder {
  readonly calls: Invocation[] = [];
  private counter = 0;

  /** Adds a call and returns its id, for back-references. */
  add(name: string, args: Record<string, unknown>): string {
    const id = `c${this.counter++}`;
    this.calls.push([name, args, id]);
    return id;
  }

  /** A back-reference to `path` in the result of call `callId` (named `name`). */
  ref(callId: string, name: string, path: string): ResultReference {
    return { resultOf: callId, name, path };
  }
}

/**
 * Minimal JMAP client: the session, batched method calls, uploads and URLs for
 * downloads and push events. Cookies authenticate (same origin).
 */
export class JmapClient {
  private sessionPromise: Promise<Session> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  session(refresh = false): Promise<Session> {
    if (!this.sessionPromise || refresh) {
      this.sessionPromise = this.request(this.options.sessionUrl, { method: 'GET' }).then((r) => r.json() as Promise<Session>);
      this.sessionPromise.catch(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }

  async accountId(capability: string = CAPABILITIES.mail): Promise<Id> {
    const id = (await this.session()).primaryAccounts[capability];
    if (!id) throw new JmapRequestError(0, `No account for ${capability}`);
    return id;
  }

  /**
   * Sends the calls of `build` in one request. Returns the responses by call
   * id; throws JmapMethodError if any call failed.
   */
  async batch(build: (b: RequestBuilder) => void, using: string[] = [CAPABILITIES.core, CAPABILITIES.mail]): Promise<Map<string, Record<string, unknown>>> {
    const builder = new RequestBuilder();
    build(builder);
    const session = await this.session();
    const response = await this.request(session.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ using, methodCalls: builder.calls }),
    });
    const { methodResponses } = (await response.json()) as { methodResponses: Invocation[] };
    const results = new Map<string, Record<string, unknown>>();
    for (const [name, args, id] of methodResponses) {
      if (name === 'error') {
        const call = builder.calls.find((c) => c[2] === id);
        throw new JmapMethodError(call?.[0] ?? 'unknown', args as unknown as MethodError);
      }
      // A method may return several responses (e.g. implicit calls); keep the first.
      if (!results.has(id)) results.set(id, args);
    }
    return results;
  }

  /** One method call on the primary mail account (whose id is also the calendar and contacts account in Cyrus). */
  async call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
    using: string[] = [CAPABILITIES.core, CAPABILITIES.mail],
  ): Promise<T> {
    const accountId = await this.accountId();
    const results = await this.batch((b) => b.add(name, { accountId, ...args }), using);
    return results.get('c0') as T;
  }

  /** Uploads a file (to the primary mail account, or `accountId`); returns its blob id. */
  async upload(file: Blob, accountId?: Id): Promise<{ blobId: Id; type: string; size: number }> {
    const session = await this.session();
    const url = session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId ?? (await this.accountId())));
    const response = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    return (await response.json()) as { blobId: Id; type: string; size: number };
  }

  async downloadUrl(blobId: Id, name: string, type = 'application/octet-stream', accountId?: Id): Promise<string> {
    const session = await this.session();
    return session.downloadUrl
      .replace('{accountId}', encodeURIComponent(accountId ?? (await this.accountId())))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name))
      .replace('{type}', encodeURIComponent(type));
  }

  async eventSourceUrl(types: string[] = ['*']): Promise<string> {
    const session = await this.session();
    return session.eventSourceUrl
      .replace('{types}', types.join(','))
      .replace('{closeafter}', 'no')
      .replace('{ping}', '60');
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(url, { credentials: 'same-origin', ...init });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = (await response.json()) as { message?: string; detail?: string };
        message = body.message ?? body.detail ?? message;
      } catch {
        // not JSON
      }
      throw new JmapRequestError(response.status, message);
    }
    return response;
  }
}
