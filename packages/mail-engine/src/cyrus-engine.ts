import {
  type ImapConnectOptions,
  ImapConnection,
  ImapProtocolError,
  type ImapResponse,
  quote,
} from './imap-connection.js';
import {
  type CreateMailboxOptions,
  type EngineHealth,
  type MailboxUsage,
  type MailEngine,
  MailEngineError,
} from './types.js';

export interface CyrusEngineOptions extends ImapConnectOptions {
  adminUser: string;
  adminPassword: string;
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
export class CyrusEngine implements MailEngine {
  constructor(private readonly options: CyrusEngineOptions) {}

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

  private async withAdmin<T>(run: (connection: ImapConnection) => Promise<T>): Promise<T> {
    let connection: ImapConnection | undefined;
    try {
      connection = await ImapConnection.connect(this.options);
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

  async health(): Promise<EngineHealth> {
    try {
      await this.withAdmin((imap) => imap.expectOk('NOOP'));
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {}
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
