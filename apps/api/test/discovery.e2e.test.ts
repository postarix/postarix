import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mtaStsPolicyId } from '../src/discovery/discovery.js';
import { createOrg, signUp, startApp } from './helpers.js';

describe('Mail client discovery and MTA-STS', () => {
  let app: INestApplication;
  let hosted: string;
  let pending: string;

  beforeAll(async () => {
    app = await startApp();
    const admin = await signUp(app, 'disco-admin');
    const orgId = await createOrg(admin, 'Disco');
    const a = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `disco-${Date.now()}.example` });
    await admin.agent.post(`/api/orgs/${orgId}/domains/${a.body.id}/verify`).expect(200);
    hosted = a.body.name;
    const p = await admin.agent.post(`/api/orgs/${orgId}/domains`).send({ name: `disco-p-${Date.now()}.example` });
    pending = p.body.name;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => request(app.getHttpServer());

  it('serves Thunderbird autoconfig for hosted domains only', async () => {
    const res = await server().get('/.well-known/autoconfig/mail/config-v1.1.xml').query({ emailaddress: `ann@${hosted}` }).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain(`<domain>${hosted}</domain>`);
    expect(res.text).toContain('<port>993</port>');
    expect(res.text).toContain('/dav/calendars/user/%EMAILADDRESS%/');
    await server().get('/mail/config-v1.1.xml').set('host', `autoconfig.${hosted}`).expect(200);
    await server().get('/.well-known/autoconfig/mail/config-v1.1.xml').query({ emailaddress: `ann@${pending}` }).expect(404);
    await server().get('/.well-known/autoconfig/mail/config-v1.1.xml').query({ emailaddress: 'ann@elsewhere.example' }).expect(404);
    await server().get(`/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=a@${hosted}&emailaddress=b@${hosted}`).expect(404);
  });

  it('answers Outlook Autodiscover with escaped values', async () => {
    const body = `<?xml version="1.0"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>ann@${hosted}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
    const res = await server().post('/autodiscover/autodiscover.xml').set('content-type', 'text/xml').send(body).expect(200);
    expect(res.text).toContain(`<LoginName>ann@${hosted}</LoginName>`);
    expect(res.text).toContain('<Type>IMAP</Type>');
    await server().post('/Autodiscover/Autodiscover.xml').set('content-type', 'text/xml').send(body).expect(200);
    await server()
      .post('/autodiscover/autodiscover.xml')
      .set('content-type', 'text/xml')
      .send(body.replace(hosted, 'elsewhere.example'))
      .expect(404);
  });

  it('serves the MTA-STS policy on mta-sts.<domain> for hosted domains', async () => {
    const res = await server().get('/.well-known/mta-sts.txt').set('host', `mta-sts.${hosted}`).expect(200);
    expect(res.text).toBe('version: STSv1\nmode: testing\nmx: mail.example.test\nmax_age: 604800\n');
    await server().get('/.well-known/mta-sts.txt').set('host', `mta-sts.${pending}`).expect(404);
    await server().get('/.well-known/mta-sts.txt').set('host', hosted).expect(404);
    expect(mtaStsPolicyId(res.text)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the API itself under /api', async () => {
    await server().get('/health').expect(404);
    await server().get('/api/health').expect(200);
  });
});
