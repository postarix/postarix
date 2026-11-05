import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, imapLogin, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'connected apps test password';
const ISSUER = 'https://helpdesk.example.test';
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const EXTERNAL = 'urn:postarix:params:oauth:token-type:external-subject';
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
type MethodResponse = [string, Record<string, unknown>, string];

describe('Connected applications on the real mail server', () => {
  const admin = new ApiClient();
  let orgId: string;
  let ann: { id: string; userId: string; address: string };
  let boss: { id: string; userId: string; address: string };
  let client: { clientId: string; clientSecret: string };

  const tokenFor = async (fields: Record<string, string>) => {
    const res = await fetch(`${config.apiUrl}/api/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(fields),
    });
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok) throw new Error(`token: ${res.status} ${JSON.stringify(body)}`);
    return body.access_token!;
  };
  const bearer = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${config.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  const jmap = async (token: string, methodCalls: [string, Record<string, unknown>, string][]) => {
    const res = await bearer(token, '/api/jmap/', { method: 'POST', body: { using: USING, methodCalls } });
    return { status: res.status, responses: res.ok ? ((await res.json()) as { methodResponses: MethodResponse[] }).methodResponses : [] };
  };

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    orgId = (await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Apps', slug: unique('apps') })).id;
    const domainId = (await admin.ok<{ id: string }>('POST', `/api/orgs/${orgId}/domains`, { name: `${unique('ca')}.test` })).id;
    await admin.ok('POST', `/api/orgs/${orgId}/domains/${domainId}/verify`);
    const person = (localPart: string) => admin.ok<{ id: string; userId: string; address: string }>('POST', `/api/orgs/${orgId}/mailboxes`, { domainId, localPart, password: PASSWORD });
    ann = await person('ann');
    boss = await person('boss');
    await admin.ok('POST', `/api/orgs/${orgId}/identities`, { mailboxId: ann.id, issuer: ISSUER, subject: 'u-ann' });
    await admin.ok('POST', `/api/orgs/${orgId}/identities`, { mailboxId: boss.id, issuer: ISSUER, subject: 'u-boss' });
    client = await admin.ok('POST', `/api/orgs/${orgId}/apps`, {
      name: 'Helpdesk',
      identityIssuer: ISSUER,
      scopes: ['mail.read', 'mail.write', 'mail.send', 'mail.supervise'],
    });
  });

  it('reads, writes and sends as the person with a token', async () => {
    const subject = unique('to-ann');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: ann.address, subject, text: 'Hi Ann' });
    await waitForMessage(ann.address, PASSWORD, subject);

    const token = await tokenFor({ grant_type: EXCHANGE, subject_token: 'u-ann', subject_token_type: EXTERNAL, scope: 'mail.read mail.write mail.send' });
    const { responses } = await jmap(token, [
      ['Email/query', { accountId: ann.address, filter: { subject } }, 'q'],
      ['Email/get', { accountId: ann.address, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
    ]);
    const found = responses[1]![1].list as { id: string; subject: string }[];
    expect(found[0]!.subject).toBe(subject);
    const rendered = await bearer(token, `/api/mail/messages/${found[0]!.id}`);
    expect(rendered.status).toBe(200);
    expect(((await rendered.json()) as { text: string }).text).toContain('Hi Ann');

    // A draft, saved and sent as Ann.
    const [[, drafts]] = (await jmap(token, [['Mailbox/query', { accountId: ann.address, filter: { role: 'drafts' } }, 'd']])).responses as [MethodResponse];
    const sentSubject = unique('from-ann-app');
    const created = (await jmap(token, [
      [
        'Email/set',
        {
          accountId: ann.address,
          create: {
            d: {
              mailboxIds: { [(drafts.ids as string[])[0]!]: true },
              keywords: { $draft: true, $seen: true },
              from: [{ email: ann.address }],
              to: [{ email: boss.address }],
              subject: sentSubject,
              bodyValues: { b: { value: 'Sent by the helpdesk.' } },
              textBody: [{ partId: 'b', type: 'text/plain' }],
            },
          },
        },
        's',
      ],
    ])).responses[0]![1].created as Record<string, { id: string }>;
    const send = await bearer(token, '/api/mail/send', { method: 'POST', body: { emailId: created.d!.id } });
    expect(send.status).toBe(200);
    expect(await waitForMessage(boss.address, PASSWORD, sentSubject)).toContain(`From: ${ann.address}`);
  });

  it('supervises read-only: nothing changes the read state', async () => {
    const subject = unique('private');
    await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: ann.address, subject, text: 'Unread on purpose' });
    await waitForMessage(ann.address, PASSWORD, subject);
    await admin.ok('PUT', `/api/orgs/${orgId}/supervision`, { enabled: true, notify: false });
    await admin.ok('PUT', `/api/orgs/${orgId}/supervision/supervisors/${boss.userId}`, {});
    const token = await tokenFor({
      grant_type: EXCHANGE,
      subject_token: 'u-ann',
      subject_token_type: EXTERNAL,
      actor_token: 'u-boss',
      actor_token_type: EXTERNAL,
      scope: 'mail.supervise',
      reason: 'Reviewing a complaint',
    });
    const { responses } = await jmap(token, [
      ['Email/query', { accountId: ann.address, filter: { subject } }, 'q'],
      ['Email/get', { accountId: ann.address, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['keywords', 'blobId'] }, 'g'],
    ]);
    const email = (responses[1]![1].list as { id: string; keywords: Record<string, boolean>; blobId: string }[])[0]!;
    expect(email.keywords.$seen).toBeUndefined();
    // Read it every way supervision allows.
    expect((await bearer(token, `/api/mail/messages/${email.id}`)).status).toBe(200);
    expect((await bearer(token, `/api/jmap/download/${encodeURIComponent(ann.address)}/${email.blobId}/m.eml`)).status).toBe(200);
    expect((await jmap(token, [['Email/set', { accountId: ann.address, update: { [email.id]: { 'keywords/$seen': true } } }, 's']])).status).toBe(403);
    // Still unread, for Ann's own mail app too.
    const imap = await imapLogin(ann.address, PASSWORD);
    const lock = await imap.getMailboxLock('INBOX');
    const uids = await imap.search({ subject }, { uid: true });
    const flags = await imap.fetchOne(String((uids || [])[0]), { flags: true }, { uid: true });
    expect(flags && [...(flags.flags ?? [])]).not.toContain('\\Seen');
    lock.release();
    await imap.logout();
  });

  it('counts unread mail for many people at once', async () => {
    const appToken = await tokenFor({ grant_type: 'client_credentials', scope: 'mail.read' });
    const res = await bearer(appToken, '/api/mail/unread', { method: 'POST', body: { subjects: ['u-ann', 'u-boss', 'u-nobody'] } });
    const data = ((await res.json()) as { data: { subject: string; inbox: number | null }[] }).data;
    expect(data.find((d) => d.subject === 'u-ann')!.inbox).toBeGreaterThanOrEqual(1);
    expect(data.find((d) => d.subject === 'u-nobody')!.inbox).toBeNull();
  });
});
