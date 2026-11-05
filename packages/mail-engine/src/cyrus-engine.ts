import net from 'node:net';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  type ImapConnectOptions,
  ImapConnection,
  ImapProtocolError,
  type ImapResponse,
  quote,
} from './imap-connection.js';
import {
  type JmapRequest,
  type CreateMailboxOptions,
  type EngineHealth,
  type MailboxUsage,
  type MailEngine,
  MailEngineError,
  type SieveScriptInfo,
  type CollectionKind,
  type CollectionShare,
  type ShareAccess,
  type MailboxAccess,
  type MailboxAccessLevel,
  type MailboxAccessState,
} from './types.js';

export interface CyrusEngineOptions extends ImapConnectOptions {
  adminUser: string;
  adminPassword: string;
  /**
   * Cyrus' internal JMAP service. Requests log in as the mailbox owner, with
   * a password the caller provides (Postarix mints short-lived tokens that its
   * login bridge accepts).
   */
  jmap?: { url: string; password: (address: string) => string } | undefined;
}

const ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+$/;

/** Folders every new mailbox gets, with their RFC 6154 special-use attribute. */
export const DEFAULT_FOLDERS = [
  ['Drafts', '\\Drafts'],
  ['Sent', '\\Sent'],
  ['Trash', '\\Trash'],
  ['Junk', '\\Junk'],
  ['Archive', '\\Archive'],
] as const;

/**
 * MailEngine backed by Cyrus IMAP. Cyrus must run with `virtdomains: userid`
 * and `unixhierarchysep: yes`, so a user's mailbox is named "user/<address>".
 *
 * Each operation opens a short-lived admin connection: provisioning is rare,
 * and this avoids managing a long-lived session that the server may drop.
 */
/**
 * Cyrus ACL rights for shared collections: the same rights Cyrus' own JMAP
 * sharing (Calendar shareWith) grants. "9" is reading free/busy.
 */
export const SHARE_RIGHTS: Record<CollectionKind, Record<ShareAccess, string>> = {
  calendar: { read: 'lrw9', write: 'lrswitedn5679' },
  addressbook: { read: 'lrs', write: 'lrswitedn' },
};
/** Cyrus' per-folder switch for one seen state shared by everyone. */
const SHARED_SEEN = '/shared/vendor/cmu/cyrus-imapd/sharedseen';

/**
 * Cyrus ACL rights for people other than the owner, on every mail folder.
 * Reading: look up and read; with per-person seen state also keep their own
 * (s); with one shared state, readers do not change it. Changing: also seen,
 * flags, filing in, deleting and expunging (no folder creation, no admin).
 */
export function accessRights(level: MailboxAccessLevel, sharedSeen: boolean): string {
  if (level === 'readWrite') return 'lrswitedn';
  return sharedSeen ? 'lr' : 'lrs';
}

const COLLECTION_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
const COLLECTION_FOLDER: Record<CollectionKind, string> = { calendar: '#calendars', addressbook: '#addressbooks' };

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_SIEVE = 'https://cyrusimap.org/ns/jmap/sieve';
const JMAP_BLOB = 'https://cyrusimap.org/ns/jmap/blob';

export class CyrusEngine implements MailEngine {
  constructor(private readonly options: CyrusEngineOptions) {}

  private agent: { ca: string | undefined; agent: Agent } | undefined;

  /**
   * TLS for the internal JMAP service, checked like the admin IMAP
   * connection: the expected name (servername) and the extra trusted
   * certificate. A new agent is made when the certificate file changes.
   */
  private jmapAgent(): Agent {
    const ca = this.options.ca?.();
    if (this.agent && this.agent.ca === ca) return this.agent.agent;
    void this.agent?.agent.close();
    const name = this.options.servername;
    const agent = new Agent({
      connect: {
        rejectUnauthorized: this.options.rejectUnauthorized ?? true,
        ...(name && !net.isIP(name) ? { servername: name } : {}),
        ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}),
        ...(name ? { checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(name, cert) } : {}),
      },
    });
    this.agent = { ca, agent };
    return agent;
  }

  static mailboxName(address: string): string {
    if (!ADDRESS.test(address)) {
      throw new MailEngineError(`Invalid mailbox address: ${address}`, 'rejected');
    }
    return `user/${address}`;
  }

  /** Name of a folder inside a user's mailbox: "user/alice/Sent@example.com" under virtdomains. */
  static folderName(address: string, folder: string): string {
    CyrusEngine.mailboxName(address);
    const at = address.lastIndexOf('@');
    return `user/${address.slice(0, at)}/${folder}${address.slice(at)}`;
  }

  private async withAdmin<T>(run: (connection: ImapConnection) => Promise<T>, timeoutMs?: number): Promise<T> {
    let connection: ImapConnection | undefined;
    try {
      connection = await ImapConnection.connect(timeoutMs ? { ...this.options, timeoutMs } : this.options);
      await connection.login(this.options.adminUser, this.options.adminPassword);
    } catch (error) {
      connection?.destroy();
      throw new MailEngineError('Cannot reach the Cyrus admin interface', 'unavailable', {
        cause: error,
      });
    }
    const admin = connection;
    try {
      return await run(admin);
    } catch (error) {
      throw toEngineError(error);
    } finally {
      await admin.logout();
    }
  }

  async createMailbox(address: string, options: CreateMailboxOptions): Promise<void> {
    const name = quote(CyrusEngine.mailboxName(address));
    await this.withAdmin(async (imap) => {
      await imap.expectOk(`CREATE ${name}`);
      try {
        for (const [folder, use] of DEFAULT_FOLDERS) {
          await imap.expectOk(`CREATE ${quote(CyrusEngine.folderName(address, folder))} (USE (${use}))`);
        }
        // Spam is delivered to user+Junk@domain: Cyrus files "+Junk" into this
        // folder only if the delivering party ("anyone" over LMTP) may post there.
        await imap.expectOk(`SETACL ${quote(CyrusEngine.folderName(address, 'Junk'))} anyone p`);
        if (options.quotaBytes !== null) await imap.expectOk(`SETQUOTA ${name} ${storage(options.quotaBytes)}`);
      } catch (error) {
        // Never leave a half-created mailbox behind: it would block the address.
        // A fresh connection is used in case this one is what failed.
        await this.deleteMailbox(address).catch(() => undefined);
        throw error;
      }
    });
  }

  async deleteMailbox(address: string): Promise<void> {
    const name = quote(CyrusEngine.mailboxName(address));
    await this.withAdmin(async (imap) => {
      // Admins need the "x" right on a user's mailbox before they can delete it.
      await imap.expectOk(`SETACL ${name} ${quote(this.options.adminUser)} lrswipkxtecdan`);
      await imap.expectOk(`DELETE ${name}`);
    });
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    const source = quote(CyrusEngine.mailboxName(from));
    const target = quote(CyrusEngine.mailboxName(to));
    await this.withAdmin((imap) => imap.expectOk(`RENAME ${source} ${target}`).then(() => undefined));
  }

  /**
   * Cyrus Murder: moves a user's whole mailbox (folders, calendars, contacts,
   * Sieve scripts) from this backend to another one, named as the Murder
   * knows it. The backends log in to each other for it (postarix-xfer). It
   * can take a while for a large mailbox.
   */
  async transfer(address: string, server: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(server)) throw new MailEngineError(`Invalid server name: ${server}`, 'rejected');
    const name = quote(CyrusEngine.mailboxName(address));
    await this.withAdmin(async (imap) => {
      const response = await imap.expectOk(`XFER ${name} ${quote(server)}`);
      // Cyrus answers OK overall and reports each user it could not move on its own line.
      const failed = response.untagged.find((line) => /^NO (USER|MAILBOX) /i.test(line));
      if (failed) throw new MailEngineError(`The mailbox was not moved: ${failed.slice(3)}`, 'rejected');
    }, 60 * 60_000);
  }

  async setQuota(address: string, quotaBytes: number | null): Promise<void> {
    const name = quote(CyrusEngine.mailboxName(address));
    await this.withAdmin((imap) =>
      imap.expectOk(`SETQUOTA ${name} ${quotaBytes === null ? '()' : storage(quotaBytes)}`).then(() => undefined),
    );
  }

  async getUsage(address: string): Promise<MailboxUsage> {
    const name = CyrusEngine.mailboxName(address);
    return this.withAdmin(async (imap) => {
      const response = await imap.expectOk(`GETQUOTAROOT ${quote(name)}`);
      return parseQuota(response);
    });
  }

  async jmap(address: string, request: JmapRequest): Promise<Response> {
    const jmap = this.options.jmap;
    if (!jmap) throw new MailEngineError('JMAP is not configured', 'unavailable');
    CyrusEngine.mailboxName(address); // validates the address
    const url = jmapUrl(jmap.url, request.path, request.query);

    const headers = new Headers({
      authorization: `Basic ${Buffer.from(`${address}:${jmap.password(address)}`).toString('base64')}`,
      // Internal hop: compression only costs CPU, and the response is streamed on.
      'accept-encoding': 'identity',
    });
    if (request.contentType) headers.set('content-type', request.contentType);
    if (request.accept) headers.set('accept', request.accept);
    if (request.lastEventId) headers.set('last-event-id', request.lastEventId);

    try {
      return (await undiciFetch(url, {
        method: request.method,
        headers,
        redirect: 'manual',
        ...(request.body ? { body: request.body, duplex: 'half' } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(url.protocol === 'https:' ? { dispatcher: this.jmapAgent() } : {}),
      } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new MailEngineError('Cannot reach the Cyrus JMAP service', 'unavailable', { cause: error });
    }
  }

  // --- Sieve, through Cyrus' JMAP sieve extension, as the mailbox owner ------

  private async sieveSession(address: string): Promise<string> {
    const res = await this.jmap(address, { method: 'GET', path: '', query: '' });
    if (!res.ok) throw new MailEngineError(`Cyrus JMAP answered ${res.status}`, 'unavailable');
    const session = (await res.json()) as { primaryAccounts?: Record<string, string> };
    const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!accountId) throw new MailEngineError(`No mail account for ${address}`, 'not_found');
    return accountId;
  }

  private async sieveCall(address: string, calls: [string, Record<string, unknown>, string][]) {
    const res = await this.jmap(address, {
      method: 'POST',
      path: '',
      query: '',
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify({ using: [JMAP_CORE, JMAP_SIEVE, JMAP_BLOB], methodCalls: calls })),
    });
    if (!res.ok) throw new MailEngineError(`Cyrus JMAP answered ${res.status}`, 'unavailable');
    const body = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
    for (const [name, args] of body.methodResponses) {
      if (name === 'error') throw new MailEngineError(`Sieve request failed: ${String(args.type)}`, 'rejected');
    }
    return body.methodResponses;
  }

  private async sieveScripts(address: string, accountId: string) {
    const result = (await this.sieveCall(address, [['SieveScript/get', { accountId }, 'g']]))[0]?.[1] ?? {};
    return (result.list as { id: string; name: string; isActive: boolean; blobId: string }[]) ?? [];
  }

  async listSieveScripts(address: string): Promise<SieveScriptInfo[]> {
    const accountId = await this.sieveSession(address);
    return (await this.sieveScripts(address, accountId)).map((s) => ({ name: s.name, active: s.isActive }));
  }

  async readSieveScript(address: string, name: string): Promise<string | null> {
    const accountId = await this.sieveSession(address);
    const script = (await this.sieveScripts(address, accountId)).find((s) => s.name === name);
    if (!script) return null;
    const res = await this.jmap(address, {
      method: 'GET',
      path: `download/${encodeURIComponent(accountId)}/${encodeURIComponent(script.blobId)}/script`,
      query: 'accept=application%2Fsieve',
    });
    if (!res.ok) throw new MailEngineError(`Cannot read the Sieve script (${res.status})`, 'unavailable');
    return res.text();
  }

  async writeSieveScript(address: string, name: string, content: string, options: { activate: boolean }): Promise<void> {
    const accountId = await this.sieveSession(address);
    const upload = await this.jmap(address, {
      method: 'POST',
      path: `upload/${encodeURIComponent(accountId)}/`,
      query: '',
      contentType: 'application/sieve',
      body: new TextEncoder().encode(content),
    });
    if (!upload.ok) throw new MailEngineError(`Cannot upload the Sieve script (${upload.status})`, 'unavailable');
    const { blobId } = (await upload.json()) as { blobId: string };
    const existing = (await this.sieveScripts(address, accountId)).find((s) => s.name === name);
    const args: Record<string, unknown> = existing
      ? { accountId, update: { [existing.id]: { blobId } } }
      : { accountId, create: { s: { name, blobId } } };
    if (options.activate) args.onSuccessActivateScript = existing ? existing.id : '#s';
    const result = (await this.sieveCall(address, [['SieveScript/set', args, 's']]))[0]?.[1] ?? {};
    const failed = (result.notCreated ?? result.notUpdated) as Record<string, { type?: string; description?: string }> | null;
    const problem = failed ? Object.values(failed)[0] : undefined;
    if (problem) throw new MailEngineError(`Sieve script rejected: ${problem.description ?? problem.type ?? 'invalid'}`, 'rejected');
  }

  async deleteSieveScript(address: string, name: string): Promise<void> {
    const accountId = await this.sieveSession(address);
    const existing = (await this.sieveScripts(address, accountId)).find((s) => s.name === name);
    if (!existing) return;
    // An active script cannot be destroyed: deactivate it first.
    if (existing.isActive) await this.sieveCall(address, [['SieveScript/set', { accountId, onSuccessDeactivateScript: true }, 'd']]);
    await this.sieveCall(address, [['SieveScript/set', { accountId, destroy: [existing.id] }, 'x']]);
  }

  private collectionName(address: string, kind: CollectionKind, collectionId: string): string {
    if (!COLLECTION_ID.test(collectionId)) throw new MailEngineError(`Invalid collection: ${collectionId}`, 'not_found');
    return CyrusEngine.folderName(address, `${COLLECTION_FOLDER[kind]}/${collectionId}`);
  }

  async listShares(address: string, kind: CollectionKind, collectionId: string): Promise<CollectionShare[]> {
    const name = this.collectionName(address, kind, collectionId);
    return this.withAdmin(async (imap) => {
      const acl = parseAcl((await imap.expectOk(`GETACL ${quote(name)}`)).untagged);
      return sharesFromAcl(acl, address, this.options.adminUser);
    });
  }

  async setShares(address: string, kind: CollectionKind, collectionId: string, shares: CollectionShare[]): Promise<void> {
    const name = this.collectionName(address, kind, collectionId);
    for (const share of shares) {
      if (!ADDRESS.test(share.grantee) || share.grantee === address) {
        throw new MailEngineError(`Cannot share with ${share.grantee}`, 'rejected');
      }
    }
    await this.withAdmin(async (imap) => {
      const acl = parseAcl((await imap.expectOk(`GETACL ${quote(name)}`)).untagged);
      const wanted = new Map(shares.map((s) => [s.grantee, SHARE_RIGHTS[kind][s.access]]));
      for (const identifier of acl.keys()) {
        if (identifier === address || identifier === this.options.adminUser || wanted.has(identifier)) continue;
        await imap.expectOk(`DELETEACL ${quote(name)} ${quote(identifier)}`);
      }
      for (const [grantee, rights] of wanted) {
        if (acl.get(grantee) !== rights) await imap.expectOk(`SETACL ${quote(name)} ${quote(grantee)} ${rights}`);
      }
    });
  }

  async removeGrantee(address: string, grantee: string): Promise<void> {
    if (!ADDRESS.test(grantee)) throw new MailEngineError(`Invalid address: ${grantee}`, 'rejected');
    await this.withAdmin(async (imap) => {
      for (const name of await this.collections(imap, address)) {
        const acl = parseAcl((await imap.expectOk(`GETACL ${quote(name)}`)).untagged);
        if (acl.has(grantee)) await imap.expectOk(`DELETEACL ${quote(name)} ${quote(grantee)}`);
      }
    });
  }

  /** The mailbox's mail folders (Cyrus names): its INBOX and every folder below, but not calendars, contacts and other "#" stores. */
  private async mailFolders(imap: ImapConnection, address: string): Promise<string[]> {
    const at = address.lastIndexOf('@');
    const pattern = `user/${address.slice(0, at)}/*${address.slice(at)}`;
    const below = parseList((await imap.expectOk(`LIST "" ${quote(pattern)}`)).untagged).filter((n) => !/\/#/.test(n));
    return [CyrusEngine.mailboxName(address), ...below];
  }

  async getMailboxAccess(address: string): Promise<MailboxAccessState> {
    const name = CyrusEngine.mailboxName(address);
    return this.withAdmin(async (imap) => {
      const acl = parseAcl((await imap.expectOk(`GETACL ${quote(name)}`)).untagged);
      const access: MailboxAccess[] = [];
      for (const [identifier, rights] of acl) {
        if (identifier === address || identifier === this.options.adminUser || !ADDRESS.test(identifier)) continue;
        if (!rights.includes('r')) continue;
        access.push({ grantee: identifier, level: /[wite]/.test(rights) ? 'readWrite' : 'read' });
      }
      const metadata = await imap.expectOk(`GETMETADATA ${quote(name)} ${quote(SHARED_SEEN)}`);
      const sharedSeen = metadata.untagged.some((line) => /sharedseen"?\s+"?true/i.test(line));
      return { access: access.sort((a, b) => a.grantee.localeCompare(b.grantee)), sharedSeen };
    });
  }

  async setMailboxAccess(address: string, state: MailboxAccessState): Promise<{ reduced: string[] }> {
    CyrusEngine.mailboxName(address);
    for (const entry of state.access) {
      if (!ADDRESS.test(entry.grantee) || entry.grantee === address) throw new MailEngineError(`Cannot give access to ${entry.grantee}`, 'rejected');
    }
    const wanted = new Map(state.access.map((a) => [a.grantee, accessRights(a.level, state.sharedSeen)]));
    const reduced = new Set<string>();
    await this.withAdmin(async (imap) => {
      for (const name of await this.mailFolders(imap, address)) {
        const acl = parseAcl((await imap.expectOk(`GETACL ${quote(name)}`)).untagged);
        for (const [identifier, rights] of acl) {
          if (identifier === address || identifier === this.options.adminUser || !ADDRESS.test(identifier)) continue;
          const next = wanted.get(identifier);
          if (next === undefined) {
            await imap.expectOk(`DELETEACL ${quote(name)} ${quote(identifier)}`);
            reduced.add(identifier);
          } else if ([...rights].some((right) => !next.includes(right))) {
            reduced.add(identifier);
          }
        }
        for (const [grantee, rights] of wanted) {
          if (acl.get(grantee) !== rights) await imap.expectOk(`SETACL ${quote(name)} ${quote(grantee)} ${rights}`);
        }
        await imap.expectOk(`SETMETADATA ${quote(name)} (${quote(SHARED_SEEN)} ${quote(state.sharedSeen ? 'true' : 'false')})`);
      }
    });
    return { reduced: [...reduced].sort() };
  }

  /** The mailbox's calendar and address book folders (Cyrus names). */
  private async collections(imap: ImapConnection, address: string): Promise<string[]> {
    const at = address.lastIndexOf('@');
    const pattern = `user/${address.slice(0, at)}/*${address.slice(at)}`;
    return parseList((await imap.expectOk(`LIST "" ${quote(pattern)}`)).untagged).filter((n) => /\/#(?:calendars|addressbooks)(?:\/|@)/.test(n));
  }

  async restrictCollections(address: string): Promise<void> {
    // Cyrus creates the default calendar and address book on first use.
    if (this.options.jmap) {
      const res = await this.jmap(address, {
        method: 'POST',
        path: '',
        query: '',
        contentType: 'application/json',
        body: new TextEncoder().encode(
          JSON.stringify({
            using: [JMAP_CORE, 'urn:ietf:params:jmap:calendars', 'https://cyrusimap.org/ns/jmap/contacts'],
            methodCalls: [
              ['Calendar/get', { accountId: address, properties: ['id'] }, 'c'],
              ['Contact/query', { accountId: address, limit: 1 }, 'a'],
            ],
          }),
        ),
      });
      await res.body?.cancel();
    }
    await this.withAdmin(async (imap) => {
      for (const name of await this.collections(imap, address)) {
        const acl = parseAcl((await imap.expectOk(`GETACL ${quote(name)}`)).untagged);
        for (const identifier of acl.keys()) {
          if (identifier === 'anyone' || identifier === 'anonymous') await imap.expectOk(`DELETEACL ${quote(name)} ${quote(identifier)}`);
        }
      }
    });
  }

  async health(): Promise<EngineHealth> {
    try {
      await this.withAdmin((imap) => imap.expectOk('NOOP'));
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    await this.agent?.agent.close();
  }
}

/**
 * Builds the URL of a JMAP resource below "<base>/jmap/", refusing anything
 * that could climb out of it (dot segments, also percent-encoded).
 */
export function jmapUrl(base: string, path: string, query: string): URL {
  const hasControlOrSpace = [...path].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f);
  if (path.startsWith('/') || path.includes('\\') || path.includes('?') || path.includes('#') || hasControlOrSpace) {
    throw new MailEngineError('Invalid JMAP path', 'rejected');
  }
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new MailEngineError('Invalid JMAP path', 'rejected');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
      throw new MailEngineError('Invalid JMAP path', 'rejected');
    }
  }
  const root = new URL('/jmap/', base);
  const url = new URL(path, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new MailEngineError('Invalid JMAP path', 'rejected');
  }
  url.search = query;
  return url;
}

function storage(quotaBytes: number): string {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
    throw new MailEngineError('Quota must be a positive number of bytes', 'rejected');
  }
  // IMAP QUOTA counts STORAGE in units of 1024 octets.
  return `(STORAGE ${Math.ceil(quotaBytes / 1024)})`;
}

/** Extracts STORAGE usage/limit (in KiB) from QUOTA untagged responses. */
export function parseQuota(response: ImapResponse): MailboxUsage {
  for (const line of response.untagged) {
    const match = /^QUOTA .*\(.*\bSTORAGE (\d+) (\d+)/i.exec(line);
    if (match) {
      return { usedBytes: Number(match[1]) * 1024, quotaBytes: Number(match[2]) * 1024 };
    }
  }
  // No quota root: Cyrus does not track usage, and the mailbox is unlimited.
  return { usedBytes: null, quotaBytes: null };
}

/** Splits an untagged IMAP response into atoms and quoted strings. */
function tokens(line: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]!);
  }
  return out;
}

/** "ACL <mailbox> <id> <rights> …" → id → rights. */
export function parseAcl(untagged: string[]): Map<string, string> {
  const acl = new Map<string, string>();
  for (const line of untagged) {
    const parts = tokens(line);
    if (parts[0]?.toUpperCase() !== 'ACL') continue;
    for (let i = 2; i + 1 < parts.length; i += 2) acl.set(parts[i]!, parts[i + 1]!);
  }
  return acl;
}

/** Mailbox names from "LIST (<flags>) <delimiter> <name>" responses. */
function parseList(untagged: string[]): string[] {
  return untagged.flatMap((line) => {
    const match = /^LIST \([^)]*\) (?:"[^"]*"|NIL) (.+)$/i.exec(line);
    return match ? [tokens(match[1]!)[0]!] : [];
  });
}

export function sharesFromAcl(acl: Map<string, string>, owner: string, admin: string): CollectionShare[] {
  const shares: CollectionShare[] = [];
  for (const [identifier, rights] of acl) {
    if (identifier === owner || identifier === admin || !ADDRESS.test(identifier)) continue;
    if (rights.includes('i')) shares.push({ grantee: identifier, access: 'write' });
    else if (rights.includes('r')) shares.push({ grantee: identifier, access: 'read' });
  }
  return shares.sort((a, b) => a.grantee.localeCompare(b.grantee));
}

function toEngineError(error: unknown): MailEngineError {
  if (error instanceof MailEngineError) return error;
  if (error instanceof ImapProtocolError && error.response) {
    const text = error.response.text;
    if (/\[ALREADYEXISTS\]|already exists/i.test(text)) {
      return new MailEngineError(error.message, 'already_exists', { cause: error });
    }
    if (/\[NONEXISTENT\]|does not exist|not found/i.test(text)) {
      return new MailEngineError(error.message, 'not_found', { cause: error });
    }
    return new MailEngineError(error.message, 'rejected', { cause: error });
  }
  return new MailEngineError('Cyrus admin operation failed', 'unavailable', { cause: error });
}
