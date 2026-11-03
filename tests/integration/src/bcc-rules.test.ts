import { afterAll, beforeAll, describe, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'bcc rules mailbox password';

describe('BCC rules and recipient maps', () => {
  const admin = new ApiClient();
  const addresses: Record<string, string> = {};
  let orgId: string;
  let domainName: string;
  const maps: string[] = [];

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'BCC', slug: unique('bcc') });
    orgId = org.id;
    domainName = `${unique('bcc')}.test`;
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${orgId}/domains`, { name: domainName });
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${domain.id}/verify`);
    const ids: Record<string, string> = {};
    for (const localPart of ['archive', 'audit', 'outbox', 'ann', 'ben']) {
      const mailbox = await admin.ok<{ id: string; address: string }>('POST', `/api/orgs/${orgId}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD });
      ids[localPart] = mailbox.id;
      addresses[localPart] = mailbox.address;
    }
    await admin.ok('PUT', `/api/orgs/${orgId}/archiving`, { archiveMailboxId: ids.archive, legalHold: false });
    await admin.ok('POST', `/api/orgs/${orgId}/bcc-rules`, { address: addresses.ann, direction: 'recipient', destination: addresses.audit });
    await admin.ok('POST', `/api/orgs/${orgId}/bcc-rules`, { address: `@${domainName}`, direction: 'sender', destination: addresses.outbox });
  });

  afterAll(async () => {
    for (const id of maps) await admin.request('DELETE', `/api/system/recipient-maps/${id}`);
  });

  it('copies received mail to the rule’s address and to the archive alike', async () => {
    const subject = unique('bcc-in');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: addresses.ann, subject, text: 'Copy me' });
    await waitForMessage(addresses.ann!, PASSWORD, subject);
    await waitForMessage(addresses.audit!, PASSWORD, subject);
    await waitForMessage(addresses.archive!, PASSWORD, subject);
  });

  it('copies what any address of the domain sends', async () => {
    const subject = unique('bcc-out');
    await smtp(config.submissionPort, { user: addresses.ben!, pass: PASSWORD }).sendMail({ from: addresses.ben, to: 'partner@outside.example', subject, text: 'Sent' });
    await waitForMessage(addresses.outbox!, PASSWORD, subject);
    await waitForMessage(addresses.archive!, PASSWORD, subject);
  });

  it('delivers mail for a rewritten address to its new one', async () => {
    const map = await admin.ok<{ id: string }>('POST', '/api/system/recipient-maps', { address: `former@${domainName}`, destination: addresses.ben });
    maps.push(map.id);
    const subject = unique('rewritten');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: `former@${domainName}`, subject, text: 'For the former colleague' });
    await waitForMessage(addresses.ben!, PASSWORD, subject);
  });
});
