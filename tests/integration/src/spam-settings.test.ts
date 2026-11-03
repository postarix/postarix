import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'spam settings password';
const SPAM_MARKER = 'POSTARIX-TEST-SPAM-MARKER'; // +8 points in test environments

// Spam thresholds and block lists, applied by Rspamd from what the API publishes.
describe('Spam settings per mailbox and domain', () => {
  const admin = new ApiClient();
  let orgId: string;
  let domainId: string;
  const mailboxes: Record<string, { id: string; address: string }> = {};

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Spam settings', slug: unique('spamset') });
    orgId = org.id;
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${orgId}/domains`, { name: `${unique('spamset')}.test` });
    domainId = domain.id;
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${domainId}/verify`);
    for (const localPart of ['strict', 'lenient', 'plain']) {
      mailboxes[localPart] = await admin.ok('POST', `/api/orgs/${orgId}/mailboxes`, { domainId, localPart, password: PASSWORD });
    }
    await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${mailboxes.strict!.id}`, { spamScores: { junkScore: null, rejectScore: 5 } });
    await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${mailboxes.lenient!.id}`, { spamScores: { junkScore: 100, rejectScore: 200 } });
    await admin.ok('POST', `/api/orgs/${orgId}/spam-lists`, { domainId, kind: 'block', pattern: '@blocked.example' });
  });

  it('refuses spam above a mailbox’s own reject score', async () => {
    await expect(
      smtp(config.smtpPort).sendMail({
        from: 'promo@outside.example',
        to: mailboxes.strict!.address,
        subject: unique('strict'),
        text: `Offer\n${SPAM_MARKER}\n`,
      }),
    ).rejects.toThrow(/5\d\d/);
  });

  it('keeps spam in the inbox of a mailbox with higher thresholds', async () => {
    const subject = unique('lenient');
    await smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: mailboxes.lenient!.address, subject, text: `Offer\n${SPAM_MARKER}\n` });
    await waitForMessage(mailboxes.lenient!.address, PASSWORD, subject);
  });

  it('refuses senders on the domain’s block list', async () => {
    await expect(
      smtp(config.smtpPort).sendMail({ from: 'anyone@blocked.example', to: mailboxes.plain!.address, subject: unique('blocked'), text: 'Hello' }),
    ).rejects.toThrow(/5\d\d/);
    const subject = unique('not-blocked');
    await smtp(config.smtpPort).sendMail({ from: 'anyone@fine.example', to: mailboxes.plain!.address, subject, text: 'Hello' });
    await waitForMessage(mailboxes.plain!.address, PASSWORD, subject);
  });

  it('keeps refused spam in quarantine, and releases it to the inbox', async () => {
    const subject = unique('quarantined');
    await smtp(config.smtpPort)
      .sendMail({ from: 'promo@outside.example', to: mailboxes.strict!.address, subject, text: `Offer\n${SPAM_MARKER}\n` })
      .catch(() => undefined);
    let item: { id: string; subject: string; recipient: string } | undefined;
    const deadline = Date.now() + 60_000;
    while (!item && Date.now() < deadline) {
      const list = await admin.ok<{ data: { id: string; subject: string; recipient: string }[] }>('GET', `/api/orgs/${orgId}/quarantine`);
      item = list.data.find((i) => i.subject === subject);
      if (!item) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(item?.recipient).toBe(mailboxes.strict!.address);
    await admin.ok('POST', `/api/orgs/${orgId}/quarantine/${item!.id}/release`);
    await waitForMessage(mailboxes.strict!.address, PASSWORD, subject);
  });
});
