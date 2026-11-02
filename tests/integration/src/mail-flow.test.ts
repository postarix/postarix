import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, canLogin, config, imapLogin, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'integration mailbox password';

interface Mailbox {
  id: string;
  address: string;
}

describe('Mail flow through the full stack', () => {
  const admin = new ApiClient();
  let orgId: string;
  let domain: { id: string; name: string };
  let alice: Mailbox;
  let bob: Mailbox;

  const createMailbox = (localPart: string) =>
    admin.ok<Mailbox>('POST', `/api/orgs/${orgId}/mailboxes`, {
      domainId: domain.id,
      localPart,
      password: PASSWORD,
      displayName: localPart,
    });

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', {
      name: 'Integration',
      slug: unique('integration'),
    });
    orgId = org.id;
    const created = await admin.ok<{ id: string; name: string }>('POST', `/api/orgs/${orgId}/domains`, {
      name: `${unique('it')}.test`,
    });
    // The test stack runs with DOMAIN_VERIFICATION=skip.
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${created.id}/verify`);
    domain = created;
    alice = await createMailbox('alice');
    bob = await createMailbox('bob');
  });

  describe('provisioning', () => {
    it('creates the mailbox in Cyrus with the default folders', async () => {
      const client = await imapLogin(alice.address, PASSWORD);
      try {
        const folders = await client.list();
        const specialUse = folders
          .map((f) => f.specialUse)
          .filter((use) => use && use !== '\\Inbox')
          .sort();
        expect(specialUse).toEqual(['\\Archive', '\\Drafts', '\\Junk', '\\Sent', '\\Trash']);
        expect(folders.some((f) => f.path === 'INBOX')).toBe(true);
      } finally {
        await client.logout();
      }
    });

    it('accepts logins over STARTTLS on port 143', async () => {
      const client = await imapLogin(alice.address, PASSWORD, { starttls: true });
      try {
        expect(client.secureConnection).toBe(true);
      } finally {
        await client.logout();
      }
    });

    it('rejects wrong passwords and unknown users', async () => {
      expect(await canLogin(alice.address, 'not the password')).toBe(false);
      expect(await canLogin(`nobody@${domain.name}`, PASSWORD)).toBe(false);
    });
  });

  describe('submission and delivery', () => {
    it('delivers authenticated mail on 587 (STARTTLS) between local mailboxes', async () => {
      const subject = unique('submission');
      await smtp(config.submissionPort, { user: alice.address, pass: PASSWORD }).sendMail({
        from: alice.address,
        to: bob.address,
        subject,
        text: 'Hello Bob, over STARTTLS.',
      });
      const source = await waitForMessage(bob.address, PASSWORD, subject);
      expect(source).toContain('Hello Bob, over STARTTLS.');
      // Rspamd signed it with the domain's key, published in Valkey by the API.
      const signature = /^DKIM-Signature:[\s\S]*?(?=^\S)/im.exec(source)?.[0] ?? '';
      expect(signature).toMatch(new RegExp(`d=${domain.name.replace(/\./g, '\\.')};`));
      expect(signature).toMatch(/s=px\d{6};/);
    });

    it('delivers authenticated mail on 465 (implicit TLS)', async () => {
      const subject = unique('submissions');
      await smtp(config.submissionsPort, { user: alice.address, pass: PASSWORD }).sendMail({
        from: alice.address,
        to: bob.address,
        subject,
        text: 'Over implicit TLS.',
      });
      await waitForMessage(bob.address, PASSWORD, subject);
    });

    it('accepts inbound mail on port 25 for local mailboxes, through Rspamd', async () => {
      const subject = unique('inbound');
      await smtp(config.smtpPort).sendMail({
        from: 'sender@outside.example',
        to: bob.address,
        subject,
        text: 'Hello from the Internet.',
      });
      const source = await waitForMessage(bob.address, PASSWORD, subject);
      expect(source).toMatch(/^X-Spamd-Bar:/im);
    });

    it('expands aliases to every destination', async () => {
      await admin.ok('POST', `/api/orgs/${orgId}/aliases`, {
        domainId: domain.id,
        localPart: 'team',
        destinations: [alice.address, bob.address],
      });
      const subject = unique('alias');
      await smtp(config.smtpPort).sendMail({
        from: 'sender@outside.example',
        to: `team@${domain.name}`,
        subject,
        text: 'For the whole team.',
      });
      await waitForMessage(alice.address, PASSWORD, subject);
      await waitForMessage(bob.address, PASSWORD, subject);
    });
  });

  describe('spam handling', () => {
    // The test stack scores this marker as ordinary spam (RSPAMD_TEST_RULES);
    // GTUBE triggers a rejection outright.
    const SPAM_MARKER = 'POSTARIX-TEST-SPAM-MARKER';
    const GTUBE_REJECT = 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X';

    it('files mail marked as spam in the recipient’s Junk folder', async () => {
      const subject = unique('junk');
      await smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: bob.address, subject, text: `Cheap stuff\n${SPAM_MARKER}\n` });
      const raw = await waitForMessage(bob.address, PASSWORD, subject, 45_000, 'Junk');
      expect(raw).toMatch(/^X-Spam: Yes/im);
    });

    it('rejects mail over the reject threshold', async () => {
      await expect(
        smtp(config.smtpPort).sendMail({ from: 'promo@outside.example', to: bob.address, subject: unique('reject'), text: `${GTUBE_REJECT}\n` }),
      ).rejects.toThrow(/5\d\d/);
    });

    it('rejects a virus in an attachment (ClamAV)', async () => {
      // The EICAR test file: every antivirus treats it as a virus.
      const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
      await expect(
        smtp(config.smtpPort).sendMail({
          from: 'friend@outside.example',
          to: bob.address,
          subject: unique('virus'),
          text: 'Look at this invoice',
          attachments: [{ filename: 'invoice.com', content: eicar }],
        }),
      ).rejects.toThrow(/virus found/i);
    });

    it('delivers clean attachments', async () => {
      const subject = unique('clean');
      await smtp(config.smtpPort).sendMail({
        from: 'friend@outside.example',
        to: bob.address,
        subject,
        text: 'The report',
        attachments: [{ filename: 'report.txt', content: 'Quarterly numbers' }],
      });
      await waitForMessage(bob.address, PASSWORD, subject);
    });
  });

  describe('abuse protection', () => {
    it('refuses to relay unauthenticated mail to other domains', async () => {
      await expect(
        smtp(config.smtpPort).sendMail({
          from: 'spammer@outside.example',
          to: 'victim@elsewhere.example',
          subject: 'relay attempt',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow(/relay access denied|554|550|454/i);
    });

    it('refuses mail for unknown local recipients', async () => {
      await expect(
        smtp(config.smtpPort).sendMail({
          from: 'sender@outside.example',
          to: `nobody@${domain.name}`,
          subject: 'unknown user',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow(/550|User unknown|Recipient address rejected/i);
    });

    it('refuses envelope senders the user does not own', async () => {
      await expect(
        smtp(config.submissionPort, { user: alice.address, pass: PASSWORD }).sendMail({
          envelope: { from: bob.address, to: [bob.address] },
          from: bob.address,
          to: bob.address,
          subject: 'spoof',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow(/not owned by user|553|Sender address rejected/i);
    });

    it('refuses a From header the user does not own', async () => {
      await expect(
        smtp(config.submissionPort, { user: alice.address, pass: PASSWORD }).sendMail({
          envelope: { from: alice.address, to: [bob.address] },
          from: bob.address,
          to: bob.address,
          subject: 'header spoof',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow(/From header must match|5\d\d/i);
    });

    it('refuses the null envelope sender on submission', async () => {
      await expect(
        smtp(config.submissionPort, { user: alice.address, pass: PASSWORD }).sendMail({
          envelope: { from: '', to: [bob.address] },
          from: alice.address,
          to: bob.address,
          subject: 'null sender',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow(/Null sender|5\d\d/i);
    });

    it('lets a mailbox send as an alias that delivers to it', async () => {
      const subject = unique('send-as-alias');
      await smtp(config.submissionPort, { user: bob.address, pass: PASSWORD }).sendMail({
        envelope: { from: `team@${domain.name}`, to: [alice.address] },
        from: `team@${domain.name}`,
        to: alice.address,
        subject,
        text: 'Sent as the team alias.',
      });
      await waitForMessage(alice.address, PASSWORD, subject);
    });

    it('refuses submission without authentication', async () => {
      await expect(
        smtp(config.submissionPort).sendMail({
          from: alice.address,
          to: bob.address,
          subject: 'no auth',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow();
    });
  });

  describe('app passwords and account changes', () => {
    it('logs in with an app password and stops working once revoked', async () => {
      const user = new ApiClient();
      await user.signIn(bob.address, PASSWORD);
      const created = await user.ok<{ id: string; password: string }>('POST', '/api/me/app-passwords', {
        name: 'Integration client',
        scopes: ['imap', 'smtp'],
      });
      expect(await canLogin(bob.address, created.password)).toBe(true);

      const subject = unique('app-password');
      await smtp(config.submissionPort, { user: bob.address, pass: created.password }).sendMail({
        from: bob.address,
        to: alice.address,
        subject,
        text: 'Sent with an app password.',
      });
      await waitForMessage(alice.address, PASSWORD, subject);

      await user.ok('DELETE', `/api/me/app-passwords/${created.id}`);
      expect(await canLogin(bob.address, created.password)).toBe(false);
    });

    it('locks out disabled mailboxes and refuses their mail', async () => {
      const carol = await createMailbox('carol');
      expect(await canLogin(carol.address, PASSWORD)).toBe(true);
      await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${carol.id}`, { status: 'disabled' });
      expect(await canLogin(carol.address, PASSWORD)).toBe(false);
      await expect(
        smtp(config.smtpPort).sendMail({
          from: 'sender@outside.example',
          to: carol.address,
          subject: 'disabled',
          text: 'Should be refused.',
        }),
      ).rejects.toThrow(/550|User unknown|Recipient address rejected/i);
    });

    it('applies quotas and removes the Cyrus mailbox on deletion', async () => {
      const dave = await createMailbox('dave');
      await admin.ok('PATCH', `/api/orgs/${orgId}/mailboxes/${dave.id}`, { quotaBytes: 5 * 1024 * 1024 });
      const usage = await admin.ok<{ usedBytes: number | null; quotaBytes: number | null }>(
        'GET',
        `/api/orgs/${orgId}/mailboxes/${dave.id}/usage`,
      );
      expect(usage.quotaBytes).toBe(5 * 1024 * 1024);
      expect(usage.usedBytes).toBe(0);

      await admin.ok('DELETE', `/api/orgs/${orgId}/mailboxes/${dave.id}`);
      expect(await canLogin(dave.address, PASSWORD)).toBe(false);
      // The address can be reused, which requires the Cyrus mailbox to be gone.
      const again = await createMailbox('dave');
      expect(again.address).toBe(dave.address);
    });
  });

  describe('mail log', () => {
    // Runs last: by now the organization has delivered, sent and refused mail.
    it('shows the organization what the filter did with its mail, and nothing else', async () => {
      const log = await admin.ok<{ data: { from: string; to: string[]; outcome: string; direction: string }[] }>('GET', `/api/orgs/${orgId}/mail-log`);
      expect(log.data.length).toBeGreaterThan(0);
      expect(log.data.some((e) => e.direction === 'in' && e.outcome === 'delivered' && e.to.includes(bob.address))).toBe(true);
      // The forged From header refused on submission.
      expect(log.data.some((e) => e.direction === 'out' && e.outcome === 'rejected' && e.from === alice.address)).toBe(true);
      for (const entry of log.data) {
        const own = (address: string) => address.endsWith(`@${domain.name}`);
        expect(entry.direction === 'out' ? own(entry.from) : entry.to.every(own)).toBe(true);
      }
    });
  });
});
