import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique } from './support.js';

interface QueueItem {
  id: string;
  recipients: { address: string; reason: string | null }[];
}

// A backup MX domain: mail is accepted for any address and waits in the queue
// for the primary server (here an address nobody answers on).
describe('Backup MX', () => {
  const admin = new ApiClient();
  let domainName: string;

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Backup MX', slug: unique('backupmx') });
    domainName = `${unique('backupmx')}.test`;
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: domainName });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    await admin.ok('PATCH', `/api/orgs/${org.id}/domains/${domain.id}`, { backupMx: true, backupMxNexthop: '[192.0.2.1]:25' });
  });

  it('accepts mail for any address and keeps it for the primary server', async () => {
    const to = `${unique('anyone')}@${domainName}`;
    // Postfix reads its maps again within seconds; until then the domain is unknown.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to, subject: 'For the primary', text: 'Hold this' });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    let item: QueueItem | undefined;
    const queueDeadline = Date.now() + 90_000;
    while (!item && Date.now() < queueDeadline) {
      await admin.ok('POST', '/api/system/queue', { action: 'flush' });
      const queue = await admin.ok<{ items: QueueItem[] }>('GET', '/api/system/queue');
      item = queue.items.find((i) => i.recipients.some((r) => r.address === to));
      if (!item) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    expect(item).toBeDefined();
    await admin.ok('POST', '/api/system/queue', { action: 'delete', ids: [item!.id] });
  }, 150_000);
});
