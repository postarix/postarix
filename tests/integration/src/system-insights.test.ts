import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, config } from './support.js';

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

interface LogEntry {
  time: string | null;
  level: string;
  source: string | null;
  message: string;
}

// Every service's log reaches the admin panel, and Rspamd's own web interface
// opens with an administrator's session.
describe('Logs of every service, Rspamd for administrators', () => {
  const admin = new ApiClient();

  beforeAll(async () => {
    await admin.signIn(config.adminEmail, config.adminPassword);
  });

  it('shows the logs of Rspamd, Unbound and the API, parsed', async () => {
    for (const service of ['rspamd', 'unbound', 'api']) {
      const logs = await eventually(
        () => admin.ok<{ data: LogEntry[] }>('GET', `/api/system/log-entries/${service}`),
        (l) => l.data.length > 0,
      );
      expect(logs.data.length, `${service} has log lines`).toBeGreaterThan(0);
      expect(logs.data.some((e) => e.time !== null), `${service} lines have times`).toBe(true);
    }
    const status = await admin.ok<{ data: { name: string; state: string }[] }>('GET', '/api/system/status');
    expect(status.data.find((s) => s.name === 'unbound')?.state).toBe('ok');
  });

  it('opens Rspamd’s web interface, and its API, to an instance administrator', async () => {
    const page = await admin.raw('/api/rspamd-ui/');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/rspamd/i);
    const stat = await admin.ok<{ scanned?: number; version?: string }>('GET', '/api/rspamd-ui/stat');
    expect(stat.version).toBeTruthy();
    const history = await admin.ok<{ data: unknown[] }>('GET', '/api/system/rspamd/history?limit=5');
    expect(Array.isArray(history.data)).toBe(true);
    const anonymous = new ApiClient();
    expect((await anonymous.raw('/api/rspamd-ui/stat')).status).toBe(404);
  });
});
