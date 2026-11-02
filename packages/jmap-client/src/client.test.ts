import { describe, expect, it } from 'vitest';
import { JmapClient, JmapMethodError, JmapRequestError } from './client';

const session = {
  apiUrl: 'https://mail.example.com/api/jmap/',
  downloadUrl: 'https://mail.example.com/api/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  uploadUrl: 'https://mail.example.com/api/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/api/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
  username: 'ann@example.com',
  state: 's1',
  capabilities: {},
  accounts: {},
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'ann@example.com' },
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

describe('JmapClient', () => {
  it('loads the session once and batches calls with back-references', async () => {
    const { impl, calls } = fakeFetch((url, init) => {
      if (url === '/api/jmap/') return Response.json(session);
      const body = JSON.parse(String(init.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      expect(body.methodCalls[1]![1]['#ids']).toEqual({ resultOf: 'c0', name: 'Email/query', path: '/ids' });
      return Response.json({ methodResponses: [['Email/query', { ids: ['a'] }, 'c0'], ['Email/get', { list: [{ id: 'a' }] }, 'c1']] });
    });
    const client = new JmapClient({ sessionUrl: '/api/jmap/', fetch: impl });
    const accountId = await client.accountId();
    const results = await client.batch((b) => {
      const q = b.add('Email/query', { accountId });
      b.add('Email/get', { accountId, '#ids': b.ref(q, 'Email/query', '/ids') });
    });
    expect(results.get('c1')).toEqual({ list: [{ id: 'a' }] });
    expect(calls.filter((c) => c.url === '/api/jmap/' && c.init.method === 'GET')).toHaveLength(1);
    expect(calls.every((c) => c.init.credentials === 'same-origin')).toBe(true);
  });

  it('turns method errors and HTTP errors into exceptions', async () => {
    const { impl } = fakeFetch((url) =>
      url === '/api/jmap/'
        ? Response.json(session)
        : Response.json({ methodResponses: [['error', { type: 'invalidArguments', description: 'bad' }, 'c0']] }),
    );
    const client = new JmapClient({ sessionUrl: '/api/jmap/', fetch: impl });
    await expect(client.call('Mailbox/get')).rejects.toBeInstanceOf(JmapMethodError);

    const failing = new JmapClient({
      sessionUrl: '/api/jmap/',
      fetch: fakeFetch(() => Response.json({ message: 'Sign in first' }, { status: 401 })).impl,
    });
    await expect(failing.session()).rejects.toMatchObject({ status: 401, message: 'Sign in first' });
    await expect(failing.session()).rejects.toBeInstanceOf(JmapRequestError);
  });

  it('fills in upload, download and event URLs', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url === '/api/jmap/' ? Response.json(session) : Response.json({ blobId: 'B1', type: 'text/plain', size: 2 }),
    );
    const client = new JmapClient({ sessionUrl: '/api/jmap/', fetch: impl });
    expect(await client.upload(new Blob(['hi'], { type: 'text/plain' }))).toEqual({ blobId: 'B1', type: 'text/plain', size: 2 });
    expect(calls[1]!.url).toBe('https://mail.example.com/api/jmap/upload/ann%40example.com/');
    expect(await client.downloadUrl('B1', 'a b.pdf', 'application/pdf')).toBe(
      'https://mail.example.com/api/jmap/download/ann%40example.com/B1/a%20b.pdf?accept=application%2Fpdf',
    );
    expect(await client.eventSourceUrl(['Email', 'Mailbox'])).toBe(
      'https://mail.example.com/api/jmap/eventsource/?types=Email,Mailbox&closeafter=no&ping=60',
    );
  });
});
