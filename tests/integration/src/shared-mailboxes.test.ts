import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, imapLogin, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'shared mailbox test password';
const MAIL = 'urn:ietf:params:jmap:mail';
const USING = ['urn:ietf:params:jmap:core', MAIL];
type MethodResponse = [string, Record<string, unknown>, string];

/** Waits until `check` is true or the time runs out. */
async function eventually(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return check();
}

describe('Shared mailboxes on the real mail server', () => {
  const admin = new ApiClient();
  let orgId: string;
  let domainId: string;
  let team: { id: string; address: string };
  let ann: { userId: string; address: string };
  let ben: { userId: string; address: string };
  let outsider: string;
  const annWeb = new ApiClient();

  const call = async (client: ApiClient, methodCalls: [string, Record<string, unknown>, string][]) =>
    (await client.ok<{ methodResponses: MethodResponse[] }>('POST', '/api/jmap/', { using: USING, methodCalls })).methodResponses;

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    orgId = (await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Shared', slug: unique('shared') })).id;
    domainId = (await admin.ok<{ id: string }>('POST', `/api/orgs/${orgId}/domains`, { name: `${unique('sh')}.test` })).id;
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${domainId}/verify`);
    const person = (localPart: string) =>
      admin.ok<{ userId: string; address: string }>('POST', `/api/orgs/${orgId}/mailboxes`, { domainId, localPart, password: PASSWORD });
    ann = await person('ann');
    ben = await person('ben');
    outsider = (await person('out')).address;
    team = await admin.ok('POST', `/api/orgs/${orgId}/mailboxes`, { domainId, localPart: 'support', kind: 'shared', displayName: 'Support' });
    await admin.ok('PUT', `/api/orgs/${orgId}/mailboxes/${team.id}/members/${ann.userId}`, { rights: 'send' });
    await admin.ok('PUT', `/api/orgs/${orgId}/mailboxes/${team.id}/members/${ben.userId}`, { rights: 'read' });
    await annWeb.signIn(ann.address, PASSWORD);
  });

  it('receives mail and shows it to members in IMAP (Other Users) and JMAP, with one read state', async () => {
    const subject = unique('to-support');
    await smtp(config.smtpPort).sendMail({ from: 'customer@outside.example', to: team.address, subject, text: 'Help!' });
    await waitForMessage(ann.address, PASSWORD, subject, 45_000, 'Other Users/support');

    const session = await annWeb.ok<{ accounts: Record<string, { name: string; isReadOnly: boolean }> }>('GET', '/api/jmap/');
    expect(session.accounts[team.address]).toMatchObject({ name: 'Support', isReadOnly: false });
    const [[, query]] = await call(annWeb, [['Email/query', { accountId: team.address, filter: { subject } }, 'q']]);
    const id = (query.ids as string[])[0]!;
    // Ann reads it in the webmail: it is read for Ben too.
    await call(annWeb, [['Email/set', { accountId: team.address, update: { [id]: { 'keywords/$seen': true } } }, 's']]);
    const benImap = await imapLogin(ben.address, PASSWORD);
    const status = await benImap.status('Other Users/support', { unseen: true });
    expect(status.unseen).toBe(0);
    await benImap.logout();

    // A reader cannot change it.
    const benWeb = new ApiClient();
    await benWeb.signIn(ben.address, PASSWORD);
    const [[, refused]] = await call(benWeb, [['Email/set', { accountId: team.address, update: { [id]: { 'keywords/$flagged': true } } }, 's']]);
    expect(Object.keys((refused.notUpdated ?? {}) as object)).toEqual([id]);
    // Someone else cannot reach it at all.
    const out = new ApiClient();
    await out.signIn(outsider, PASSWORD);
    expect((await out.request('POST', '/api/jmap/', { using: USING, methodCalls: [['Email/query', { accountId: team.address }, 'q']] })).status).toBe(403);
  });

  it('sends as the shared mailbox from its account, files it in its Sent, and can name the sender', async () => {
    await admin.ok('PUT', `/api/orgs/${orgId}/mail-options`, { sharedSenderHeader: true });
    const subject = unique('from-support');
    const [[, drafts]] = await call(annWeb, [['Mailbox/query', { accountId: team.address, filter: { role: 'drafts' } }, 'd']]);
    const [[, created]] = await call(annWeb, [
      [
        'Email/set',
        {
          accountId: team.address,
          create: {
            d: {
              mailboxIds: { [(drafts.ids as string[])[0]!]: true },
              keywords: { $draft: true, $seen: true },
              from: [{ name: 'Support', email: team.address }],
              to: [{ email: outsider }],
              subject,
              bodyValues: { b: { value: 'We are on it.' } },
              textBody: [{ partId: 'b', type: 'text/plain' }],
            },
          },
        },
        's',
      ],
    ]);
    const emailId = ((created.created as Record<string, { id: string }>).d).id;
    const result = await annWeb.ok<{ sent: boolean; movedToSent: boolean }>('POST', '/api/mail/send', { emailId, accountId: team.address });
    expect(result).toEqual({ sent: true, movedToSent: true });

    const received = await waitForMessage(outsider, PASSWORD, subject);
    expect(received).toMatch(/^From: "?Support"? <support@/m);
    expect(received).toMatch(new RegExp(`^Sender: .*<${ann.address.replace(/\./g, '\\.')}>`, 'm'));
    await waitForMessage(ann.address, PASSWORD, subject, 20_000, 'Other Users/support/Sent');

    const audit = await admin.ok<{ data: { action: string; details: { by: string } }[] }>('GET', `/api/orgs/${orgId}/audit`);
    expect(audit.data.find((e) => e.action === 'mail.sent_as_shared')?.details.by).toBe(ann.address);

    // A reader may not send from it.
    const benWeb = new ApiClient();
    await benWeb.signIn(ben.address, PASSWORD);
    expect((await benWeb.request('POST', '/api/mail/send', { emailId, accountId: team.address })).status).toBe(403);
  });

  it('takes it away at once from a removed member, even with the folder open in IMAP', async () => {
    const client = await imapLogin(ben.address, PASSWORD);
    let closed = false;
    client.on('close', () => (closed = true));
    const lock = await client.getMailboxLock('Other Users/support');
    await admin.ok('DELETE', `/api/orgs/${orgId}/mailboxes/${team.id}/members/${ben.userId}`);
    expect(await eventually(() => closed, 15_000)).toBe(true);
    lock.release();
    const again = await imapLogin(ben.address, PASSWORD);
    expect((await again.list()).map((m) => m.path)).not.toContain('Other Users/support');
    await again.logout();
  });
});
