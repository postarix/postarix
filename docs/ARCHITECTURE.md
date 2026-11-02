# Arquitectura de Postarix

> Documento vivo. Recoge las decisiones de diseño tomadas al iniciar el proyecto y el porqué de cada una.
> Cuando una decisión cambie, se actualiza aquí y se deja constancia en la sección [Registro de decisiones](#registro-de-decisiones).

## 1. Qué es Postarix

Postarix es una plataforma de correo electrónico autoalojada, open source y moderna. Está pensada como alternativa a mailcow, con tres diferencias principales:

1. **Interfaz propia**: panel de administración, webmail, calendario y contactos hechos desde cero con tecnologías actuales (React, Next.js, TypeScript). Sin SOGo ni Roundcube.
2. **Multi-organización desde el primer día**: el mismo sistema sirve para una sola persona, para una pyme o para un proveedor que aloja a muchas empresas.
3. **Escalado sin cambiar de arquitectura**: de un único servidor a un clúster, usando las mismas piezas.

### Principios

- **No reinventar lo peligroso.** SMTP, IMAP, el análisis MIME y el antispam los hacen proyectos maduros y auditados. Postarix los orquesta y les pone encima una capa moderna.
- **Seguro por defecto.** Ninguna opción insegura activada de fábrica.
- **Sin dependencias de pago.** Todo componente de terceros debe ser open source sin funciones recortadas detrás de una edición comercial.
- **Componentes intercambiables.** El backend habla con el servidor de correo a través de un adaptador (`MailEngine`), nunca directamente.
- **Agnóstico del proxy.** Funciona detrás de Traefik, Caddy, nginx o HAProxy, o con un proxy incluido.

## 2. Vista general

```
                         Internet
            ┌───────────────┴────────────────┐
     Puertos de correo                  Puertos web (443)
  25 · 465 · 587 · 993 · 995 · 4190            │
            │                          Reverse proxy (Traefik / Caddy / nginx / HAProxy)
            │                                  │
   ┌────────┴────────┐         ┌───────────────┼────────────────┬──────────────┐
   │     Postfix     │         │               │                │              │
   │  (SMTP in/out)  │      admin          webmail           api          Cyrus HTTP
   └────────┬────────┘    (Next.js)     (React + Vite)    (NestJS)     (JMAP · CalDAV ·
            │ milter                                         │           CardDAV)
   ┌────────┴────────┐                                       │
   │     Rspamd      │◄──── ClamAV · olefy                   │
   └────────┬────────┘                                       │
            │ LMTP                                           │
   ┌────────┴────────┐                         ┌─────────────┼─────────────┐
   │   Cyrus IMAP    │◄──── saslauthd ────────►│ PostgreSQL  │   Valkey    │
   │ (IMAP·JMAP·DAV) │      (auth bridge)      └─────────────┴─────────────┘
   └─────────────────┘
        Unbound (resolvedor DNS con DNSSEC) · CrowdSec (bloqueo de IPs)
```

## 3. Componentes

### 3.1 Núcleo de correo (terceros, sin modificar)

| Componente | Función | Por qué este |
|---|---|---|
| **Postfix** | Recepción y envío SMTP (MTA) | El MTA más probado y seguro. Lee dominios, buzones y alias directamente de PostgreSQL. |
| **Cyrus IMAP** | Almacenamiento de buzones, IMAP, POP3, **JMAP**, **CalDAV**, **CardDAV**, Sieve | 100% open source, sin edición de pago. Trae JMAP y DAV integrados, y replicación (`sync_client`/`sync_server`) y clúster (Murder) en la versión libre. |
| **Rspamd** | Antispam, DKIM, ARC, DMARC, SPF, greylisting | Rápido, con API HTTP, sustituye a varias herramientas antiguas. |
| **ClamAV** | Antivirus | Estándar de facto. **Opcional**, porque consume mucha RAM. |
| **olefy** | Detección de macros maliciosas en documentos Office | Se integra con Rspamd. |
| **Unbound** | Resolvedor DNS propio con DNSSEC | Obligatorio: las listas negras (Spamhaus, etc.) bloquean consultas desde DNS públicos, y DANE necesita validación DNSSEC. |
| **CrowdSec** | Detección de fuerza bruta y bloqueo de IPs | Sustituto moderno de fail2ban, con listas compartidas por la comunidad. |

**Alternativas evaluadas y descartadas:**

- *Dovecot*: en la versión 2.4 la edición comunitaria eliminó Director y la replicación, que pasaron a la edición de pago. Además no ofrece CalDAV/CardDAV ni JMAP estable.
- *Stalwart*: muy moderno y completo, pero la multi-tenencia y otras funciones están en la edición Enterprise (de pago). Se mantiene como posible motor alternativo vía `MailEngine`.
- *SOGo / Roundcube*: los sustituimos por interfaces propias.

### 3.2 Plataforma Postarix (código propio)

| App / paquete | Tecnología | Responsabilidad |
|---|---|---|
| `apps/api` | NestJS + TypeScript | Lógica de negocio: organizaciones, dominios, buzones, alias, cuotas, roles, auditoría, DNS asistido, tareas en segundo plano. Única pieza que modifica la configuración del correo. |
| `apps/admin` | Next.js + React | Panel de administración (superadmin, admin de organización y portal de usuario). |
| `apps/webmail` | React + Vite (SPA) | Webmail, calendario y contactos. Habla JMAP con Cyrus a través de la API. |
| `packages/mail-engine` | TypeScript | Interfaz `MailEngine` y adaptador para Cyrus. |
| `packages/jmap-client` | TypeScript | Cliente JMAP tipado y reutilizable. |
| `packages/ui` | React | Componentes de interfaz compartidos entre admin y webmail. |
| `packages/config` | — | Configuración compartida de TypeScript, ESLint y Prettier. |

**Por qué SPA para el webmail y Next.js para el admin:** el webmail es una aplicación muy interactiva, siempre detrás de login y con estado en tiempo real; el renderizado en servidor aporta poco. El admin tiene más páginas, formularios y lógica de servidor, donde Next.js sí ayuda.

### 3.3 Datos

- **PostgreSQL**: fuente de verdad de Postarix (organizaciones, usuarios, dominios, alias, roles, auditoría). Postfix lee de aquí sus mapas virtuales mediante vistas de solo lectura.
- **Valkey** (fork libre de Redis): caché, sesiones, colas de BullMQ, límites de peticiones.
- **Cyrus**: guarda los mensajes, calendarios y contactos en su propio almacenamiento. Postarix no duplica esos datos.

## 4. Identidad y autenticación

### 4.1 Web (admin y webmail)

**Better Auth** integrado en `apps/api`, con estos plugins:

- `organization`: organizaciones, miembros, roles e invitaciones. Es la base de la multi-tenencia.
- `twoFactor`: TOTP y códigos de recuperación.
- `passkey`: WebAuthn / llaves de seguridad.
- `sso`: inicio de sesión con el proveedor de identidad de la empresa (OIDC/SAML: Azure AD, Google Workspace, Okta, Keycloak…).
- `admin`: bloqueo de usuarios y suplantación auditada para soporte.

### 4.2 Clientes de correo (IMAP, SMTP, CalDAV, CardDAV)

Thunderbird, Outlook o el correo del móvil no entienden sesiones web. Por eso:

1. El usuario genera **contraseñas de aplicación** desde su portal. Cada una tiene nombre, alcance (IMAP, SMTP, DAV) y fecha de último uso, y se puede revocar por separado.
2. Se guardan como hash **argon2id** en PostgreSQL.
3. Cyrus y Postfix validan el login vía **saslauthd**, que consulta un endpoint interno de `apps/api` (solo accesible desde la red interna, autenticado con secreto compartido).
4. La contraseña principal y el 2FA nunca se usan fuera de la web.

En una fase posterior se evaluará **OAUTHBEARER / XOAUTH2** para que los clientes que lo soporten no necesiten contraseñas.

## 5. Multi-tenencia

Jerarquía:

```
Instancia
 └── Organización           (una empresa, o "personal" para un usuario solo)
      ├── Dominios          (ejemplo.com, ejemplo.co…)
      │    ├── Buzones
      │    ├── Alias y redirecciones
      │    └── Configuración DKIM / políticas
      ├── Miembros y roles
      └── Planes y cuotas
```

Roles iniciales:

| Rol | Alcance |
|---|---|
| `superadmin` | Toda la instancia: crear organizaciones, ver salud del sistema. |
| `org_owner` | Su organización completa, incluida facturación y borrado. |
| `org_admin` | Dominios, buzones y alias de su organización. |
| `domain_admin` | Solo los dominios asignados. |
| `user` | Su propio buzón, contraseñas de aplicación, filtros, reenvíos. |

**Regla de oro:** toda consulta a la base de datos se filtra por organización en la capa de repositorio, nunca en el controlador. Se valida con pruebas automáticas que intentan acceder a datos de otra organización.

## 6. El adaptador `MailEngine`

`apps/api` nunca llama a Cyrus o Postfix directamente. Usa esta interfaz (simplificada):

```ts
interface MailEngine {
  createMailbox(input: CreateMailboxInput): Promise<void>;
  deleteMailbox(address: string): Promise<void>;
  setQuota(address: string, bytes: number): Promise<void>;
  getUsage(address: string): Promise<MailboxUsage>;
  renameMailbox(from: string, to: string): Promise<void>;
  health(): Promise<EngineHealth>;
}
```

- La implementación inicial es `CyrusEngine`.
- Los mapas de Postfix (dominios, buzones, alias) no pasan por el adaptador: Postfix los lee de vistas de PostgreSQL.
- Si en el futuro se quiere soportar Dovecot o Stalwart, basta con otra implementación.

## 7. Seguridad

### 7.1 Webmail

- El HTML de los correos se **sanitiza en el servidor** (DOMPurify sobre jsdom) y se muestra dentro de un `<iframe sandbox>` con CSP estricta.
- Las **imágenes remotas** se bloquean por defecto y, al permitirlas, pasan por un **proxy de imágenes** propio para no filtrar la IP del usuario ni servir de rastreo.
- Los adjuntos se descargan con `Content-Disposition: attachment` y tipo MIME forzado.

### 7.2 Aplicaciones web

- Autorización validada **en cada endpoint y cada server action**, nunca solo en el middleware de Next.js.
- Cookies `HttpOnly`, `Secure`, `SameSite=Lax`; protección CSRF.
- Cabeceras de seguridad: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Límites de peticiones por IP y por cuenta (Valkey).
- La API solo acepta `X-Forwarded-For` de los **proxies de confianza** declarados en la configuración.

### 7.3 Correo

- Entrada: SPF, DKIM, DMARC, ARC verificados por Rspamd; greylisting; listas negras vía Unbound.
- Salida: firma DKIM por dominio (rotación de claves asistida), límites de envío por buzón, detección de cuentas comprometidas que envían spam.
- Transporte: TLS obligatorio en puertos de usuario; **MTA-STS**, **TLS-RPT** y **DANE** (si el dominio usa DNSSEC).

### 7.4 Infraestructura

- **Sin acceso al socket de Docker** desde ningún contenedor. Cada servicio se controla por su propia API.
- Contenedores sin root cuando el componente lo permite, sistema de archivos de solo lectura, capacidades mínimas.
- Secretos fuera de las imágenes (variables de entorno o Docker/K8s secrets).
- Backups cifrados.
- Registro de auditoría de todas las acciones administrativas.

### 7.5 Proceso

- Dependencias vigiladas con Renovate; imágenes escaneadas con Trivy en CI.
- Pruebas automáticas, incluidas las de aislamiento entre organizaciones.
- Auditoría de seguridad externa antes de la versión 1.0.
- Política de divulgación responsable en `SECURITY.md`.

## 8. Red, proxy y certificados

### 8.1 Qué pasa por el proxy y qué no

- **Por el reverse proxy (HTTP/HTTPS):** admin, webmail, API, JMAP, CalDAV/CardDAV, autodiscover/autoconfig y la política MTA-STS.
- **Directo a los servicios (sin proxy):** 25, 465, 587 (Postfix), 993, 995 (Cyrus), 4190 (ManageSieve). Así Rspamd y CrowdSec ven las IPs reales, y STARTTLS funciona sin trucos.

### 8.2 Proxies soportados

Postarix incluye plantillas probadas y documentadas para:

- **Traefik** (labels de Docker Compose)
- **Caddy** (`Caddyfile`)
- **nginx**
- **HAProxy**

Y un modo **"proxy incluido"** con Caddy para instalaciones en servidores limpios.

### 8.3 Certificados

Postfix y Cyrus también necesitan certificados TLS. Tres modos configurables:

1. **ACME propio (por defecto):** el servicio `certs` obtiene y renueva certificados de Let's Encrypt y los comparte con Postfix, Cyrus y el proxy.
2. **Externos:** se leen de una ruta de archivos. Para Traefik se documenta `traefik-certs-dumper`.
3. **cert-manager:** en Kubernetes, desde Secrets.

En los tres casos, un vigilante detecta el cambio de certificado y recarga Postfix y Cyrus sin cortar el servicio.

## 9. Tareas en segundo plano

**BullMQ** sobre Valkey, dentro de `apps/api`. Sustituye al contenedor `ofelia` de mailcow.

Ejemplos: renovación de claves DKIM, comprobación de DNS de cada dominio, limpieza de cuarentena, informes DMARC/TLS-RPT, avisos de cuota, backups programados.

## 10. Observabilidad

- Health checks en todos los contenedores.
- Métricas Prometheus (Postfix exporter, Rspamd, Cyrus, API).
- Paneles Grafana opcionales.
- Logs estructurados en JSON.

## 11. Despliegue y escalado

| Escenario | Topología |
|---|---|
| **Personal / pyme** | Un servidor con Docker Compose. Todo en un nodo, backups automáticos. |
| **Empresa mediana** | Dos servidores Cyrus con replicación (principal + réplica). PostgreSQL con réplica. |
| **Empresa grande / proveedor** | Varios pares Cyrus detrás de Cyrus Murder (proxy que enruta a cada usuario a su servidor). Postfix, Rspamd, API y frontends escalan horizontalmente porque no guardan estado. Despliegue con Helm en Kubernetes. |

## 12. Contenedores (instalación con Docker Compose)

| Servicio | Imagen | Obligatorio |
|---|---|---|
| `postfix` | propia (basada en Debian slim) | Sí |
| `cyrus` | propia | Sí |
| `rspamd` | oficial | Sí |
| `unbound` | propia o comunitaria | Sí |
| `postgres` | oficial | Sí |
| `valkey` | oficial | Sí |
| `api` | propia | Sí |
| `admin` | propia | Sí |
| `webmail` | propia | Sí |
| `certs` | propia | Según modo de certificados |
| `caddy` | oficial | Solo en modo "proxy incluido" |
| `crowdsec` | oficial | Recomendado |
| `clamd` | oficial | Opcional |
| `olefy` | comunitaria | Recomendado |
| `prometheus`, `grafana` | oficiales | Opcional |

## 13. Estructura del repositorio

```
postarix/
├── apps/
│   ├── api/            NestJS — lógica de negocio y Better Auth
│   ├── admin/          Next.js — panel de administración
│   └── webmail/        React + Vite — webmail, calendario, contactos
├── packages/
│   ├── mail-engine/    Interfaz MailEngine + adaptador Cyrus
│   ├── jmap-client/    Cliente JMAP tipado
│   ├── ui/             Componentes compartidos
│   └── config/         TS, ESLint, Prettier compartidos
├── docker/
│   ├── compose/        docker-compose para dev y producción
│   ├── postfix/        Dockerfile y plantillas de configuración
│   ├── cyrus/
│   └── unbound/
├── deploy/
│   ├── proxies/        Plantillas Traefik, Caddy, nginx, HAProxy
│   └── helm/           Chart de Kubernetes
└── docs/               Documentación
```

## 14. Fases de desarrollo

### Fase 0 — Cimientos
- [x] Monorepo (pnpm + Turborepo), CI, linters, convenciones.
- [x] Docker Compose de desarrollo: PostgreSQL, Valkey.
- [x] `apps/api` con Better Auth, organizaciones y roles.
- [x] Esquema de base de datos inicial y migraciones.
- [x] Primer recurso multi-organización (dominios) con pruebas de aislamiento.
- [ ] Límite de peticiones y sesiones en Valkey (hoy en memoria).

### Fase 1 — Correo funcionando
- Contenedores de Postfix, Cyrus, Rspamd y Unbound.
- Postfix leyendo dominios, buzones y alias de PostgreSQL.
- `CyrusEngine` (crear buzones, cuotas).
- Puente de autenticación saslauthd + contraseñas de aplicación.
- DKIM por dominio y asistente de DNS.
- Certificados (los tres modos).
- **Hito:** enviar y recibir correo desde Thunderbird.

### Fase 2 — Panel de administración
- Organizaciones, dominios, buzones, alias, roles.
- Estado de DNS por dominio (MX, SPF, DKIM, DMARC, MTA-STS).
- Cuarentena y logs de Rspamd.
- Auditoría.

### Fase 3 — Webmail
- Cliente JMAP, bandeja de entrada, hilos, lectura segura de HTML, redacción, adjuntos.
- Búsqueda, carpetas, etiquetas, filtros Sieve, respuestas automáticas.
- Actualizaciones en tiempo real (JMAP push).

### Fase 4 — Calendario y contactos
- Interfaces sobre CalDAV/CardDAV (o JMAP Calendars/Contacts según madurez en Cyrus).
- Invitaciones (iMIP), recursos compartidos.

### Fase 5 — Enterprise y escala
- SSO (OIDC/SAML), passkeys obligatorias por política.
- Replicación y Cyrus Murder; chart de Helm.
- Migración desde Google Workspace y Microsoft 365.
- Retención legal y archivado.
- Auditoría de seguridad externa → **versión 1.0**.

## Registro de decisiones

| Fecha | Decisión |
|---|---|
| 2026-11-01 | Nombre del proyecto: **Postarix**. |
| 2026-11-01 | Motor de buzones: **Cyrus IMAP** (frente a Dovecot CE 2.4 y Stalwart). |
| 2026-11-01 | MTA: **Postfix**. Antispam: **Rspamd**. |
| 2026-11-01 | Backend: **NestJS**. Identidad: **Better Auth**. |
| 2026-11-01 | Admin con **Next.js**; webmail como **SPA React + Vite** sobre **JMAP**. |
| 2026-11-01 | Monorepo con **pnpm workspaces + Turborepo**. |
| 2026-11-01 | Proxy agnóstico; puertos de correo fuera del reverse proxy. |
| 2026-11-01 | Licencia **AGPL-3.0**. |
| 2026-11-01 | ORM: **Drizzle** (SQL explícito, tipado fuerte, migraciones versionadas; adaptador oficial de Better Auth). |
| 2026-11-01 | Runtime **Node.js 22+**, **ESM** en todo el monorepo, **TypeScript 6** (typescript-eslint aún no soporta TS 7). |
| 2026-11-01 | Contraseñas de usuario con **argon2id** (parámetros OWASP), igual que las contraseñas de aplicación. |
| 2026-11-01 | **Registro público desactivado** y creación de organizaciones solo para super-admins, por defecto. La primera cuenta se crea con `create-admin`. |
| 2026-11-01 | Acceso a una organización ajena devuelve **404** (no 403) para no revelar su existencia. |
| 2026-11-01 | Pruebas end-to-end contra **PostgreSQL real** (servicio en CI), no contra mocks. |
