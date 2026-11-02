import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, imapLogin, unique } from './support.js';

const PASSWORD = 'mail import mailbox password';

interface MailImport {
  id: string;
  status: string;
  imported: number;
  skipped: number;
  error: string | null;
}

// The "other provider" is this same server (allowed in test.yml): an old
// mailbox with mail in two folders is copied into a new one, over IMAPS
// with certificate checks.
describe('Importing mail from another IMAP account', () => {
  const admin = new ApiClient();
  let oldAddress: string;
  let newAddress: string;
  const subjects = { inbox: unique('old-inbox'), project: unique('old-project') };

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Import', slug: unique('import') });
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('imp')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    const create = async (localPart: string) =>
      (await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD })).address;
    oldAddress = await create('old');
    newAddress = await create('new');

    const old = await imapLogin(oldAddress, PASSWORD);
    try {
      await old.mailboxCreate('Projects');
      await old.append('INBOX', `From: someone@outside.example\r\nTo: ${oldAddress}\r\nSubject: ${subjects.inbox}\r\nDate: Mon, 6 May 2024 10:00:00 +0000\r\n\r\nOld mail\r\n`, ['\\Seen']);
      await old.append('Projects', `From: someone@outside.example\r\nTo: ${oldAddress}\r\nSubject: ${subjects.project}\r\n\r\nPlan\r\n`, ['\\Flagged']);
    } finally {
      await old.logout();
    }
  });

  it('copies folders, messages and flags', async () => {
    const person = new ApiClient();
    await person.signIn(newAddress, PASSWORD);
    const source = { host: config.importHost, username: oldAddress, password: PASSWORD };

    const wrong = await person.request('POST', '/api/me/mail-imports', { ...source, password: 'wrong password' });
    expect(wrong.status).toBe(422);

    const started = await person.ok<MailImport>('POST', '/api/me/mail-imports', source);
    let job = started;
    for (let i = 0; i < 60 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = (await person.ok<{ data: MailImport[] }>('GET', '/api/me/mail-imports')).data.find((j) => j.id === started.id)!;
    }
    expect(job).toMatchObject({ status: 'done', imported: 2, error: null });

    const client = await imapLogin(newAddress, PASSWORD);
    try {
      const find = async (folder: string, subject: string) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const [uid] = (await client.search({ subject }, { uid: true })) || [];
          if (!uid) return null;
          const message = await client.fetchOne(String(uid), { flags: true }, { uid: true });
          return message ? [...(message.flags ?? [])] : null;
        } finally {
          lock.release();
        }
      };
      expect(await find('INBOX', subjects.inbox)).toContain('\\Seen');
      expect(await find('Projects', subjects.project)).toContain('\\Flagged');
    } finally {
      await client.logout();
    }
  });
});
