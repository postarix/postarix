# Postarix — guía para asistentes de IA

Plataforma de correo autoalojada (alternativa moderna a mailcow). Lee `docs/ARCHITECTURE.md` antes de proponer cambios de diseño: ahí están las decisiones y el porqué.

## Decisiones fijas

- Núcleo: Postfix + Cyrus IMAP + Rspamd + Unbound + CrowdSec (ClamAV opcional). No se modifica su código; se configuran.
- Backend: NestJS + Better Auth (plugins organization, twoFactor, passkey, sso, admin).
- Admin: Next.js. Webmail: SPA React + Vite sobre JMAP.
- Datos: PostgreSQL + Valkey. Colas: BullMQ.
- Monorepo: pnpm workspaces + Turborepo. Licencia AGPL-3.0-only.

## Reglas

- La API nunca habla con Cyrus directamente: usa la interfaz `MailEngine` de `packages/mail-engine`.
- Toda consulta se filtra por organización en la capa de repositorio. Cada endpoint nuevo lleva una prueba de aislamiento entre organizaciones.
- La autorización se valida en cada endpoint y server action, nunca solo en middleware.
- El HTML de los correos se sanitiza en servidor y se muestra en iframe sandbox con CSP.
- Ningún contenedor accede al socket de Docker.
- Los puertos de correo no pasan por el reverse proxy.

## Idioma

Documentación de usuario en español. Código, identificadores y comentarios técnicos en inglés. Commits con Conventional Commits.
