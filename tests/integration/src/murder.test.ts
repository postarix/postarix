import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique, waitForMessage } from './support.js';

const PASSWORD = 'murder mailbox password';

/** Runs a query in the stack's PostgreSQL (found by its compose service label). */
function sql(query: string): string {
  const id = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.service=postgres']).toString().trim().split('\n')[0]!;
  return execFileSync('docker', ['exec', id, 'psql', '-U', 'postarix', '-d', 'postarix', '-tAc', query]).toString().trim();
}

// Only with a Cyrus Murder (MURDER=1 tests/integration/run.sh). The rest of the
// suite runs against it as well: the frontend is where clients connect.
describe.skipIf(!process.env.MURDER)('Cyrus Murder', () => {
  const admin = new ApiClient();
  const people: { address: string; client: ApiClient; org: string }[] = [];
  const serverOf = (address: string) => sql(`SELECT mail_server FROM mailboxes WHERE address = '${address}'`);

  async function organization(localParts: string[]) {
    const org = await admin.ok<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Murder', slug: unique('murder') });
    const domain = await admin.ok<{ id: string }>('POST', `/api/orgs/${org.id}/domains`, { name: `${unique('murder')}.test` });
    await admin.ok('POST', `/api/orgs/${org.id}/domains/${domain.id}/verify`);
    for (const localPart of localParts) {
      const { address } = await admin.ok<{ address: string }>('POST', `/api/orgs/${org.id}/mailboxes`, { domainId: domain.id, localPart, password: PASSWORD });
      const client = new ApiClient();
      await client.signIn(address, PASSWORD);
      people.push({ address, client, org: org.id });
    }
  }

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
    await organization(['ana', 'bea']);
    // New organizations go to the emptiest backend, so both end up in use.
    for (let i = 0; i < 8 && new Set(people.map((p) => serverOf(p.address))).size < 2; i++) await organization(['carmen']);
  });

  it('keeps an organization on one backend and spreads organizations over the backends', () => {
    expect(serverOf(people[0]!.address)).toBe(serverOf(people[1]!.address));
    expect(new Set(people.map((p) => serverOf(p.address)))).toEqual(new Set(['b1', 'b2']));
  });

  it('delivers mail to, and serves it from, every backend through the frontend', async () => {
    for (const { address } of people) {
      const subject = unique('murder-mail');
      await smtp(config.smtpPort).sendMail({ from: 'someone@outside.example', to: address, subject, text: 'Routed by the Murder' });
      await waitForMessage(address, PASSWORD, subject);
    }
  });

  it('serves each person’s mail and calendar to the webmail from their backend', async () => {
    for (const { address, client } of people) {
      const { methodResponses } = await client.ok<{ methodResponses: [string, Record<string, unknown>, string][] }>('POST', '/api/jmap/', {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:calendars'],
        methodCalls: [
          ['Mailbox/get', { accountId: address, properties: ['role'] }, 'm'],
          ['Calendar/get', { accountId: address, properties: ['id'] }, 'c'],
        ],
      });
      expect(methodResponses.map(([name]) => name)).toEqual(['Mailbox/get', 'Calendar/get']);
    }
  });
});
