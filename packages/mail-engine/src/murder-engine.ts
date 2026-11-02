import {
  type CollectionKind,
  type CollectionShare,
  type CreateMailboxOptions,
  type EngineHealth,
  type JmapRequest,
  type MailboxUsage,
  type MailEngine,
  MailEngineError,
  type SieveScriptInfo,
} from './types.js';

export interface MurderEngineOptions {
  /** The backends by name: each is the engine of one Cyrus backend. */
  backends: Record<string, MailEngine>;
  /** The backend a mailbox lives on (by address), or null if unknown. */
  locate: (address: string) => Promise<string | null>;
  /** Picks the backend for a new mailbox and records it; returns its name. */
  place: (address: string, backends: string[]) => Promise<string>;
  /**
   * How long frontends take to learn a new mailbox from the mupdate server
   * (about a second, more under load). Creating a mailbox waits this long, so that it can be
   * used through the frontends as soon as the call returns.
   */
  propagationMs?: number;
}

/**
 * Several Cyrus backends behind a Cyrus Murder: each mailbox lives on one
 * backend, which publishes it to the mupdate server so that the frontends
 * route IMAP, POP3, ManageSieve, DAV and LMTP to it. Postarix talks to the
 * backend itself for administration and JMAP: this engine finds it and
 * passes each call on.
 */
export class MurderEngine implements MailEngine {
  private readonly names: string[];

  constructor(private readonly options: MurderEngineOptions) {
    this.names = Object.keys(options.backends);
    if (this.names.length === 0) throw new Error('A Murder needs at least one backend');
  }

  private async backendOf(address: string): Promise<MailEngine> {
    const name = await this.options.locate(address);
    if (name === null) throw new MailEngineError(`Mailbox ${address} does not exist`, 'not_found');
    const backend = this.options.backends[name];
    if (!backend) throw new MailEngineError(`Mailbox ${address} is on an unknown backend: ${name}`, 'unavailable');
    return backend;
  }

  async createMailbox(address: string, options: CreateMailboxOptions): Promise<void> {
    const name = await this.options.place(address, this.names);
    const backend = this.options.backends[name];
    if (!backend) throw new MailEngineError(`Unknown backend: ${name}`, 'unavailable');
    await backend.createMailbox(address, options);
    const wait = this.options.propagationMs ?? 3_000;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  async deleteMailbox(address: string): Promise<void> {
    await (await this.backendOf(address)).deleteMailbox(address);
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    await (await this.backendOf(from)).renameMailbox(from, to);
  }

  async setQuota(address: string, quotaBytes: number | null): Promise<void> {
    await (await this.backendOf(address)).setQuota(address, quotaBytes);
  }

  async getUsage(address: string): Promise<MailboxUsage> {
    return (await this.backendOf(address)).getUsage(address);
  }

  async jmap(address: string, request: JmapRequest): Promise<Response> {
    return (await this.backendOf(address)).jmap(address, request);
  }

  async listSieveScripts(address: string): Promise<SieveScriptInfo[]> {
    return (await this.backendOf(address)).listSieveScripts(address);
  }

  async readSieveScript(address: string, name: string): Promise<string | null> {
    return (await this.backendOf(address)).readSieveScript(address, name);
  }

  async writeSieveScript(address: string, name: string, content: string, options: { activate: boolean }): Promise<void> {
    await (await this.backendOf(address)).writeSieveScript(address, name, content, options);
  }

  async deleteSieveScript(address: string, name: string): Promise<void> {
    await (await this.backendOf(address)).deleteSieveScript(address, name);
  }

  async listShares(address: string, kind: CollectionKind, collectionId: string): Promise<CollectionShare[]> {
    return (await this.backendOf(address)).listShares(address, kind, collectionId);
  }

  async setShares(address: string, kind: CollectionKind, collectionId: string, shares: CollectionShare[]): Promise<void> {
    await (await this.backendOf(address)).setShares(address, kind, collectionId, shares);
  }

  async restrictCollections(address: string): Promise<void> {
    await (await this.backendOf(address)).restrictCollections(address);
  }

  /** Healthy when every backend is. */
  async health(): Promise<EngineHealth> {
    const results = await Promise.all(this.names.map(async (name) => [name, await this.options.backends[name]!.health()] as const));
    const failing = results.filter(([, h]) => !h.ok);
    if (failing.length === 0) return { ok: true };
    return { ok: false, detail: failing.map(([name, h]) => `${name}: ${h.detail ?? 'unavailable'}`).join('; ') };
  }

  async close(): Promise<void> {
    await Promise.all(this.names.map((name) => this.options.backends[name]!.close()));
  }
}
