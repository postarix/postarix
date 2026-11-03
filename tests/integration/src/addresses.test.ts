import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, expectNoMessage, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'addresses mailbox password';

// Catch-all aliases, discarding aliases and extra send-as addresses, through the real Postfix.
describe('Catch-all, discard and send-as', () => {
  const admin = new ApiClient();
  let domain: string;
  const addresses: Record<string, string> = {};

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Addresses', slug: unique('addresses') });
    domain = `${unique('addr')}.test`;
    const created = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: domain });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${created.id}/verify`);
    const ids: Record<string, string> = {};
    for (const localPart of ['boss', 'ann']) {
      const mailbox = await admin.ok<{ id: string; address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, {
        domainId: created.id,
        localPart,
        password: PASSWORD,
      });
      ids[localPart] = mailbox.id;
      addresses[localPart] = mailbox.address;
    }
    await admin.ok('POST', `/api/orgs/${org.id}/aliases`, { domainId: created.id, localPart: '', destinations: [addresses.boss] });
    await admin.ok('POST', `/api/orgs/${org.id}/aliases`, { domainId: created.id, localPart: 'void', discard: true });
    await admin.ok('PUT', `/api/orgs/${org.id}/mailboxes/${ids.ann}/send-as`, { senders: [`@${domain}`] });
  });

  it('delivers mail for unknown addresses to the catch-all, and mailboxes keep their own', async () => {
    const lost = unique('catch-all');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: `nobody@${domain}`, subject: lost, text: 'Who gets this?' });
    await waitForMessage(addresses.boss!, PASSWORD, lost);

    const own = unique('own-mail');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: addresses.ann, subject: own, text: 'Just for Ann' });
    await waitForMessage(addresses.ann!, PASSWORD, own);
    await expectNoMessage(addresses.boss!, PASSWORD, own, 5_000);
  });

  it('accepts and drops mail for a discarding alias', async () => {
    const dropped = unique('dropped');
    const info = await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: `void@${domain}`, subject: dropped, text: 'Gone' });
    expect(info.accepted).toEqual([`void@${domain}`]);
    await expectNoMessage(addresses.boss!, PASSWORD, dropped, 5_000);
  });

  it('lets a mailbox send as any address of a domain it was allowed', async () => {
    const subject = unique('send-as');
    await smtp(config.submissionPort, { user: addresses.ann!, pass: PASSWORD }).sendMail({
      from: `sales@${domain}`,
      to: addresses.boss,
      subject,
      text: 'From the sales address',
    });
    await waitForMessage(addresses.boss!, PASSWORD, subject);

    // Without the permission, Postfix refuses the sender.
    await expect(
      smtp(config.submissionPort, { user: addresses.boss!, pass: PASSWORD }).sendMail({
        from: `sales@${domain}`,
        to: addresses.ann,
        subject: unique('refused'),
        text: 'Not allowed',
      }),
    ).rejects.toThrow(/not owned|rejected|553/i);
  });
});
