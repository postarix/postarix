# Postarix

**Plataforma de correo electrónico autoalojada, moderna y open source.**

Postarix reúne en un solo sistema todo lo necesario para operar correo propio: envío y recepción, antispam, antivirus, webmail, calendario, contactos y un panel de administración. Funciona igual para una sola persona que para una empresa grande o un proveedor que aloja a muchas organizaciones.

> ⚠️ **Estado: en desarrollo temprano.** Todavía no es apto para producción.

## Por qué Postarix

- **Interfaz propia y moderna.** Webmail, calendario, contactos y panel hechos con React, Next.js y TypeScript. Sin SOGo ni Roundcube.
- **Multi-organización desde el inicio.** Organizaciones, dominios, roles y cuotas como parte del núcleo, no como añadido.
- **Escala sin cambiar de arquitectura.** De un VPS a un clúster con las mismas piezas.
- **100% open source.** Sin componentes con funciones recortadas detrás de ediciones de pago.
- **Seguro por defecto.** 2FA, passkeys, contraseñas de aplicación, MTA-STS, DANE, aislamiento entre organizaciones.
- **Funciona con tu proxy.** Traefik, Caddy, nginx o HAProxy, o con un proxy incluido.

## Stack

| Capa | Tecnología |
|---|---|
| SMTP | Postfix |
| Buzones, IMAP, JMAP, CalDAV, CardDAV | Cyrus IMAP |
| Antispam, DKIM, DMARC | Rspamd |
| Antivirus | ClamAV (opcional) |
| DNS | Unbound |
| Protección contra fuerza bruta | CrowdSec |
| Backend | NestJS + Better Auth |
| Panel de administración | Next.js |
| Webmail | React + Vite |
| Datos | PostgreSQL + Valkey |

La arquitectura completa, con el porqué de cada decisión, está en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Estructura

```
apps/
  api/          Backend (NestJS)
  admin/        Panel de administración (Next.js)
  webmail/      Webmail, calendario y contactos (React + Vite)
packages/
  mail-engine/  Adaptador hacia el servidor de correo
  jmap-client/  Cliente JMAP
  ui/           Componentes compartidos
  config/       Configuración compartida (TypeScript, lint)
docker/         Imágenes y docker-compose
deploy/         Plantillas de proxies y Helm
docs/           Documentación
```

## Desarrollo

Requisitos: Node.js 22 o superior (recomendado 24 LTS), pnpm (vía Corepack) y Docker.

```bash
corepack enable
pnpm install
cp .env.example .env                       # completa AUTH_SECRET
pnpm dev:services                          # levanta PostgreSQL y Valkey
pnpm --filter @postarix/api db:migrate     # crea las tablas
ADMIN_EMAIL=tu@dominio.com ADMIN_PASSWORD='una frase larga' \
  pnpm --filter @postarix/api create-admin # primera cuenta (super-admin)
pnpm dev                                   # levanta las apps
```

Comprobaciones: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Hoja de ruta

1. **Fase 0** — Cimientos: monorepo, CI, API con autenticación y organizaciones.
2. **Fase 1** — Correo funcionando: Postfix, Cyrus, Rspamd, DKIM, certificados.
3. **Fase 2** — Panel de administración.
4. **Fase 3** — Webmail.
5. **Fase 4** — Calendario y contactos.
6. **Fase 5** — Funciones enterprise, alta disponibilidad y versión 1.0.

Detalle en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#14-fases-de-desarrollo).

## Seguridad

Si encuentras una vulnerabilidad, **no abras un issue público**. Sigue las instrucciones de [`SECURITY.md`](SECURITY.md).

## Licencia

[GNU Affero General Public License v3.0](LICENSE).
