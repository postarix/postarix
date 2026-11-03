import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'mail policies password';
const SPAM_MARKER = 'POSTARIX-TEST-SPAM-MARKER'; // +8 points in test environments

// Server-wide content rules and forwarding hosts, applied by Rspamd from what
// the API publishes in Valkey. (Every SMTP connection also passes Postfix's
// client check against the IP access lists.)
describe('Server-wide mail policies', () => {
  const admin = new ApiClient();
  const created: string[] = [];
  let mailbox: { id: string; address: string };
  const tag = unique('policy').toLowerCase();

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Mail policies', slug: unique('policies') });
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('policies')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    mailbox = await admin.ok('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart: 'strict', password: PASSWORD });
    // Refuses anything with the test marker (8 points).
    await admin.ok('PATCH', `/api/orgs/${org.id}/mailboxes/${mailbox.id}`, { spamScores: { junkScore: null, rejectScore: 5 } });
  });

  afterAll(async () => {
    for (const path of created) await admin.request('DELETE', path);
  });

  it('refuses mail matching a content rule, and files junk-rule matches as junk', async () => {
    const reject = await admin.ok<{ id: string }>('POST', '/api/system/filter-rules', { target: 'subject', pattern: `^forbidden ${tag}`, action: 'reject' });
    created.push(`/api/system/filter-rules/${reject.id}`);
    const junk = await admin.ok<{ id: string }>('POST', '/api/system/filter-rules', { target: 'header', header: 'X-Mailer', pattern: `bulkblaster-${tag}`, action: 'junk' });
    created.push(`/api/system/filter-rules/${junk.id}`);

    await expect(
      smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: mailbox.address, subject: `Forbidden ${tag} offer`, text: 'Hello' }),
    ).rejects.toThrow(/5\d\d/);

    const subject = unique('bulk');
    await smtp(config.smtpPort).sendMail({
      from: 'someone@outside.example',
      to: mailbox.address,
      subject,
      text: 'Hello',
      headers: { 'X-Mailer': `BulkBlaster-${tag} 2.0` },
    });
    await waitForMessage(mailbox.address, PASSWORD, subject, 45_000, 'Junk');
  });

  it('never refuses mail from a forwarding host with the spam filter off', async () => {
    const before = unique('before');
    await expect(
      smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: mailbox.address, subject: before, text: `Offer\n${SPAM_MARKER}\n` }),
    ).rejects.toThrow(/5\d\d/);

    // Every IPv4 client counts as the forwarding host here.
    const host = await admin.ok<{ id: string }>('POST', '/api/system/forwarding-hosts', { host: '0.0.0.0/0', spamFilter: false, note: 'integration test' });
    created.unshift(`/api/system/forwarding-hosts/${host.id}`);
    const subject = unique('forwarded');
    await smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: mailbox.address, subject, text: `Offer\n${SPAM_MARKER}\n` });
    await waitForMessage(mailbox.address, PASSWORD, subject);
    await admin.ok('DELETE', `/api/system/forwarding-hosts/${host.id}`);
    created.shift();
  });
});
