import { readFileSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi } from '../src/openapi/openapi.js';
import { startApp } from './helpers.js';

const PUBLISHED = new URL('../../../docs/public/openapi.json', import.meta.url);

describe('OpenAPI description', () => {
  let app: INestApplication;
  let spec: { paths: Record<string, Record<string, { summary: string; description?: string; parameters?: { name: string; in: string }[] }>> };

  beforeAll(async () => {
    app = await startApp();
    spec = buildOpenApi(app, 'docs') as typeof spec;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is served, with a browsable reference', async () => {
    const json = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(json.body.openapi).toBe('3.1.0');
    const page = await request(app.getHttpServer()).get('/api/docs').expect(200);
    expect(page.text).toContain('swagger-ui-bundle.js');
    await request(app.getHttpServer()).get('/api/docs/swagger-ui-bundle.js').expect(200);
    await request(app.getHttpServer()).get('/api/docs/package.json').expect(404);
  });

  it('describes every route but the internal ones, with their parameters', () => {
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(120);
    expect(paths.some((p) => p.includes('/internal'))).toBe(false);
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const operation of Object.values(operations)) {
        expect(operation.summary, path).toBeTruthy();
        for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
          expect(operation.parameters?.some((p) => p.in === 'path' && p.name === name), `${path} {${name}}`).toBe(true);
        }
      }
    }
    // Request bodies come from the validating schemas.
    const createMailbox = spec.paths['/api/orgs/{orgId}/mailboxes']!.post as unknown as { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } };
    expect(Object.keys(createMailbox.requestBody.content['application/json']!.schema.properties)).toEqual(expect.arrayContaining(['domainId', 'localPart', 'kind', 'sharedSeen']));
  });

  it('explains the routes connected applications use', () => {
    for (const [path, method] of [
      ['/api/oauth/token', 'post'],
      ['/api/mail/send', 'post'],
      ['/api/mail/identities', 'get'],
      ['/api/mail/messages/{emailId}', 'get'],
      ['/api/mail/unread', 'post'],
      ['/api/jmap/', 'post'],
      ['/api/orgs/{orgId}/identities', 'post'],
      ['/api/orgs/{orgId}/apps', 'post'],
      ['/api/orgs/{orgId}/mailboxes/{mailboxId}/members/{userId}', 'put'],
    ] as const) {
      expect(spec.paths[path]?.[method]?.description, `${method} ${path}`).toBeTruthy();
    }
  });

  // docs/public/openapi.json is what the documentation site publishes: it must
  // match the code. Regenerate with: pnpm --filter @postarix/api openapi:update
  it('is published up to date in the documentation', () => {
    const current = `${JSON.stringify(spec, null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) writeFileSync(PUBLISHED, current);
    let published = '';
    try {
      published = readFileSync(PUBLISHED, 'utf8');
    } catch {
      // Missing: reported below.
    }
    expect(published === current, 'docs/public/openapi.json is out of date: run pnpm --filter @postarix/api openapi:update').toBe(true);
  });
});
