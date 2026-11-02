# Postarix — guía para asistentes de IA

Plataforma de correo autoalojada (alternativa moderna a mailcow). Lee `docs/ARCHITECTURE.md` antes de proponer cambios de diseño: ahí están las decisiones y el porqué.

## Decisiones fijas

- Núcleo: Postfix + Cyrus IMAP + Rspamd + Unbound + CrowdSec (ClamAV opcional). No se modifica su código; se configuran.
- Backend: NestJS + Better Auth (plugins organization, twoFactor, passkey, admin; sso llega en la Fase 5).
- Admin: Next.js. Webmail: SPA React + Vite sobre JMAP.
- Datos: PostgreSQL (Drizzle ORM, migraciones versionadas en `apps/api/drizzle/`) + Valkey. Colas: BullMQ.
- Runtime: Node.js 22+, ESM en todo el monorepo. TypeScript 6.
- Monorepo: pnpm workspaces + Turborepo. Licencia AGPL-3.0-only.

## Reglas

- La API nunca habla con Cyrus directamente: usa la interfaz `MailEngine` de `packages/mail-engine`.
- Toda consulta se filtra por organización en la capa de repositorio. Cada endpoint nuevo lleva una prueba de aislamiento entre organizaciones.
- La autorización se valida en cada endpoint y server action, nunca solo en middleware.
- El HTML de los correos se sanitiza en servidor y se muestra en iframe sandbox con CSP.
- Ningún contenedor accede al socket de Docker.
- Los puertos de correo no pasan por el reverse proxy.
- En NestJS, inyección siempre explícita con `@Inject(Token)` en constructores.
- Rutas de organización: `orgs/:orgId/...` + `OrgAccessGuard`; no miembro → 404. Repositorios reciben `TenantContext` primero.
- `apps/api/src/db/schema/auth.ts` es generado (`pnpm --filter @postarix/api auth:schema`); no se edita a mano.
- Tras cambiar el esquema: `pnpm --filter @postarix/api db:generate` y versionar la migración (CI lo verifica).

## Comandos

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` desde la raíz. Las pruebas de la API necesitan PostgreSQL (`TEST_DATABASE_URL`, base terminada en `_test`).

## Idioma

Documentación de usuario en español. Código, identificadores y comentarios técnicos en inglés. Commits con Conventional Commits.
