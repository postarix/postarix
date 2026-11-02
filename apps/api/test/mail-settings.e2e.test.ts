import type { INestApplication } from '@nestjs/common';
import type { MemoryMailEngine } from '@postarix/mail-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_ENGINE } from '../src/core/tokens.js';
import { mailboxInNewOrg, signUp, startApp } from './helpers.js';

describe('Automatic reply and forwarding', () => {
  let app: INestApplication;
  let engine: MemoryMailEngine;
  let ana: Awaited<ReturnType<typeof mailboxInNewOrg>>;
  let bea: Awaited<ReturnType<typeof mailboxInNewOrg>>;

  const settings = {
    vacation: { enabled: true, subject: 'Away', message: 'Back on Monday.', until: '2030-01-31' },
    forwarding: { enabled: true, address: 'ana.private@elsewhere.example', keepCopy: true },
  };

  beforeAll(async () => {
    app = await startApp();
    engine = app.get<MemoryMailEngine>(MAIL_ENGINE);
    ana = await mailboxInNewOrg(app, 'ms-a', 'ana');
    bea = await mailboxInNewOrg(app, 'ms-b', 'bea');
  });
  afterAll(async () => {
    await app.close();
  });

  it('start switched off', async () => {
    const res = await ana.agent.get('/api/me/mail-settings').expect(200);
    expect(res.body).toMatchObject({ vacation: { enabled: false }, forwarding: { enabled: false }, otherFiltersActive: false });
  });

  it('are saved as an active Sieve script of the user’s own mailbox only', async () => {
    const res = await ana.agent.put('/api/me/mail-settings').send(settings).expect(200);
    expect(res.body).toMatchObject({ ...settings, otherFiltersActive: false });
    const script = engine.sieve.get(ana.address)?.get('postarix-settings');
    expect(script?.active).toBe(true);
    expect(script?.content).toContain('redirect :copy "ana.private@elsewhere.example";');
    // Nothing reaches another person's mailbox.
    expect(engine.sieve.get(bea.address)?.size ?? 0).toBe(0);
    expect((await bea.agent.get('/api/me/mail-settings').expect(200)).body.vacation.enabled).toBe(false);
  });

  it('report a filter from a mail app that saving would replace', async () => {
    await engine.writeSieveScript(bea.address, 'thunderbird', 'require ["fileinto"];\nfileinto "Lists";\n', { activate: true });
    expect((await bea.agent.get('/api/me/mail-settings').expect(200)).body.otherFiltersActive).toBe(true);
    await bea.agent.put('/api/me/mail-settings').send({ ...settings, forwarding: { enabled: false, address: '', keepCopy: true } }).expect(200);
    expect(engine.sieve.get(bea.address)?.get('thunderbird')?.active).toBe(false);
  });

  it('remove the script when everything is switched off', async () => {
    await ana.agent
      .put('/api/me/mail-settings')
      .send({ vacation: { ...settings.vacation, enabled: false }, forwarding: { ...settings.forwarding, enabled: false } })
      .expect(200);
    expect(engine.sieve.get(ana.address)?.has('postarix-settings')).toBe(false);
  });

  it('refuse invalid settings, forwarding to oneself, and people without a mailbox', async () => {
    await ana.agent.put('/api/me/mail-settings').send({ ...settings, forwarding: { enabled: true, address: 'nope', keepCopy: true } }).expect(400);
    await ana.agent.put('/api/me/mail-settings').send({ ...settings, forwarding: { enabled: true, address: ana.address, keepCopy: false } }).expect(422);
    await ana.agent.put('/api/me/mail-settings').send({ ...settings, extra: true }).expect(400);
    const nobody = await signUp(app, 'ms-nobody');
    await nobody.agent.get('/api/me/mail-settings').expect(404);
    await ana.owner.agent.get('/api/me/mail-settings').expect(404);
  });
});
