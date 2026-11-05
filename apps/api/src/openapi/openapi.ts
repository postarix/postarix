import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Controller, Get, Header, type INestApplication, Module, NotFoundException, Param, Res, SetMetadata } from '@nestjs/common';
import type { Response } from 'express';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { IS_PUBLIC, Public } from '../auth/session.js';
import { SuperAdminGuard } from '../auth/super-admin.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrgAccessGuard } from '../tenancy/org-access.guard.js';
import { MIN_ORG_ROLE } from '../tenancy/tenant-context.js';

export const API_DOC = 'postarix:apiDoc';

export interface ApiDocOptions {
  summary: string;
  description?: string;
  /** Who may call it besides sessions and API keys. */
  appToken?: string;
}

/** Documents a route in the OpenAPI description (otherwise its summary is derived from its name). */
export const ApiDoc = (options: ApiDocOptions) => SetMetadata(API_DOC, options);

type JsonSchema = Record<string, unknown>;
type Operation = Record<string, unknown>;

const METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

/** Routes outside the global /api prefix (fetched by mail software at fixed paths). */
const UNPREFIXED = new Set(['.well-known/autoconfig/mail/config-v1.1.xml', 'mail/config-v1.1.xml', 'autodiscover/autodiscover.xml', '.well-known/mta-sts.txt']);

function schemaOf(pipes: unknown[] | undefined): JsonSchema | null {
  const pipe = pipes?.find((p): p is ZodValidationPipe<z.ZodType> => p instanceof ZodValidationPipe);
  if (!pipe) return null;
  const schema = (pipe as unknown as { schema: z.ZodType }).schema;
  try {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as JsonSchema;
    delete json.$schema;
    return json;
  } catch {
    return {};
  }
}

const words = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

function joinPath(...parts: string[]): string {
  return `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
}

/** A tag for a route: its area (after /orgs/{orgId}/ for organization routes). */
function tagOf(path: string): string {
  const segments = path.replace(/^\/api\//, '').split('/').filter((s) => s && !s.startsWith('{'));
  if (segments[0] === 'orgs') return `Organization: ${segments[1] ?? 'organizations'}`;
  if (segments[0] === 'system') return `Instance: ${segments[1] ?? 'system'}`;
  return segments[0] ?? 'api';
}

const errorResponses = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '404': { $ref: '#/components/responses/NotFound' },
};

/**
 * The OpenAPI 3.1 description of the API, built from the running
 * application: every controller route (internal ones excepted), with request
 * schemas taken from the Zod schemas that validate them, plus the routes that
 * are not Nest controllers (JMAP, the token endpoint's form, sign-in).
 */
export function buildOpenApi(app: INestApplication, version: string): Record<string, unknown> {
  const discovery = app.get(DiscoveryService);
  const paths: Record<string, Record<string, Operation>> = {};
  const usedIds = new Set<string>();

  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as (new (...args: unknown[]) => unknown) | null;
    if (!controller) continue;
    const basePaths = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    if (basePaths.some((p) => p.startsWith('internal'))) continue;
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
    const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
    const classRole: string | undefined = Reflect.getMetadata(MIN_ORG_ROLE, controller);
    const proto = controller.prototype as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || typeof proto[name] !== 'function') continue;
      const handler = proto[name] as object;
      const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const routePaths: string | string[] | undefined = Reflect.getMetadata(PATH_METADATA, handler);
      if (!method || routePaths === undefined) continue;
      const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [])];
      const isPublic = classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true;
      const role: string | undefined = Reflect.getMetadata(MIN_ORG_ROLE, handler) ?? classRole;
      const doc: ApiDocOptions | undefined = Reflect.getMetadata(API_DOC, handler);
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<string, { index: number; data?: unknown; pipes?: unknown[] }>;

      for (const base of basePaths) {
        for (const sub of ([] as string[]).concat(routePaths)) {
          const raw = joinPath(base, sub);
          const prefixed = UNPREFIXED.has(raw.slice(1)) ? raw : joinPath('api', raw);
          const path = prefixed.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
          const parameters: Record<string, unknown>[] = [];
          let requestBody: Record<string, unknown> | undefined;
          for (const [key, arg] of Object.entries(args)) {
            const type = Number(key.split(':')[0]);
            const schema = schemaOf(arg.pipes);
            if (type === RouteParamtypes.PARAM && typeof arg.data === 'string') {
              parameters.push({ name: arg.data, in: 'path', required: true, schema: schema ?? { type: 'string' } });
            } else if (type === RouteParamtypes.QUERY && schema) {
              if (typeof arg.data === 'string') {
                parameters.push({ name: arg.data, in: 'query', required: false, schema });
              } else {
                const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
                const required = new Set((schema.required as string[] | undefined) ?? []);
                for (const [prop, propSchema] of Object.entries(properties)) {
                  parameters.push({ name: prop, in: 'query', required: required.has(prop) && propSchema.default === undefined, schema: propSchema });
                }
              }
            } else if (type === RouteParamtypes.BODY && schema) {
              requestBody = { required: true, content: { 'application/json': { schema } } };
            }
          }
          // Path parameters every route has, even when no pipe reads them.
          for (const match of path.matchAll(/\{([^}]+)\}/g)) {
            if (!parameters.some((p) => p.in === 'path' && p.name === match[1])) {
              parameters.push({ name: match[1], in: 'path', required: true, schema: { type: 'string' } });
            }
          }

          const who: string[] = [];
          if (guards.includes(SuperAdminGuard)) who.push('Instance administrators.');
          else if (guards.includes(OrgAccessGuard)) who.push(`Organization ${role ?? 'member'}s (and up), instance administrators, or an API key limited to the organization.`);
          if (doc?.appToken) who.push(doc.appToken);
          let operationId = `${controller.name.replace(/Controller$/, '')}_${name}`;
          for (let n = 2; usedIds.has(operationId); n++) operationId = `${controller.name.replace(/Controller$/, '')}_${name}${n}`;
          usedIds.add(operationId);
          const operation: Operation = {
            operationId,
            tags: [tagOf(path)],
            summary: doc?.summary ?? `${words(name)} (${tagOf(path).toLowerCase()})`,
            ...(doc?.description || who.length ? { description: [doc?.description, ...who].filter(Boolean).join('\n\n') } : {}),
            ...(parameters.length ? { parameters } : {}),
            ...(requestBody ? { requestBody } : {}),
            responses: { '2XX': { description: 'Success' }, ...errorResponses },
            ...(isPublic ? { security: [] } : doc?.appToken ? { security: [{ session: [] }, { apiKey: [] }, { appToken: [] }] } : {}),
          };
          (paths[path] ??= {})[method] = operation;
        }
      }
    }
  }

  Object.assign(paths, handWritten());
  const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Postarix API',
      version,
      license: { name: 'AGPL-3.0-only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
      description: [
        'The API of a Postarix server: the same one the admin panel and the webmail use.',
        '',
        '- **People** use a session cookie (sign in with `POST /api/auth/sign-in/email`); state-changing requests must send the `Origin` of the panel or webmail.',
        '- **Scripts** use an **API key** (`Authorization: Bearer px_…`, Administration → API keys): instance-administrator access, or one organization\'s `/api/orgs/{orgId}/…` only.',
        '- **Connected applications** use short **tokens** (`Authorization: Bearer pxt_…`) from `POST /api/oauth/token`, on the JMAP and `/api/mail` routes only. See the integration guide.',
        '',
        'Errors are JSON: `{ "statusCode": 404, "message": "…" }`, with `issues` for validation errors.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'This server' }],
    externalDocs: { description: 'Integration guide', url: 'https://postarix.github.io/postarix/integrations' },
    security: [{ session: [] }, { apiKey: [] }],
    paths: sorted,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token', description: 'A signed-in person (panel or webmail).' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'An API key, `px_…`.' },
        appToken: { type: 'http', scheme: 'bearer', description: 'A connected application\'s token, `pxt_…`, from `POST /api/oauth/token`.' },
      },
      responses: {
        BadRequest: { description: 'The request is not valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        Unauthorized: { description: 'Not signed in, or the key or token is not valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        Forbidden: { description: 'Not allowed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        NotFound: { description: 'Not found (also what other organizations\' data looks like)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            statusCode: { type: 'integer' },
            message: { type: 'string' },
            code: { type: 'string' },
            issues: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
      },
    },
  };
}

/** Routes that are not Nest controllers. */
function handWritten(): Record<string, Record<string, Operation>> {
  const jmapAuth = [{ session: [] }, { appToken: [] }];
  const jmapNote = 'With an application token: mail only; reading methods with `mail.read`, changes and uploads with `mail.write`; never another person\'s account. Accounts are mailbox addresses: the person\'s own and the shared mailboxes they belong to.';
  return {
    '/api/oauth/token': {
      post: {
        operationId: 'OAuth_token',
        tags: ['oauth'],
        summary: 'Get a token for a connected application',
        description:
          'OAuth 2.0 Token Exchange (RFC 8693) for a token acting as one person, or client credentials for the application\'s own token (unread counts). Client authentication: HTTP Basic with the client id and secret, `client_id` and `client_secret` in the body, or `private_key_jwt` (RFC 7523). Errors follow RFC 6749 §5.2.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['grant_type'],
                properties: {
                  grant_type: { enum: ['urn:ietf:params:oauth:grant-type:token-exchange', 'client_credentials'] },
                  subject_token: { type: 'string', description: 'The person: their id in the application (an external identity of its issuer).' },
                  subject_token_type: { enum: ['urn:postarix:params:oauth:token-type:external-subject', 'urn:postarix:params:oauth:token-type:user-id'] },
                  actor_token: { type: 'string', description: 'Supervision: the supervisor.' },
                  actor_token_type: { enum: ['urn:postarix:params:oauth:token-type:external-subject', 'urn:postarix:params:oauth:token-type:user-id'] },
                  scope: { type: 'string', example: 'mail.read mail.write mail.send' },
                  reason: { type: 'string', description: 'Supervision: why (5 to 500 characters).' },
                  client_id: { type: 'string' },
                  client_secret: { type: 'string' },
                  client_assertion_type: { const: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' },
                  client_assertion: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'A token',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    access_token: { type: 'string' },
                    issued_token_type: { type: 'string' },
                    token_type: { const: 'Bearer' },
                    expires_in: { type: 'integer' },
                    scope: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'invalid_request, invalid_grant, invalid_scope, unsupported_grant_type or access_denied' },
          '401': { description: 'invalid_client' },
        },
      },
    },
    '/api/jmap/': {
      get: { operationId: 'Jmap_session', tags: ['jmap'], summary: 'JMAP session resource (RFC 8620 §2)', description: jmapNote, security: jmapAuth, responses: { '200': { description: 'The session' }, '401': { description: 'Not signed in' } } },
      post: {
        operationId: 'Jmap_api',
        tags: ['jmap'],
        summary: 'JMAP method calls (RFC 8620 §3, RFC 8621)',
        description: `${jmapNote} Allowed: Mailbox, Email, Thread, SearchSnippet and Blob methods (no EmailSubmission: send with POST /api/mail/send).`,
        security: jmapAuth,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['using', 'methodCalls'], properties: { using: { type: 'array', items: { type: 'string' } }, methodCalls: { type: 'array', items: { type: 'array' } } } } } },
        },
        responses: { '200': { description: 'Method responses' }, '403': { description: 'Method, capability or account not allowed' } },
      },
    },
    '/api/jmap/download/{accountId}/{blobId}/{name}': {
      get: {
        operationId: 'Jmap_download',
        tags: ['jmap'],
        summary: 'Download a blob (attachment, raw message)',
        security: jmapAuth,
        parameters: ['accountId', 'blobId', 'name'].map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } })),
        responses: { '200': { description: 'The blob, served with a sandboxing CSP' }, '404': { description: 'Not found or not reachable' } },
      },
    },
    '/api/jmap/upload/{accountId}/': {
      post: {
        operationId: 'Jmap_upload',
        tags: ['jmap'],
        summary: 'Upload a blob',
        security: jmapAuth,
        parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } } },
        responses: { '201': { description: 'The blob id' } },
      },
    },
    '/api/jmap/eventsource/': {
      get: { operationId: 'Jmap_events', tags: ['jmap'], summary: 'Push of changes (JMAP EventSource)', security: jmapAuth, responses: { '200': { description: 'text/event-stream' } } },
    },
    '/api/auth/sign-in/email': {
      post: {
        operationId: 'Auth_signIn',
        tags: ['auth'],
        summary: 'Sign in with email and password (sets the session cookie)',
        description: 'Better Auth. With two-step verification on, the answer asks for the second step (`/api/auth/two-factor/verify-totp`).',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: { '200': { description: 'Signed in' }, '401': { description: 'Wrong email or password' } },
      },
    },
    '/api/auth/get-session': {
      get: { operationId: 'Auth_session', tags: ['auth'], summary: 'The current session and user', responses: { '200': { description: 'The session, or null' } } },
    },
    '/api/auth/sign-out': {
      post: { operationId: 'Auth_signOut', tags: ['auth'], summary: 'Sign out', responses: { '200': { description: 'Signed out' } } },
    },
  };
}

/** Swagger UI's files, from the swagger-ui-dist package. */
function uiFile(name: string): Buffer {
  const require = createRequire(import.meta.url);
  return readFileSync(join(require.resolve('swagger-ui-dist/package.json'), '..', name));
}

const UI_FILES: Record<string, string> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'text/javascript; charset=utf-8',
};

const INDEX = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Postarix API</title>
<link rel="stylesheet" href="./docs/swagger-ui.css"></head>
<body><div id="api"></div>
<script src="./docs/swagger-ui-bundle.js"></script><script src="./docs/swagger-ui-standalone-preset.js"></script><script src="./docs/init.js"></script>
</body></html>`;

const INIT = `window.ui = SwaggerUIBundle({ url: './openapi.json', dom_id: '#api', deepLinking: true, presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: 'BaseLayout', tryItOutEnabled: false, persistAuthorization: false });`;

/** /api/openapi.json and a browsable reference at /api/docs. */
@Controller()
@Public()
export class OpenApiController {
  private spec: string | null = null;

  /** Set at start (it needs the whole application). */
  static app: INestApplication | null = null;
  static version = 'dev';

  @Get('openapi.json')
  @Header('content-type', 'application/json; charset=utf-8')
  @Header('cache-control', 'no-cache')
  @ApiDoc({ summary: 'This API\'s OpenAPI description' })
  openapi(): string {
    if (!OpenApiController.app) throw new NotFoundException();
    this.spec ??= JSON.stringify(buildOpenApi(OpenApiController.app, OpenApiController.version));
    return this.spec;
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  @ApiDoc({ summary: 'Browsable API reference' })
  index(): string {
    return INDEX;
  }

  @Get('docs/init.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  @ApiDoc({ summary: 'API reference script' })
  init(): string {
    return INIT;
  }

  @Get('docs/:file')
  @ApiDoc({ summary: 'API reference files' })
  file(@Param('file') file: string, @Res() res: Response): void {
    const type = UI_FILES[file];
    if (!type) throw new NotFoundException();
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'public, max-age=86400');
    res.end(uiFile(file));
  }
}

@Module({ imports: [DiscoveryModule], controllers: [OpenApiController] })
export class OpenApiModule {}

