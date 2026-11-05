import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, imapLogin, unique } from './support.js';

const PASSWORD = 'session guard password 1';

/** Waits until `check` is true or the time runs out. */
async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

describe('Open mail sessions end when access ends', () => {
  const admin = new ApiClient();
  let orgId: string;
  let domainId: string;

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    orgId = (await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Sessions', slug: unique('sessions') })).id;
    domainId = (await admin.ok<{ id: string }>('POST', `/api/orgs/${orgId}/domains`, { name: `${unique('sg')}.test` })).id;
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${domainId}/verify`);
  });

  const mailbox = (localPart: string) =>
    admin.ok<{ id: string; address: string }>('POST', `/api/orgs/${orgId}/mailboxes`, { domainId, localPart, password: PASSWORD });

  it('an IMAP connection in IDLE is closed when its mailbox is disabled', async () => {
    const box = await mailbox('idle');
    const client = await imapLogin(box.address, PASSWORD);
    let closed = false;
    client.on('close', () => (closed = true));
    const lock = await client.getMailboxLock('INBOX');
    void client.idle().catch(() => undefined);

    await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${box.id}`, { status: 'disabled' });
    expect(await eventually(() => closed, 15_000)).toBe(true);
    lock.release();
    // And it cannot come back.
    await expect(imapLogin(box.address, PASSWORD)).rejects.toThrow();
  });

  it('a session is closed when the password is changed, and the new one works', async () => {
    const box = await mailbox('pw');
    const client = await imapLogin(box.address, PASSWORD);
    let closed = false;
    client.on('close', () => (closed = true));
    await admin.ok('POST', `/api/orgs/${orgId}/mailboxes/${box.id}/password`, { password: 'a brand new password 42' });
    expect(await eventually(() => closed, 15_000)).toBe(true);
    const again = await imapLogin(box.address, 'a brand new password 42');
    await again.logout();
  });
});
