import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'webmail mailbox password';
const MAIL = 'urn:ietf:params:jmap:mail';
const USING = ['urn:ietf:params:jmap:core', MAIL];

interface Session {
  apiUrl: string;
  downloadUrl: string;
  primaryAccounts: Record<string, string>;
}

type MethodResponse = [string, Record<string, unknown>, string];

/** JMAP through the API, signed in as a mailbox owner (what the webmail does). */
class Webmail {
  readonly api = new ApiClient();
  session!: Session;
  constructor(readonly address: string) {}

  async open(): Promise<void> {
    await this.api.signIn(this.address, PASSWORD);
    this.session = await this.api.ok<Session>('GET', '/api/jmap/');
  }

  get accountId(): string {
    return this.session.primaryAccounts[MAIL]!;
  }

  async call(methodCalls: [string, Record<string, unknown>, string][]): Promise<MethodResponse[]> {
    const res = await this.api.ok<{ methodResponses: MethodResponse[] }>('POST', '/api/jmap/', {
      using: USING,
      methodCalls,
    });
    return res.methodResponses;
  }
}

describe('Webmail access to mail (JMAP through the API)', () => {
  const admin = new ApiClient();
  let ann: Webmail;
  let ben: Webmail;

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', {
      name: 'Webmail',
      slug: unique('webmail'),
    });
    const domain = await admin.ok<{ id: string; name: string }>('POST', `/api/orgs/${org.id}/domains`, {
      name: `${unique('wm')}.test`,
    });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    const create = async (localPart: string) =>
      (
        await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, {
          domainId: domain.id,
          localPart,
          password: PASSWORD,
        })
      ).address;
    ann = new Webmail(await create('ann'));
    ben = new Webmail(await create('ben'));
    await ann.open();
    await ben.open();
  });

  it('serves a session whose URLs point at the API', () => {
    expect(ann.session.apiUrl).toBe(`${config.apiUrl}/api/jmap/`);
    expect(ann.session.downloadUrl.startsWith(`${config.apiUrl}/api/jmap/download/`)).toBe(true);
    expect(ann.accountId).toBeTruthy();
  });

  it('lists the default folders with their roles', async () => {
    const [[, result]] = (await ann.call([['Mailbox/get', { accountId: ann.accountId }, 'm']])) as [MethodResponse];
    const roles = (result.list as { role: string | null }[]).map((m) => m.role).filter(Boolean).sort();
    expect(roles).toEqual(['archive', 'drafts', 'inbox', 'junk', 'sent', 'trash']);
  });

  it('finds delivered mail and downloads it', async () => {
    const subject = unique('jmap-inbox');
    await smtp(config.smtpPort).sendMail({ from: 'sender@outside.example', to: ann.address, subject, text: 'Hello JMAP' });
    await waitForMessage(ann.address, PASSWORD, subject);

    const responses = await ann.call([
      ['Email/query', { accountId: ann.accountId, filter: { subject } }, 'q'],
      [
        'Email/get',
        { accountId: ann.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'blobId', 'preview'] },
        'g',
      ],
    ]);
    const email = (responses[1]![1].list as { subject: string; blobId: string; preview: string }[])[0]!;
    expect(email.subject).toBe(subject);
    expect(email.preview).toContain('Hello JMAP');

    const url = ann.session.downloadUrl
      .replace('{accountId}', ann.accountId)
      .replace('{blobId}', email.blobId)
      .replace('{name}', 'message.eml')
      .replace('{type}', 'message/rfc822')
      .replace(config.apiUrl, '');
    const download = await ann.api.raw(url);
    expect(download.status).toBe(200);
    expect(download.text).toContain(`Subject: ${subject}`);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);

    // The same blob is out of reach for another user.
    const stolen = await ben.api.raw(url);
    expect(stolen.status).not.toBe(200);
  });

  it("does not let one user read another user's account", async () => {
    const [[name, result]] = (await ben.call([['Mailbox/get', { accountId: ann.accountId }, 'm']])) as [MethodResponse];
    expect(name).toBe('error');
    expect(String(result.type)).toMatch(/accountNotFound|forbidden|accountNotSupportedByMethod/);
  });
});
