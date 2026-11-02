import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, expectNoMessage, putSieveScript, smtp, unique, waitForMessage } from './support.js';

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
  });

  it('redirects with the server as envelope sender, without signing for the original sender', async () => {
    await putSieveScript(forwarder.address, PASSWORD, `require ["copy"];\nredirect :copy "${target.address}";\n`);
    const subject = unique('redirect');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: forwarder.address, subject, text: 'Please forward.' });
    const copy = await waitForMessage(target.address, PASSWORD, subject);
    expect(copy).toMatch(/^X-Sieve-Action: redirect/im);
    expect(copy).toMatch(/^Return-Path: <sieve-redirect@mail\.postarix\.test>/im);
    expect(copy).not.toMatch(/^DKIM-Signature:/im);
    // The original stays in the forwarder's inbox (:copy).
    await waitForMessage(forwarder.address, PASSWORD, subject);
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
});
