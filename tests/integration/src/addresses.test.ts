import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, expectNoMessage, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'addresses mailbox password';

// Catch-all aliases, discarding aliases and extra send-as addresses, through the real Postfix.
describe('Catch-all, discard, send-as, alias domains and sending limits', () => {
  const admin = new ApiClient();
  let domain: string;
  let aliasDomain: string;
  let orgId: string;
  const ids: Record<string, string> = {};
  const addresses: Record<string, string> = {};

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Addresses', slug: unique('addresses') });
    orgId = org.id;
    domain = `${unique('addr')}.test`;
    const created = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: domain });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${created.id}/verify`);
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
    aliasDomain = `${unique('addr-alias')}.test`;
    const alias = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: aliasDomain, aliasOf: created.id });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${alias.id}/verify`);
  });

  it('delivers mail for an alias domain to the same mailboxes, and sends from it', async () => {
    const subject = unique('alias-domain');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: `ann@${aliasDomain}`, subject, text: 'Via the alias domain' });
    await waitForMessage(addresses.ann!, PASSWORD, subject);

    const reply = unique('from-alias-domain');
    await smtp(config.submissionPort, { user: addresses.ann!, pass: PASSWORD }).sendMail({
      from: `ann@${aliasDomain}`,
      to: addresses.boss,
      subject: reply,
      text: 'From the alias domain',
    });
    await waitForMessage(addresses.boss!, PASSWORD, reply);
  });

  it('refuses mail over the sending limit with a temporary error', async () => {
    await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${ids.boss}`, { rateLimit: { messages: 2, per: 'hour' } });
    const send = () =>
      smtp(config.submissionPort, { user: addresses.boss!, pass: PASSWORD }).sendMail({
        from: addresses.boss,
        to: addresses.ann,
        subject: unique('limited'),
        text: 'Counting',
      });
    await send();
    await send();
    await expect(send()).rejects.toThrow(/limit/i);
    await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${ids.boss}`, { rateLimit: null });
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
