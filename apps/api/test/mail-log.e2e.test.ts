import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, mailboxInNewOrg, signUp, startApp, type TestUser } from './helpers.js';

describe('Filtering history per organization', () => {
  let app: INestApplication;
  let rspamd: Server;
  let seenPassword: string | undefined;
  let a: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let b: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let member: TestUser;
  let rows: Record<string, unknown>[] = [];
  const saved = { url: process.env.RSPAMD_CONTROLLER_URL, password: process.env.RSPAMD_CONTROLLER_PASSWORD };

  beforeAll(async () => {
    rspamd = createServer((req, res) => {
      seenPassword = req.headers.password as string | undefined;
      if (!req.url?.startsWith('/history')) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 2, rows }));
    });
    await new Promise<void>((resolve) => rspamd.listen(0, '127.0.0.1', resolve));
    process.env.RSPAMD_CONTROLLER_URL = `http://127.0.0.1:${(rspamd.address() as AddressInfo).port}`;
    process.env.RSPAMD_CONTROLLER_PASSWORD = 'controller-secret';
    app = await startApp();
    a = await mailboxInNewOrg(app, 'log-a', 'ana');
    b = await mailboxInNewOrg(app, 'log-b', 'bea');
    member = await signUp(app, 'log-member');
    await addMember(app, a.orgId, member.id, 'member');
    const t = 1_790_000_000;
    rows = [
      // Incoming to A, also addressed to B: A sees only its own recipient.
      { unix_time: t, 'message-id': 'm1', sender_smtp: 'x@outside.example', rcpt_smtp: [a.address, b.address], subject: 'Hello', action: 'no action', score: 1.2, required_score: 15, ip: '203.0.113.9', symbols: { R_SPF_ALLOW: { score: -0.2 }, MIME_GOOD: { score: 0.1 } } },
      // Spam to A.
      { unix_time: t + 10, 'message-id': 'm2', sender_smtp: 'spam@bad.example', rcpt_smtp: [a.address], subject: 'Win', action: 'reject', score: 22, required_score: 15, symbols: { BAYES_SPAM: { score: 5 }, RBL_SPAMHAUS: { score: 7 } } },
      // Sent by A's account.
      { unix_time: t + 20, 'message-id': 'm3', sender_smtp: a.address, rcpt_smtp: ['friend@outside.example'], subject: 'Re: Hello', action: 'no action', score: 0, user: a.address },
      // Only B.
      { unix_time: t + 30, 'message-id': 'm4', sender_smtp: 'x@outside.example', rcpt_smtp: [b.address], subject: 'For B', action: 'add header', score: 8 },
      // Someone outside claiming A's domain, to an outside recipient: not A's mail.
      { unix_time: t + 40, 'message-id': 'm5', sender_smtp: `ceo@${a.domainName}`, rcpt_smtp: ['victim@outside.example'], subject: 'Spoof', action: 'reject', score: 30, user: 'unknown' },
    ];
  });

  afterAll(async () => {
    await app.close();
    rspamd.close();
    Object.assign(process.env, { RSPAMD_CONTROLLER_URL: saved.url, RSPAMD_CONTROLLER_PASSWORD: saved.password });
  });

  it('shows an organization its own mail only, newest first, in plain outcomes', async () => {
    const res = await a.owner.agent.get(`/api/orgs/${a.orgId}/mail-log`).expect(200);
    expect(seenPassword).toBe('controller-secret');
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual(['m3', 'm2', 'm1']);
    const [sent, spam, hello] = res.body.data;
    expect(sent).toMatchObject({ direction: 'out', to: ['friend@outside.example'], ip: null });
    expect(spam).toMatchObject({ direction: 'in', outcome: 'rejected', reasons: [{ name: 'RBL_SPAMHAUS', score: 7 }, { name: 'BAYES_SPAM', score: 5 }] });
    expect(hello).toMatchObject({ to: [a.address], outcome: 'delivered', ip: '203.0.113.9' });
    expect(JSON.stringify(res.body)).not.toContain(b.address);

    const other = await b.owner.agent.get(`/api/orgs/${b.orgId}/mail-log`).expect(200);
    expect(other.body.data.map((e: { id: string }) => e.id)).toEqual(['m4', 'm1']);
    expect(other.body.data[1].to).toEqual([b.address]);
  });

  it('is for organization admins, and invisible to other organizations', async () => {
    await member.agent.get(`/api/orgs/${a.orgId}/mail-log`).expect(403);
    await b.owner.agent.get(`/api/orgs/${a.orgId}/mail-log`).expect(404);
    // A mailbox owner is a plain member of the organization.
    await a.agent.get(`/api/orgs/${a.orgId}/mail-log`).expect(403);
    await a.owner.agent.get(`/api/orgs/${a.orgId}/mail-log?limit=9999`).expect(400);
  });

  it('reports an unreachable spam filter as unavailable', async () => {
    const url = process.env.RSPAMD_CONTROLLER_URL;
    rspamd.close();
    await a.owner.agent.get(`/api/orgs/${a.orgId}/mail-log`).expect(503);
    process.env.RSPAMD_CONTROLLER_URL = url;
  });
});
