import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'tagged mail password';

// "ann+news@": the person's own Sieve settings decide where it goes.
describe('Tagged mail', () => {
  const admin = new ApiClient();
  const person = new ApiClient();
  let address: string;

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Tagged', slug: unique('tagged') });
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('tag')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    const mailbox = await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart: 'ann', password: PASSWORD });
    address = mailbox.address;
    await person.signIn(address, PASSWORD);
  });

  const settings = (taggedMail: string) =>
    person.ok('PUT', '/api/me/mail-settings', {
      filters: [],
      vacation: { enabled: false, subject: 'Out of office', message: '', until: null },
      forwarding: { enabled: false, address: '', keepCopy: true },
      taggedMail,
    });
  const tagged = (tag: string) => address.replace('@', `+${tag}@`);

  it('files it in a folder named after the tag', async () => {
    await settings('folder');
    const subject = unique('to-folder');
    await smtp(config.smtpPort).sendMail({ from: 'shop@outside.example', to: tagged('shopping'), subject, text: 'Your order' });
    await waitForMessage(address, PASSWORD, subject, 45_000, 'shopping');
  });

  it('or marks the subject', async () => {
    await settings('subject');
    const subject = unique('to-subject');
    await smtp(config.smtpPort).sendMail({ from: 'news@outside.example', to: tagged('news'), subject, text: 'This week' });
    const raw = await waitForMessage(address, PASSWORD, subject);
    expect(raw).toMatch(new RegExp(`Subject: \\[news\\] ${subject}`));
  });
});
