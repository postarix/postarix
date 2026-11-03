import nodemailer from 'nodemailer';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, canLogin, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'mailbox options password';

// Per-mailbox options enforced by Postfix and the mail login bridge.
describe('Mailbox options', () => {
  const admin = new ApiClient();
  let orgId: string;
  const mailboxes: Record<string, { id: string; address: string }> = {};

  const update = (name: string, body: Record<string, unknown>) =>
    admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${mailboxes[name]!.id}`, body);

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Options', slug: unique('options') });
    orgId = org.id;
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${orgId}/domains`, { name: `${unique('opt')}.test` });
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${domain.id}/verify`);
    for (const localPart of ['secure', 'limited', 'quiet']) {
      mailboxes[localPart] = await admin.ok<{ id: string; address: string }>('POST', `/api/orgs/${orgId}/mailboxes`, {
        domainId: domain.id,
        localPart,
        password: PASSWORD,
      });
    }
  });

  it('refuses mail sent without TLS to a mailbox that requires it', async () => {
    await update('secure', { tlsRequiredIn: true });
    const address = mailboxes.secure!.address;
    await expect(
      smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: address, subject: unique('plain'), text: 'In clear' }),
    ).rejects.toThrow(/TLS|encryption|plaintext/i);

    const subject = unique('over-tls');
    await nodemailer
      .createTransport({ host: config.host, port: config.smtpPort, requireTLS: true, tls: { rejectUnauthorized: false } })
      .sendMail({ from: 'someone@outside.example', to: address, subject, text: 'Encrypted' });
    await waitForMessage(address, PASSWORD, subject);
  });

  it('refuses the protocols the organization turned off', async () => {
    const address = mailboxes.limited!.address;
    expect(await canLogin(address, PASSWORD)).toBe(true);
    await update('limited', { allowedProtocols: ['smtp'] });
    expect(await canLogin(address, PASSWORD)).toBe(false);
    // Sending still works.
    await smtp(config.submissionPort, { user: address, pass: PASSWORD }).sendMail({
      from: address,
      to: mailboxes.secure!.address,
      subject: unique('still-sends'),
      text: 'SMTP is allowed',
    });
  });

  it('delivers mail to a mailbox nobody can sign in to', async () => {
    const address = mailboxes.quiet!.address;
    await update('quiet', { status: 'no_login' });
    expect(await canLogin(address, PASSWORD)).toBe(false);
    const subject = unique('kept');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: address, subject, text: 'Still arrives' });
    await update('quiet', { status: 'active' });
    await waitForMessage(address, PASSWORD, subject);
  });
});
