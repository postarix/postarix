# Postarix — guide for AI assistants

Self-hosted email platform (a modern alternative to mailcow). Read `docs/ARCHITECTURE.md` before proposing design changes: it holds the decisions and the reasoning behind them.

## Fixed decisions

- Mail core: Postfix + Cyrus IMAP + Rspamd + Unbound + CrowdSec (ClamAV optional). Their code is never modified, only configured. Our images build on Debian trixie-slim.
- Backend: NestJS + Better Auth (plugins organization, twoFactor, passkey, admin; sso arrives in Phase 5).
- Admin: Next.js. Webmail: React + Vite SPA over JMAP.
- Data: PostgreSQL (Drizzle ORM, versioned migrations in `apps/api/drizzle/`) + Valkey. Queues: BullMQ.
- Runtime: Node.js 22+, ESM across the monorepo. TypeScript 6.
- Monorepo: pnpm workspaces + Turborepo. License AGPL-3.0-only.

## Rules

- The API never talks to Cyrus directly: it uses the `MailEngine` interface from `packages/mail-engine`.
- Every query is scoped by organization in the repository layer. Every new endpoint ships with a cross-organization isolation test.
- Authorization is checked in every endpoint and server action, never only in middleware.
- Email HTML is sanitized on the server and rendered in a sandboxed iframe with a CSP.
- No container gets access to the Docker socket.
- Mail ports do not go through the reverse proxy. `/api/internal/*` is never exposed through it.
- In NestJS, always inject explicitly with `@Inject(Token)` in constructors.
- Organization routes: `orgs/:orgId/...` + `OrgAccessGuard`; non-members get 404. Repositories take `TenantContext` first.
- `apps/api/src/db/schema/auth.ts` is generated (`pnpm --filter @postarix/api auth:schema`); never edit it by hand.
- After changing the schema: `pnpm --filter @postarix/api db:generate` and commit the migration (CI checks this).

## Commands

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` from the root. API tests need PostgreSQL (`TEST_DATABASE_URL`, database name ending in `_test`).

## Language

Everything in the repository is in English: code, identifiers, comments, docs and commit messages (Conventional Commits).
