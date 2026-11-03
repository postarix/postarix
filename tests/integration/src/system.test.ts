import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config, smtp, unique } from './support.js';

interface Status {
  name: string;
  state: string;
  version: string | null;
  disk: { totalBytes: number } | null;
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

// The mail containers report their logs, state and queue to the API.
describe('System reports', () => {
  const admin = new ApiClient();

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
  });

  it('shows Postfix and Cyrus as running, with their versions and disk use', async () => {
    const status = await eventually(
      () => admin.ok<{ data: Status[] }>('GET', '/api/system/status'),
      (s) => ['postfix', 'cyrus'].every((name) => s.data.find((x) => x.name === name)?.state === 'ok'),
    );
    for (const name of ['postfix', 'cyrus', 'postgres', 'api']) {
      expect(status.data.find((s) => s.name === name)?.state).toBe('ok');
    }
    expect(status.data.find((s) => s.name === 'postfix')?.version).toMatch(/^Postfix \d/);
    expect(status.data.find((s) => s.name === 'cyrus')?.version).toMatch(/cyrus-imapd/);
    expect(status.data.find((s) => s.name === 'cyrus')?.disk?.totalBytes).toBeGreaterThan(0);
  });

  it("shows Postfix' log lines", async () => {
    const marker = unique('log-marker');
    // A refused recipient writes the address into Postfix' log.
    await smtp(config.smtpPort)
      .sendMail({ from: 'someone@outside.example', to: `${marker}@unknown-domain.example`, subject: 'x', text: 'x' })
      .catch(() => undefined);
    const logs = await eventually(
      () => admin.ok<{ data: string[] }>('GET', `/api/system/logs/postfix?filter=${marker}`),
      (l) => l.data.length > 0,
    );
    expect(logs.data.join('\n')).toContain(marker);
  });

  it('shows the mail queue as Postfix last reported it', async () => {
    const queue = await eventually(
      () => admin.ok<{ at: string | null; items: unknown[] }>('GET', '/api/system/queue'),
      (q) => q.at !== null,
    );
    expect(queue.at).not.toBeNull();
    await admin.ok('POST', '/api/system/queue', { action: 'flush' });
  });
});
