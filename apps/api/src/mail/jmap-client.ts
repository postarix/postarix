import { ServiceUnavailableException } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';

export const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const USING = [
  'urn:ietf:params:jmap:core',
  MAIL_CAPABILITY,
  'urn:ietf:params:jmap:calendars',
  'https://cyrusimap.org/ns/jmap/calendars',
  'https://cyrusimap.org/ns/jmap/contacts',
];

export type MethodCall = [string, Record<string, unknown>, string];
export type MethodResponse = [string, Record<string, unknown>, string];

/**
 * Server-side JMAP for the API's own needs (sending, rendering, calendar
 * invitations and free/busy), always as
 * the owner of `address`, through the MailEngine.
 */
export class ServerJmap {
  private accountId: string | undefined;

  /**
   * Logs in as `address`; acts on `account` when given (a shared mailbox the
   * person may use: Cyrus checks their rights there), else on their own.
   */
  constructor(
    private readonly engine: MailEngine,
    readonly address: string,
    account?: string,
  ) {
    this.accountId = account;
  }

  async primaryAccount(): Promise<string> {
    if (this.accountId) return this.accountId;
    const res = await this.engine.jmap(this.address, { method: 'GET', path: '', query: '' });
    if (!res.ok) throw new ServiceUnavailableException('The mail server is unavailable');
    const session = (await res.json()) as { primaryAccounts?: Record<string, string> };
    const id = session.primaryAccounts?.[MAIL_CAPABILITY];
    if (!id) throw new ServiceUnavailableException('The mail server has no mail account for you');
    this.accountId = id;
    return id;
  }

  async call(methodCalls: MethodCall[]): Promise<MethodResponse[]> {
    const res = await this.engine.jmap(this.address, {
      method: 'POST',
      path: '',
      query: '',
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify({ using: USING, methodCalls })),
    });
    if (!res.ok) throw new ServiceUnavailableException('The mail server is unavailable');
    return ((await res.json()) as { methodResponses: MethodResponse[] }).methodResponses;
  }

  /** One method call; throws if the server answers with an error. */
  async single<T extends Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    const [response] = await this.call([[name, { accountId: await this.primaryAccount(), ...args }, '0']]);
    if (!response || response[0] === 'error') {
      throw new JmapMethodError(String(response?.[1].type ?? 'unknown'), name);
    }
    return response[1] as T;
  }

  /** Uploads data as a blob of the person's account; returns its id. */
  async upload(data: Uint8Array, type: string): Promise<string> {
    const accountId = await this.primaryAccount();
    const res = await this.engine.jmap(this.address, {
      method: 'POST',
      path: `upload/${encodeURIComponent(accountId)}/`,
      query: '',
      contentType: type,
      body: data,
    });
    if (!res.ok) throw new ServiceUnavailableException('The mail server is unavailable');
    const { blobId } = (await res.json()) as { blobId?: string };
    if (!blobId) throw new ServiceUnavailableException('The mail server is unavailable');
    return blobId;
  }

  /** Downloads a blob, refusing anything larger than `limit` bytes. */
  async download(blobId: string, limit: number): Promise<Buffer> {
    const accountId = await this.primaryAccount();
    const res = await this.engine.jmap(this.address, {
      method: 'GET',
      path: `download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/blob`,
      query: 'accept=application%2Foctet-stream',
    });
    if (!res.ok || !res.body) throw new ServiceUnavailableException('Could not read the message');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > limit) throw new BlobTooLargeError();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

export class JmapMethodError extends Error {
  constructor(
    readonly type: string,
    method: string,
  ) {
    super(`${method} failed: ${type}`);
  }
}

export class BlobTooLargeError extends Error {}
