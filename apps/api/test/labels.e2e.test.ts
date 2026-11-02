import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labelKeyword } from '../src/labels/labels.service.js';
import { signUp, startApp, type TestUser } from './helpers.js';

describe('Mail labels', () => {
  let app: INestApplication;
  let ana: TestUser;
  let bea: TestUser;

  beforeAll(async () => {
    app = await startApp();
    ana = await signUp(app, 'labels-ana');
    bea = await signUp(app, 'labels-bea');
  });
  afterAll(async () => {
    await app.close();
  });

  it('turn names into keywords mail servers accept', () => {
    expect(labelKeyword('Facturas 2026')).toBe('label-facturas-2026');
    expect(labelKeyword('Café & Té!')).toBe('label-cafe-te');
    expect(labelKeyword('🙂')).toBe('label-x');
  });

  it('are created, listed and removed by their owner only', async () => {
    const created = await ana.agent.post('/api/me/labels').send({ name: 'Invoices' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Invoices', keyword: 'label-invoices' });
    await ana.agent.post('/api/me/labels').send({ name: 'invoices' }).expect(409);
    await ana.agent.post('/api/me/labels').send({ name: '' }).expect(400);
    expect((await ana.agent.get('/api/me/labels').expect(200)).body.data).toHaveLength(1);

    // Someone else sees none of them and cannot remove them.
    expect((await bea.agent.get('/api/me/labels').expect(200)).body.data).toEqual([]);
    await bea.agent.delete(`/api/me/labels/${created.body.id}`).expect(404);
    // The same name is theirs to use too.
    await bea.agent.post('/api/me/labels').send({ name: 'Invoices' }).expect(201);

    await ana.agent.delete(`/api/me/labels/${created.body.id}`).expect(204);
    expect((await ana.agent.get('/api/me/labels').expect(200)).body.data).toEqual([]);
  });
});
