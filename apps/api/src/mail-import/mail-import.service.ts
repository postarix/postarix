import { readFileSync } from 'node:fs';
import { ConflictException, Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnModuleDestroy, UnprocessableEntityException } from '@nestjs/common';
import type { MailEngine } from '@postarix/mail-engine';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { DATABASE, ENV, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { type MailImportStatus, mailboxes, mailImports } from '../db/schema/mail.js';
import { ServerJmap } from '../mail/jmap-client.js';
import { decryptClientSecret, encryptClientSecret } from '../sso/sso-crypto.js';
import { connectSource, type ImapSource, SourceError } from './imap-source.js';

export const startImportSchema = z.strictObject({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]{1,253}$/, 'Expected a host name such as imap.example.com'),
  port: z.number().int().min(1).max(65535).optional(),
  security: z.enum(['tls', 'starttls']).default('tls'),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});
export type StartImport = z.infer<typeof startImportSchema>;

export interface MailImportView {
  id: string;
  host: string;
  username: string;
  status: MailImportStatus;
  imported: number;
  skipped: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

type Row = typeof mailImports.$inferSelect;

/** Folders that only show other folders' messages again (Gmail's All Mail, Starred, Important). */
const VIRTUAL_FOLDERS = new Set(['\\All', '\\Flagged', '\\Important']);
/** Special folders of the source, by the JMAP role of the matching folder here. */
const ROLES: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
};
/** Container names that hold no mail of their own. */
const CONTAINERS = new Set(['[gmail]', '[google mail]']);
const FLAGS: Record<string, string> = { '\\Seen': '$seen', '\\Flagged': '$flagged', '\\Answered': '$answered', '\\Draft': '$draft' };
/** A worker that has not written for this long is considered dead; another one resumes its import. */
const STALE_AFTER = '15 minutes';
const POLL_MS = 5_000;
const CONCURRENCY = 2;
const SAVE_EVERY = 20;

class Cancelled extends Error {}

/**
 * Copies a person's mail from another IMAP server into their own mailbox, in
 * the background: folders keep their names (special folders map to ours),
 * flags are kept, and an interrupted import resumes where it stopped. The
 * source password is encrypted while the import runs and erased once it ends.
 */
@Injectable()
export class MailImportService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MailImportService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = 0;
  private stopping = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
  ) {}

  onApplicationBootstrap(): void {
    // Tests drive runOnce() themselves.
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runOnce(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async ownMailbox(userId: string): Promise<string> {
    const [row] = await this.db.select({ address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.userId, userId), eq(mailboxes.status, 'active'))).limit(1);
    if (!row) throw new NotFoundException('You have no mailbox');
    return row.address;
  }

  private view(row: Row): MailImportView {
    return {
      id: row.id,
      host: row.host,
      username: row.username,
      status: row.status,
      imported: row.imported,
      skipped: row.skipped,
      error: row.error,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    };
  }

  private source(input: Pick<Row, 'host' | 'port' | 'security' | 'username'>, password: string): ImapSource {
    return { host: input.host, port: input.port, security: input.security, username: input.username, password };
  }

  private extraCa(): string | undefined {
    return this.env.MAIL_IMPORT_CA_FILE ? readFileSync(this.env.MAIL_IMPORT_CA_FILE, 'utf8') : undefined;
  }

  async list(userId: string): Promise<MailImportView[]> {
    const rows = await this.db.select().from(mailImports).where(eq(mailImports.userId, userId)).orderBy(desc(mailImports.createdAt)).limit(20);
    return rows.map((row) => this.view(row));
  }

  /** Checks the source account (so mistakes show at once) and queues the import. */
  async start(userId: string, input: StartImport): Promise<MailImportView> {
    const address = await this.ownMailbox(userId);
    const active = await this.db
      .select({ id: mailImports.id })
      .from(mailImports)
      .where(and(eq(mailImports.userId, userId), inArray(mailImports.status, ['queued', 'running'])))
      .limit(1);
    if (active.length) throw new ConflictException('An import is already running; wait for it to finish or cancel it');

    const port = input.port ?? (input.security === 'tls' ? 993 : 143);
    const source = this.source({ host: input.host, port, security: input.security, username: input.username }, input.password);
    let client: ImapFlow;
    try {
      client = await connectSource(source, this.env.MAIL_IMPORT_ALLOWED_HOSTS, this.extraCa());
    } catch (error) {
      if (error instanceof SourceError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    await client.logout().catch(() => undefined);

    // Importing the same account again (say, after moving the domain's MX)
    // copies only what arrived since the last import.
    const [previous] = await this.db
      .select({ progress: mailImports.progress })
      .from(mailImports)
      .where(and(eq(mailImports.userId, userId), eq(mailImports.host, input.host), eq(mailImports.username, input.username)))
      .orderBy(desc(mailImports.createdAt))
      .limit(1);

    const [row] = await this.db
      .insert(mailImports)
      .values({
        userId,
        mailboxAddress: address,
        host: input.host,
        port,
        security: input.security,
        username: input.username,
        password: encryptClientSecret(input.password, this.env.AUTH_SECRET),
        progress: previous?.progress ?? {},
      })
      .returning();
    // Start now rather than at the next poll (tests run imports themselves).
    if (this.env.NODE_ENV !== 'test') void this.runOnce();
    return this.view(row!);
  }

  async cancel(userId: string, id: string): Promise<MailImportView> {
    const [row] = await this.db
      .update(mailImports)
      .set({ status: 'cancelled', password: null, finishedAt: new Date() })
      .where(and(eq(mailImports.id, id), eq(mailImports.userId, userId), inArray(mailImports.status, ['queued', 'running'])))
      .returning();
    if (row) return this.view(row);
    const [existing] = await this.db.select().from(mailImports).where(and(eq(mailImports.id, id), eq(mailImports.userId, userId)));
    if (!existing) throw new NotFoundException('Import not found');
    return this.view(existing);
  }

  /** Claims and runs queued imports (and those whose worker died), up to the concurrency limit. */
  async runOnce(): Promise<void> {
    while (!this.stopping && this.running < CONCURRENCY) {
      const result = await this.db.execute<{ id: string }>(sql`
        UPDATE mail_imports SET status = 'running', locked_at = now()
        WHERE id = (
          SELECT id FROM mail_imports
          WHERE status = 'queued' OR (status = 'running' AND locked_at < now() - ${STALE_AFTER}::interval)
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING id`);
      const id = result.rows[0]?.id;
      if (!id) return;
      this.running++;
      void this.run(id).finally(() => this.running--);
    }
  }

  /** Runs one import to its end; exposed for tests. */
  async run(id: string): Promise<void> {
    const [job] = await this.db.select().from(mailImports).where(eq(mailImports.id, id));
    if (!job?.password) return;
    let client: ImapFlow | undefined;
    try {
      const password = decryptClientSecret(job.password, this.env.AUTH_SECRET);
      client = await connectSource(this.source(job, password), this.env.MAIL_IMPORT_ALLOWED_HOSTS, this.extraCa());
      await this.copyAll(job, client);
      await this.finish(id, 'done', null);
    } catch (error) {
      if (error instanceof Cancelled) return;
      const message = error instanceof SourceError || error instanceof ImportError ? error.message : 'The import stopped unexpectedly; start it again to resume';
      if (!(error instanceof SourceError || error instanceof ImportError)) this.logger.warn(`Mail import ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.finish(id, 'failed', message);
    } finally {
      await client?.logout().catch(() => undefined);
    }
  }

  private async finish(id: string, status: 'done' | 'failed', error: string | null): Promise<void> {
    await this.db
      .update(mailImports)
      .set({ status, error, password: null, finishedAt: new Date(), lockedAt: null })
      .where(and(eq(mailImports.id, id), eq(mailImports.status, 'running')));
  }

  /** Saves progress (and proves the worker is alive); throws Cancelled when the person cancelled. */
  private async save(job: Row): Promise<void> {
    const [row] = await this.db
      .update(mailImports)
      .set({ progress: job.progress, imported: job.imported, skipped: job.skipped, lockedAt: new Date() })
      .where(and(eq(mailImports.id, job.id), eq(mailImports.status, 'running')))
      .returning({ id: mailImports.id });
    if (!row) throw new Cancelled();
  }

  private async copyAll(job: Row, client: ImapFlow): Promise<void> {
    const jmap = new ServerJmap(this.engine, job.mailboxAddress);
    const targets = new TargetFolders(jmap);
    const folders = (await client.list()).filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent') && !VIRTUAL_FOLDERS.has(f.specialUse ?? ''));
    for (const folder of folders) {
      const role = folder.specialUse ? ROLES[folder.specialUse] : folder.path.toUpperCase() === 'INBOX' ? 'inbox' : undefined;
      const parts = folder.path.split(folder.delimiter || '/').filter((p) => p && !CONTAINERS.has(p.toLowerCase()));
      const mailboxId = await targets.resolve(role, parts);
      await this.copyFolder(job, client, folder.path, mailboxId, jmap);
    }
  }

  private async copyFolder(job: Row, client: ImapFlow, path: string, mailboxId: string, jmap: ServerJmap): Promise<void> {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.exists === 0) return;
      const uidValidity = String(mailbox.uidValidity);
      const done = job.progress[path];
      const from = done && done.uidValidity === uidValidity ? done.lastUid : 0;
      const uids = ((await client.search({ uid: `${from + 1}:*` }, { uid: true })) || []).filter((uid) => uid > from).sort((a, b) => a - b);
      let since = 0;
      for (const uid of uids) {
        const message = await client.fetchOne(String(uid), { source: true, flags: true, internalDate: true }, { uid: true });
        const raw = message ? message.source : undefined;
        if (!message || !raw || raw.length > this.env.MAIL_UPLOAD_LIMIT) {
          job.skipped++;
        } else {
          const keywords = Object.fromEntries([...(message.flags ?? [])].filter((f) => FLAGS[f]).map((f) => [FLAGS[f], true]));
          const receivedAt = message.internalDate instanceof Date ? message.internalDate.toISOString() : undefined;
          if (await this.importMessage(jmap, raw, mailboxId, keywords, receivedAt)) job.imported++;
          else job.skipped++;
        }
        job.progress = { ...job.progress, [path]: { uidValidity, lastUid: uid } };
        if (++since >= SAVE_EVERY) {
          since = 0;
          await this.save(job);
        }
      }
      await this.save(job);
    } finally {
      lock.release();
    }
  }

  private async importMessage(jmap: ServerJmap, raw: Buffer, mailboxId: string, keywords: Record<string, boolean>, receivedAt: string | undefined): Promise<boolean> {
    const blobId = await jmap.upload(raw, 'message/rfc822');
    const result = await jmap.single<{ created?: Record<string, unknown> | null; notCreated?: Record<string, { type?: string }> | null }>('Email/import', {
      emails: { m: { blobId, mailboxIds: { [mailboxId]: true }, keywords, ...(receivedAt ? { receivedAt } : {}) } },
    });
    if (result.created?.m) return true;
    const type = result.notCreated?.m?.type;
    if (type === 'overQuota') throw new ImportError('Your mailbox is full; free some space or ask for a larger quota, then start the import again to resume');
    // Duplicates and messages the server cannot parse are skipped.
    return false;
  }
}

class ImportError extends Error {}

interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

/** The person's folders, created on demand to mirror the source's. */
class TargetFolders {
  private folders: Folder[] | undefined;

  constructor(private readonly jmap: ServerJmap) {}

  private async load(): Promise<Folder[]> {
    if (!this.folders) {
      const { list } = await this.jmap.single<{ list: Folder[] }>('Mailbox/get', {
        properties: ['name', 'parentId', 'role'],
      });
      this.folders = list;
    }
    return this.folders;
  }

  async resolve(role: string | undefined, parts: string[]): Promise<string> {
    const folders = await this.load();
    if (role) {
      const match = folders.find((f) => f.role === role);
      if (match) return match.id;
    }
    let parentId: string | null = null;
    for (const name of parts.length ? parts : ['Imported']) {
      const parent: string | null = parentId;
      const existing: Folder | undefined = folders.find((f) => f.parentId === parent && f.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const response: { created?: Record<string, { id: string }> | null } = await this.jmap.single('Mailbox/set', { create: { f: { name, parentId: parent } } });
      const createdId: string | undefined = response.created?.f?.id;
      if (!createdId) throw new ImportError(`The folder "${name}" could not be created`);
      folders.push({ id: createdId, name, parentId: parent, role: null });
      parentId = createdId;
    }
    return parentId!;
  }
}
