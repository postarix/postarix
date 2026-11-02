import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, expectNoMessage, imapLogin, putSieveScript, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'integration mailbox password';
const SPAM_MARKER = 'POSTARIX-TEST-SPAM-MARKER';

interface Mailbox {
  id: string;
  address: string;
}

/** Sieve redirect and vacation replies, and spam sent to aliases. */
describe('Mail Cyrus sends by itself', () => {
  const admin = new ApiClient();
  let orgId: string;
  let domain: { id: string; name: string };
  let otherDomain: { id: string; name: string };
  let away: Mailbox; // vacation reply
  let forwarder: Mailbox; // redirect
  let spoofer: Mailbox; // vacation with someone else's From
  let writer: Mailbox; // writes to the others
  let target: Mailbox; // receives redirects; on another domain

  const domainIn = async (org: string, label: string) => {
    const created = await admin.ok<{ id: string; name: string }>('POST', `/api/orgs/${org}/domains`, { name: `${unique(label)}.test` });
    await admin.ok('POST', `/api/orgs/${org}/domains/${created.id}/verify`);
    return created;
  };
  const mailbox = (org: string, domainId: string, localPart: string) =>
    admin.ok<Mailbox>('POST', `/api/orgs/${org}/mailboxes`, { domainId, localPart, password: PASSWORD });

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    orgId = (await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Sieve', slug: unique('sieve') })).id;
    domain = await domainIn(orgId, 'sieve');
    // Another organization's domain: nobody here may sign as it.
    const otherOrg = (await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Other', slug: unique('other') })).id;
    otherDomain = await domainIn(otherOrg, 'victim');
    away = await mailbox(orgId, domain.id, 'away');
    forwarder = await mailbox(orgId, domain.id, 'forwarder');
    spoofer = await mailbox(orgId, domain.id, 'spoofer');
    writer = await mailbox(orgId, domain.id, 'writer');
    target = await mailbox(otherOrg, otherDomain.id, 'target');
  });

  it('sends vacation replies, signed with the mailbox domain', async () => {
    await putSieveScript(away.address, PASSWORD, 'require ["vacation"];\nvacation :days 1 :subject "Out of office" "I am away until Monday.";\n');
    const subject = unique('vacation');
    await smtp(config.submissionPort, { user: writer.address, pass: PASSWORD }).sendMail({ from: writer.address, to: away.address, subject, text: 'Are you there?' });
    const reply = await waitForMessage(writer.address, PASSWORD, 'Out of office');
    expect(reply).toMatch(/^Auto-Submitted: auto-replied/im);
    expect(reply).toContain(`From: <${away.address}>`);
    expect(reply).toMatch(new RegExp(`^DKIM-Signature:[^]*?d=${domain.name.replace(/\./g, '\\.')};`, 'im'));
    expect(reply).toMatch(/^Return-Path: <>/im);
    // The note naming the sending mailbox is for the server only.
    expect(reply).not.toMatch(/^X-Postarix-Sieve-Owner:/im);
  });

  it('answers a message that also went to a colleague', async () => {
    // A new sender: Cyrus answers each sender once a day.
    const sender = await mailbox(orgId, domain.id, 'cc-sender');
    const subject = unique('cc');
    await smtp(config.submissionPort, { user: sender.address, pass: PASSWORD }).sendMail({
      from: sender.address,
      to: away.address,
      cc: writer.address,
      subject,
      text: 'Both of you, please.',
    });
    const reply = await waitForMessage(sender.address, PASSWORD, 'Out of office');
    expect(reply).toContain(`From: <${away.address}>`);
  });

  it('redirects with the server as envelope sender, without signing for the original sender', async () => {
    await putSieveScript(forwarder.address, PASSWORD, `require ["copy"];\nredirect :copy "${target.address}";\n`);
    const subject = unique('redirect');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: forwarder.address, subject, text: 'Please forward.' });
    const copy = await waitForMessage(target.address, PASSWORD, subject);
    expect(copy).toMatch(/^X-Sieve-Action: redirect/im);
    expect(copy).toMatch(/^Return-Path: <SRS0=[0-9a-f]{8}=[a-z2-7]{2}=outside\.example=someone@mail\.postarix\.test>/im);
    expect(copy).not.toMatch(/^DKIM-Signature:/im);
    // The original stays in the forwarder's inbox (:copy).
    await waitForMessage(forwarder.address, PASSWORD, subject);
  });

  it('returns bounces of forwarded mail to the original sender, and nothing else', async () => {
    const subject = unique('srs');
    await smtp(config.submissionPort, { user: writer.address, pass: PASSWORD }).sendMail({ from: writer.address, to: forwarder.address, subject, text: 'Forward me.' });
    const copy = await waitForMessage(target.address, PASSWORD, subject);
    const srs = /^Return-Path: <(SRS0=[^>]+)>/im.exec(copy)?.[1];
    expect(srs).toBeDefined();
    // A bounce (null sender) to that address reaches the writer.
    const bounce = unique('bounce');
    await smtp(config.smtpPort).sendMail({ envelope: { from: '', to: [srs!] }, from: 'MAILER-DAEMON@outside.example', to: srs!, subject: bounce, text: 'Delivery failed.' });
    await waitForMessage(writer.address, PASSWORD, bounce);
    // Ordinary mail to it, or to a forged address, is refused.
    await expect(
      smtp(config.smtpPort).sendMail({ envelope: { from: 'spammer@outside.example', to: [srs!] }, from: 'spammer@outside.example', to: srs!, subject: 'relay?', text: 'x' }),
    ).rejects.toThrow(/5\d\d/);
    // A "bounce" that is spam is refused rather than relayed to the writer.
    await expect(
      smtp(config.smtpPort).sendMail({ envelope: { from: '', to: [srs!] }, from: 'MAILER-DAEMON@outside.example', to: srs!, subject: unique('spam-bounce'), text: `Delivery failed.\n${SPAM_MARKER}\n` }),
    ).rejects.toThrow(/5\d\d/);
    const forged = srs!.replace(/^SRS0=[0-9a-f]{8}/i, 'SRS0=00000000');
    await expect(
      smtp(config.smtpPort).sendMail({ envelope: { from: '', to: [forged] }, from: 'MAILER-DAEMON@outside.example', to: forged, subject: 'forged', text: 'x' }),
    ).rejects.toThrow(/5\d\d/);
  });

  it('refuses a vacation reply that claims another organization’s address', async () => {
    await putSieveScript(
      spoofer.address,
      PASSWORD,
      `require ["vacation"];\nvacation :days 1 :from "ceo@${otherDomain.name}" :subject "Spoofed reply" "Pay this invoice.";\n`,
    );
    const subject = unique('spoof');
    await smtp(config.submissionPort, { user: writer.address, pass: PASSWORD }).sendMail({ from: writer.address, to: spoofer.address, subject, text: 'Hello' });
    await waitForMessage(spoofer.address, PASSWORD, subject);
    await expectNoMessage(writer.address, PASSWORD, 'Spoofed reply');
  });

  it('refuses a vacation reply in the name of a colleague on the same domain', async () => {
    const colleague = await mailbox(orgId, domain.id, 'colleague');
    await putSieveScript(
      colleague.address,
      PASSWORD,
      `require ["vacation"];\nvacation :days 1 :from "${writer.address}" :subject "Colleague spoof" "Wire the money.";\n`,
    );
    const subject = unique('colleague');
    await smtp(config.submissionPort, { user: spoofer.address, pass: PASSWORD }).sendMail({ from: spoofer.address, to: colleague.address, subject, text: 'Hi' });
    await waitForMessage(colleague.address, PASSWORD, subject);
    await expectNoMessage(spoofer.address, PASSWORD, 'Colleague spoof');
  });

  it('does not forward mail that forges a hosted sender', async () => {
    // forwarder redirects everything to target (set up above).
    const subject = unique('forged');
    await smtp(config.smtpPort).sendMail({ from: `ceo@${otherDomain.name}`, to: forwarder.address, subject, text: 'Urgent: pay now.' });
    await waitForMessage(forwarder.address, PASSWORD, subject);
    await expectNoMessage(target.address, PASSWORD, subject);
  });

  it('sets the automatic reply and forwarding from the webmail settings', async () => {
    const owner = await mailbox(orgId, domain.id, 'settings');
    const sender = await mailbox(orgId, domain.id, 'settings-sender');
    const user = new ApiClient();
    await user.signIn(owner.address, PASSWORD);
    const saved = await user.ok<{ vacation: { enabled: boolean }; forwarding: { enabled: boolean } }>('PUT', '/api/me/mail-settings', {
      vacation: { enabled: true, subject: 'On leave', message: 'I am on leave this week.', until: null },
      forwarding: { enabled: true, address: target.address, keepCopy: true },
    });
    expect(saved).toMatchObject({ vacation: { enabled: true }, forwarding: { enabled: true } });
    const subject = unique('settings');
    await smtp(config.submissionPort, { user: sender.address, pass: PASSWORD }).sendMail({ from: sender.address, to: owner.address, subject, text: 'Hello' });
    const reply = await waitForMessage(sender.address, PASSWORD, 'On leave');
    expect(reply).toContain(`From: <${owner.address}>`);
    await waitForMessage(target.address, PASSWORD, subject);
    await waitForMessage(owner.address, PASSWORD, subject);
    // And read back as saved.
    const read = await user.ok<{ forwarding: { address: string } }>('GET', '/api/me/mail-settings');
    expect(read.forwarding.address).toBe(target.address);
  });

  it('applies filters from the webmail settings: move, label and mark as read', async () => {
    const owner = await mailbox(orgId, domain.id, 'filtered');
    const user = new ApiClient();
    await user.signIn(owner.address, PASSWORD);
    const label = await user.ok<{ keyword: string }>('POST', '/api/me/labels', { name: 'Invoices' });
    await user.ok('PUT', '/api/me/mail-settings', {
      filters: [
        { field: 'from', contains: 'newsletter@', action: 'move', folder: 'Archive' },
        { field: 'subject', contains: '[invoice]', action: 'label', keyword: label.keyword },
        { field: 'subject', contains: '[invoice]', action: 'markRead' },
      ],
      vacation: { enabled: false, subject: 'Out of office', message: '', until: null },
      forwarding: { enabled: false, address: '', keepCopy: true },
    });
    const news = unique('news');
    await smtp(config.smtpPort).sendMail({ from: 'newsletter@shop.example', to: owner.address, subject: news, text: 'Deals' });
    await waitForMessage(owner.address, PASSWORD, news, 45_000, 'Archive');

    const invoice = `[invoice] ${unique('inv')}`;
    await smtp(config.smtpPort).sendMail({ from: 'billing@vendor.example', to: owner.address, subject: invoice, text: 'Pay' });
    await waitForMessage(owner.address, PASSWORD, invoice);
    const client = await imapLogin(owner.address, PASSWORD);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const [uid] = (await client.search({ subject: invoice }, { uid: true })) || [];
        const message = await client.fetchOne(String(uid), { flags: true }, { uid: true });
        expect(message && [...(message.flags ?? [])]).toEqual(expect.arrayContaining([label.keyword, '\\Seen']));
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  });

  it('files spam sent to an alias in the Junk folder of its hosted destinations', async () => {
    const alias = await admin.ok<{ address: string }>('POST', `/api/orgs/${orgId}/aliases`, {
      domainId: domain.id,
      localPart: unique('team'),
      destinations: [writer.address, 'partner@outside.example'],
    });
    const subject = unique('alias-spam');
    await smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: alias.address, subject, text: `Cheap stuff\n${SPAM_MARKER}\n` });
    await waitForMessage(writer.address, PASSWORD, subject, 45_000, 'Junk');
  });

  it('never forwards spam to an alias’ outside destinations', async () => {
    const alias = await admin.ok<{ address: string }>('POST', `/api/orgs/${orgId}/aliases`, {
      domainId: domain.id,
      localPart: unique('outside'),
      destinations: ['partner@outside.example'],
    });
    // Accepted (and discarded): refusing it would tell the spammer what works.
    await smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: alias.address, subject: unique('alias-out'), text: `Cheap stuff\n${SPAM_MARKER}\n` });
  });
});
