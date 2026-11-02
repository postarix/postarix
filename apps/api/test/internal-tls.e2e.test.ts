import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Agent, fetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalSecret } from '../src/config/internal-secrets.js';
import type { Env } from '../src/config/env.js';
import { ENV } from '../src/core/tokens.js';
import { startInternalTls } from '../src/internal-tls.js';
import { startApp } from './helpers.js';

/** The mail-login bridge only answers over the internal HTTPS listener when it is on. */
describe('Internal HTTPS listener', () => {
  let app: INestApplication;
  let server: Server | null;
  let cert: string;
  const port = 34000 + Math.floor(Math.random() * 1000);
  const saved = { ...process.env };
  const header = internalSecret('internal-test-token-that-is-long-enough', 'mail-auth');

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postarix-tls-'));
    cert = join(dir, 'fullchain.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mail.example.test',
      '-addext', 'subjectAltName=DNS:mail.example.test', '-keyout', join(dir, 'privkey.pem'), '-out', cert], { stdio: 'ignore' });
    Object.assign(process.env, { INTERNAL_TLS_CERT_FILE: cert, INTERNAL_TLS_KEY_FILE: join(dir, 'privkey.pem'), INTERNAL_TLS_PORT: String(port) });
    app = await startApp();
    server = await startInternalTls(app, app.get<Env>(ENV));
  });
  afterAll(async () => {
    server?.close();
    await app.close();
    process.env = saved;
  });

  it('refuses the bridge in clear, as if it did not exist', async () => {
    await request(app.getHttpServer())
      .post('/api/internal/mail-auth')
      .type('form')
      .set('x-postarix-internal-token', header)
      .send({ username: 'nobody@example.test', password: 'x', service: 'imap' })
      .expect(404);
  });

  it('answers it over TLS, with the mail server certificate', async () => {
    const { readFileSync } = await import('node:fs');
    const dispatcher = new Agent({ connect: { ca: readFileSync(cert, 'utf8'), servername: 'mail.example.test' } });
    const res = await fetch(`https://127.0.0.1:${port}/api/internal/mail-auth`, {
      method: 'POST',
      dispatcher,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-postarix-internal-token': header },
      body: 'username=nobody%40example.test&password=x&service=imap',
    });
    // Reached the bridge: an unknown user is refused (not 404).
    expect(res.status).toBe(401);
    await dispatcher.close();
  });
});
