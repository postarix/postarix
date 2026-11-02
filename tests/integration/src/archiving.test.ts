import { beforeAll, describe, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'archiving mailbox password';

describe('Archiving', () => {
  const admin = new ApiClient();
  const addresses: Record<string, string> = {};

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Archiving', slug: unique('archiving') });
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('arch')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    const ids: Record<string, string> = {};
    for (const localPart of ['archive', 'ann', 'ben']) {
      const mailbox = await admin.ok<{ id: string; address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD });
      ids[localPart] = mailbox.id;
      addresses[localPart] = mailbox.address;
    }
    await admin.ok('PUT', `/api/orgs/${org.id}/archiving`, { archiveMailboxId: ids.archive, legalHold: true });
  });

  it('keeps a copy of mail received and sent in the archive mailbox', async () => {
    const received = unique('archived-in');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: addresses.ann, subject: received, text: 'Keep this' });
    await waitForMessage(addresses.ann!, PASSWORD, received);
    await waitForMessage(addresses.archive!, PASSWORD, received);

    const sent = unique('archived-out');
    await smtp(config.submissionPort, { user: addresses.ben!, pass: PASSWORD }).sendMail({ from: addresses.ben, to: 'partner@outside.example', subject: sent, text: 'Keep this too' });
    await waitForMessage(addresses.archive!, PASSWORD, sent);
  });
});
