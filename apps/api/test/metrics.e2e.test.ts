import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMetricsServer } from '../src/metrics/metrics.js';
import { newAgent, signUp, startApp } from './helpers.js';

describe('Prometheus metrics', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    app = await startApp();
    // A random port, retried if another test process holds it.
    for (let attempt = 0; !server; attempt++) {
      try {
        server = (await startMetricsServer({ port: 30_000 + Math.floor(Math.random() * 20_000) }))!;
      } catch (error) {
        if (attempt >= 10 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
  });

  afterAll(async () => {
    server.close();
    await app.close();
  });

  const scrape = async () => (await request(server).get('/metrics').expect(200)).text;

  it('is off without METRICS_PORT', async () => {
    expect(await startMetricsServer({ port: undefined })).toBeUndefined();
  });

  it('counts requests by route pattern, never by raw path', async () => {
    const owner = await signUp(app, 'metrics');
    await owner.agent.get(`/api/orgs/${crypto.randomUUID()}/mailboxes`).expect(404);
    await request(app.getHttpServer()).get('/api/health').expect(200);
    const text = await scrape();
    expect(text).toMatch(/postarix_http_requests_total\{method="GET",route="\/api\/health",status="200"\} \d+/);
    expect(text).toContain('route="/api/orgs/:orgId/mailboxes"');
    expect(text).not.toMatch(/route="\/api\/orgs\/[0-9a-f-]{36}/);
    expect(text).toContain('postarix_api_process_cpu_seconds_total');
  });

  it('counts web sign-ins by result', async () => {
    const before = await scrape();
    const failures = Number(before.match(/postarix_web_sign_ins_total\{result="failure"\} (\d+)/)?.[1] ?? 0);
    await newAgent(app).post('/api/auth/sign-in/email').send({ email: 'nobody@metrics.example', password: 'wrong password!' }).expect(401);
    const after = await scrape();
    expect(Number(after.match(/postarix_web_sign_ins_total\{result="failure"\} (\d+)/)?.[1])).toBe(failures + 1);
  });

  it('answers nothing but /metrics', async () => {
    await request(server).get('/').expect(404);
    await request(server).post('/metrics').expect(404);
    // Rspamd's metrics are relayed only when its controller is configured.
    await request(server).get('/metrics/rspamd').expect(404);
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  });
});
