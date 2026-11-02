# @postarix/api

The Postarix backend: NestJS 12 (ESM) + Better Auth + Drizzle ORM on PostgreSQL.

It is the only component that changes mail configuration. The overall architecture is in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## Features

- **Authentication** with Better Auth under `/api/auth/*`: email and password (argon2id), sessions, 2FA (TOTP), passkeys, organizations and user administration.
- **Public sign-up disabled by default.** The first account is created with the `create-admin` script.
- **Organizations and roles** (`owner`, `admin`, `member`) plus the instance-wide `admin` role (super-admin).
- **Domains** per organization under `/api/orgs/:orgId/domains`, with tested isolation.
- **Health check** at `/api/health`.

## Getting started

```bash
cp ../../.env.example ../../.env   # and fill in AUTH_SECRET
pnpm dev:services                   # from the root: PostgreSQL and Valkey
pnpm --filter @postarix/api db:migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' \
  pnpm --filter @postarix/api create-admin
pnpm --filter @postarix/api dev
```

## Scripts

| Script | What it does |
|---|---|
| `dev` | Runs the API with auto-reload. |
| `build` / `start` | Compiles to `dist/` and runs it. |
| `test` | Unit and end-to-end tests (need PostgreSQL). |
| `db:generate` | Generates a migration from changes in `src/db/schema`. |
| `db:migrate` | Applies pending migrations. |
| `auth:schema` | Regenerates `src/db/schema/auth.ts` with the Better Auth CLI (after changing plugins). |
| `create-admin` | Creates a super-admin (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`). |

## Tests

End-to-end tests use a real PostgreSQL. By default they connect to
`postgresql://postarix:postarix@127.0.0.1:5432/postarix_test`; override it with `TEST_DATABASE_URL`.
The database name **must end in `_test`**: the suite wipes it on start.

## Layout

```
src/
  auth/        Better Auth configuration, session guard, decorators
  tenancy/     Organization context and organization access guard
  domains/     Multi-tenant resource (controller → service → repository)
  db/          Drizzle client, schema and migrations
  common/      Zod validation, PostgreSQL errors, origin check, body limits
  config/      Environment variables validated with Zod
drizzle/       Generated SQL migrations (committed)
test/          End-to-end tests
```

## Conventions

- **Explicit injection:** always use `@Inject(Token)` in constructors. Don't rely on type metadata alone.
- **Tenant-scoped repositories:** every method takes `TenantContext` first and filters by `organizationId`. There are no unscoped accessors.
- **Organization routes** live under `orgs/:orgId/...` with `@UseGuards(OrgAccessGuard)`. Non-members get **404**, not 403, so organization IDs can't be probed.
- **Every new endpoint** ships with cross-organization isolation tests.
