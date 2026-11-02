# @postarix/api

Backend de Postarix: NestJS 12 (ESM) + Better Auth + Drizzle ORM sobre PostgreSQL.

Es la única pieza que modifica la configuración del correo. La arquitectura general está en [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## Qué incluye hoy (Fase 0)

- **Autenticación** con Better Auth en `/api/auth/*`: email y contraseña (argon2id), sesiones, 2FA (TOTP), passkeys, organizaciones y administración de usuarios.
- **Registro público desactivado por defecto.** La primera cuenta se crea con el script `create-admin`.
- **Organizaciones y roles** (`owner`, `admin`, `member`) más el rol de instancia `admin` (super-admin).
- **Dominios** por organización, en `/api/orgs/:orgId/domains`, con aislamiento verificado por pruebas.
- **Health check** en `/api/health`.

## Puesta en marcha

```bash
cp ../../.env.example ../../.env   # y completa AUTH_SECRET
pnpm dev:services                   # desde la raíz: PostgreSQL y Valkey
pnpm --filter @postarix/api db:migrate
ADMIN_EMAIL=tu@dominio.com ADMIN_PASSWORD='una frase larga' \
  pnpm --filter @postarix/api create-admin
pnpm --filter @postarix/api dev
```

## Scripts

| Script | Qué hace |
|---|---|
| `dev` | Arranca la API con recarga automática. |
| `build` / `start` | Compila a `dist/` y la ejecuta. |
| `test` | Pruebas unitarias y end-to-end (necesitan PostgreSQL). |
| `db:generate` | Genera una migración a partir de los cambios en `src/db/schema`. |
| `db:migrate` | Aplica las migraciones pendientes. |
| `auth:schema` | Regenera `src/db/schema/auth.ts` con la CLI de Better Auth (tras cambiar plugins). |
| `create-admin` | Crea un super-admin (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`). |

## Pruebas

Las pruebas end-to-end usan un PostgreSQL real. Por defecto se conectan a
`postgresql://postarix:postarix@127.0.0.1:5432/postarix_test`; puedes cambiarlo con `TEST_DATABASE_URL`.
El nombre de la base de datos **debe terminar en `_test`**: la suite la vacía al empezar.

## Estructura

```
src/
  auth/        Configuración de Better Auth, guard de sesión, decoradores
  tenancy/     Contexto de organización y guard de acceso por organización
  domains/     Primer recurso multi-organización (controller → service → repository)
  db/          Cliente Drizzle, esquema y migraciones
  common/      Validación con Zod, errores de PostgreSQL, comprobación de origen
  config/      Variables de entorno validadas con Zod
drizzle/       Migraciones SQL generadas (se versionan)
test/          Pruebas end-to-end
```

## Convenciones

- **Inyección explícita:** usa siempre `@Inject(Token)` en los constructores. No dependas solo de los metadatos de tipos.
- **Repositorios con contexto de organización:** cada método recibe `TenantContext` como primer argumento y filtra por `organizationId`. No existen accesores sin filtrar.
- **Rutas de organización** bajo `orgs/:orgId/...` con `@UseGuards(OrgAccessGuard)`. Quien no es miembro recibe **404**, no 403, para no revelar qué organizaciones existen.
- **Cada endpoint nuevo** lleva pruebas de aislamiento entre organizaciones.
