# Postarix Architecture

> Living document. It records the design decisions behind Postarix and the reasoning for each one.
> When a decision changes, update it here and add an entry to the [decision log](#decision-log).

## 1. What Postarix is

Postarix is a modern, self-hosted, open-source email platform. It is meant as an alternative to mailcow, with three main differences:

1. **Its own interface**: admin panel, webmail, calendar and contacts built from scratch with current technology (React, Next.js, TypeScript). No SOGo, no Roundcube.
2. **Multi-tenant from day one**: the same system serves a single person, a small business, or a provider hosting many companies.
3. **Scales without changing architecture**: from one server to a cluster, using the same building blocks.

### Principles

- **Don't reinvent the dangerous parts.** SMTP, IMAP, MIME parsing and spam filtering are done by mature, audited projects. Postarix orchestrates them and adds a modern layer on top.
- **Secure by default.** No insecure option is enabled out of the box.
- **No paid dependencies.** Every third-party component must be open source without features held back for a commercial edition.
- **Swappable components.** The backend talks to the mail server through an adapter (`MailEngine`), never directly.
- **Proxy-agnostic.** Works behind Traefik, Caddy, nginx or HAProxy, or with a bundled proxy.

## 2. Overview

```
                         Internet
            ┌───────────────┴────────────────┐
       Mail ports                       Web ports (443)
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
        Unbound (DNSSEC-validating resolver) · CrowdSec (IP blocking)
```

## 3. Components

### 3.1 Mail core (third-party, unmodified)

| Component | Role | Why this one |
|---|---|---|
| **Postfix** | SMTP reception and delivery (MTA) | The most proven and secure MTA. Reads domains, mailboxes and aliases directly from PostgreSQL. |
| **Cyrus IMAP** | Mailbox storage, IMAP, POP3, **JMAP**, **CalDAV**, **CardDAV**, Sieve | 100% open source, no paid edition. Ships JMAP and DAV, plus replication (`sync_client`/`sync_server`) and clustering (Murder) in the free version. |
| **Rspamd** | Spam filtering, DKIM, ARC, DMARC, SPF, greylisting | Fast, has an HTTP API, replaces several older tools. |
| **ClamAV** | Antivirus | De facto standard. **Optional**, because it uses a lot of RAM. |
| **olefy** | Detects malicious macros in Office documents | Integrates with Rspamd. |
| **Unbound** | Local DNSSEC-validating resolver | Required: blocklists (Spamhaus etc.) refuse queries from public resolvers, and DANE needs DNSSEC validation. |
| **CrowdSec** | Brute-force detection and IP blocking | Modern fail2ban replacement with community-shared blocklists. |

**Alternatives considered and rejected:**

- *Dovecot*: the 2.4 community edition removed Director and replication, which moved to the paid edition. It also lacks CalDAV/CardDAV and stable JMAP.
- *Stalwart*: very modern and complete, but multi-tenancy and other features are in the paid Enterprise edition. Kept as a possible alternative engine via `MailEngine`.
- *SOGo / Roundcube*: replaced by our own interfaces.

### 3.2 Postarix platform (our code)

| App / package | Technology | Responsibility |
|---|---|---|
| `apps/api` | NestJS + TypeScript | Business logic: organizations, domains, mailboxes, aliases, quotas, roles, auditing, DNS assistance, background jobs. The only component that changes mail configuration. |
| `apps/admin` | Next.js + React | Admin panel (super-admin, organization admin and user self-service). |
| `apps/webmail` | React + Vite (SPA) | Webmail, calendar and contacts. Talks JMAP to Cyrus through the API. |
| `packages/mail-engine` | TypeScript | The `MailEngine` interface and its Cyrus adapter. |
| `packages/jmap-client` | TypeScript | Typed, reusable JMAP client. |
| `packages/ui` | React | UI components shared by admin and webmail. |
| `packages/config` | — | Shared TypeScript configuration. |

**Why an SPA for webmail and Next.js for admin:** webmail is a highly interactive app, always behind login, with real-time state; server-side rendering adds little. The admin panel has more pages, forms and server logic, where Next.js helps.

### 3.3 Data

- **PostgreSQL**: source of truth for Postarix (organizations, users, domains, mailboxes, aliases, roles, audit log). Postfix reads its virtual maps from read-only views.
- **Valkey** (open-source Redis fork): cache, sessions, BullMQ queues, rate limits, and the DKIM keys Rspamd signs with.
- **Cyrus**: stores messages, calendars and contacts in its own storage. Postarix does not duplicate that data.

## 4. Identity and authentication

### 4.1 Web (admin and webmail)

**Better Auth** inside `apps/api`, with these plugins:

- `organization`: organizations, members, roles and invitations. The basis of multi-tenancy.
- `twoFactor`: TOTP and recovery codes.
- `passkey`: WebAuthn / security keys.
- `admin`: banning users and audited impersonation for support.
- `sso`: sign-in with the organization's OpenID Connect identity provider (Microsoft Entra ID, Google Workspace, Okta, Keycloak…). Providers are managed through our API (`orgs/:orgId/sso`, organization admins), one per verified domain; Better Auth's own provider endpoints are closed. SSO never creates accounts: on every sign-in the asserted email must be an **active mailbox of the provider's organization**, and never an instance administrator. Issuer URLs must be public https addresses (checked again after DNS resolution); an internal IdP must be added to `TRUSTED_ORIGINS` by the operator. Mail clients keep using app passwords. SAML is not offered yet.

### 4.2 Mail clients (IMAP, SMTP, CalDAV, CardDAV)

Thunderbird, Outlook or a phone's mail app don't understand web sessions. So:

1. Users create **app passwords** in their portal. Each has a name, a scope (IMAP, SMTP, DAV) and a last-used timestamp, and can be revoked individually.
2. They are stored as **argon2id** hashes in PostgreSQL.
3. Cyrus and Postfix validate logins through **saslauthd** with PAM. A `pam_exec` helper posts the credentials to an internal endpoint of `apps/api` (`/api/internal/mail-auth`), authenticated with a shared secret. (`saslauthd`'s `httpform` mechanism would be simpler, but Debian does not compile it in.) saslauthd's credential cache stays off so revoking an app password takes effect immediately.
4. Failed account-password attempts are limited per username in the API (app passwords, which cannot be guessed, keep working), on top of CrowdSec watching the mail logs (Phase 5).
5. The account password is also accepted for mail protocols **only while the user has no second factor**. Once 2FA is enabled, only app passwords work, so a stolen password alone can no longer read mail.

**OAUTHBEARER / XOAUTH2** for clients that support it will be evaluated later.

## 5. Multi-tenancy

Hierarchy:

```
Instance
 └── Organization           (a company, or "personal" for a single user)
      ├── Domains           (example.com, example.co…)
      │    ├── Mailboxes
      │    ├── Aliases and forwards
      │    └── DKIM keys / policies
      ├── Members and roles
      └── Plans and quotas
```

Roles:

| Role | Scope |
|---|---|
| `admin` (instance) | The whole instance: create organizations, see system health. |
| `owner` | Their whole organization, including billing and deletion. |
| `admin` (organization) | Domains, mailboxes and aliases of their organization. |
| `member` | Their own mailbox, app passwords, filters, forwards. |

**Golden rule:** every database query is scoped by organization in the repository layer, never in the controller. Automated tests try to reach other organizations' data.

## 6. The `MailEngine` adapter

`apps/api` never calls Cyrus directly. It uses this interface (simplified):

```ts
interface MailEngine {
  createMailbox(address: string, options: { quotaBytes: number | null }): Promise<void>;
  deleteMailbox(address: string): Promise<void>;
  setQuota(address: string, quotaBytes: number | null): Promise<void>;
  getUsage(address: string): Promise<MailboxUsage>;
  renameMailbox(from: string, to: string): Promise<void>;
  health(): Promise<EngineHealth>;
}
```

- The first implementation is `CyrusEngine`, which speaks IMAP to Cyrus as its admin user.
- Postfix maps (domains, mailboxes, aliases) do not go through the adapter: Postfix reads them from PostgreSQL views.
- Supporting Dovecot or Stalwart later only needs another implementation.

## 7. Security

### 7.1 Webmail

- Email HTML is **sanitized on the server** (DOMPurify on jsdom) and rendered inside an `<iframe sandbox>` with a strict CSP.
- **Remote images** are blocked by default and, when allowed, go through our own **image proxy** so they don't leak the user's IP or act as trackers.
- Attachments are served with `Content-Disposition: attachment` and a forced MIME type.

### 7.2 Web applications

- Authorization is checked **in every endpoint and server action**, never only in Next.js middleware.
- `HttpOnly`, `Secure`, `SameSite=Lax` cookies; CSRF protection through an origin check.
- Security headers: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Request bodies are parsed and capped (1 MB, JSON or forms only) before any route.
- Rate limits per IP and per account (Valkey).
- The API only honours `X-Forwarded-For` from the **trusted proxies** declared in its configuration.

### 7.3 Mail

- Inbound: SPF, DKIM, DMARC and ARC checked by Rspamd; greylisting; blocklists via Unbound.
- Outbound: per-domain DKIM signing, per-mailbox sending limits, detection of compromised accounts sending spam, and senders may only use addresses they own.
- Transport: TLS required on user ports; **MTA-STS**, **TLS-RPT** and **DANE** (when the domain uses DNSSEC).

### 7.4 Infrastructure

- **No container has access to the Docker socket.** Each service is controlled through its own API.
- Non-root containers where the component allows it, minimal capabilities.
- Secrets live outside images (environment variables or Docker/Kubernetes secrets).
- Encrypted backups.
- Audit log of every administrative action.

### 7.5 Process

- Dependencies tracked with Dependabot; images scanned with Trivy in CI.
- Automated tests, including cross-organization isolation tests.
- External security audit before 1.0.
- Responsible disclosure policy in `SECURITY.md`.

## 8. Network, proxy and certificates

### 8.1 What goes through the proxy and what doesn't

- **Through the reverse proxy (HTTP/HTTPS):** admin, webmail, API, CalDAV/CardDAV, autodiscover/autoconfig and the MTA-STS policy. The webmail reaches JMAP through the API; Cyrus' JMAP is not exposed directly, so a DAV-scoped app password cannot read mail.
- **Straight to the services (no proxy):** 25, 465, 587 (Postfix), 143, 993, 995 (Cyrus), 4190 (ManageSieve). This way Rspamd and CrowdSec see real client IPs, and STARTTLS works without tricks.
- `/api/internal/*` is never exposed through the proxy.

### 8.1.1 Internal networks

- The reverse proxy joins only the `proxy` network, shared with the API, Cyrus (CalDAV/CardDAV) and the certs service. PostgreSQL, Valkey (which holds DKIM private keys), Rspamd and Postfix are not on it.
- The certs service, which may hold DNS provider credentials, is on the `proxy` network only.
- LMTP is pre-authenticated, so Cyrus serves it on a Unix socket in a volume shared with Postfix, never on a TCP port.
- The API verifies Cyrus' certificate on the admin connection: against the public hostname, with the shared certificate file pinned so self-signed certificates work too.
- Every container drops `NET_RAW`.

### 8.2 Supported proxies

Postarix ships tested, documented templates for **Traefik** (Docker Compose labels), **Caddy**, **nginx** and **HAProxy**, plus a "bundled proxy" mode with Caddy for clean servers.

### 8.3 Certificates

Postfix and Cyrus need TLS certificates too. Three configurable modes:

1. **Built-in ACME (default):** the `certs` service obtains and renews Let's Encrypt certificates and shares them with Postfix, Cyrus and the proxy.
2. **External:** read from a file path. For Traefik, `traefik-certs-dumper` is documented.
3. **cert-manager:** on Kubernetes, from Secrets.

In every mode a watcher detects certificate changes and reloads Postfix and Cyrus without dropping service. Without any certificate, a self-signed one is generated so the stack still starts (development only).

## 9. Mail flow (Phase 1 design)

### 9.1 Inbound

1. A remote server connects to Postfix on port 25.
2. Postfix checks the recipient against PostgreSQL views (`postfix_domains`, `postfix_mailboxes`, `postfix_aliases`). Only **active (verified)** domains and **enabled** mailboxes accept mail.
3. Rspamd, as a milter, scores the message (SPF, DKIM, DMARC, blocklists, Bayes) and can reject, greylist or add headers.
4. Postfix hands the message to Cyrus over **LMTP**; Cyrus files it into `user/<address>` and applies the user's Sieve rules.

### 9.2 Outbound (submission)

1. A client connects to port 587 (STARTTLS) or 465 (implicit TLS) and authenticates with SASL.
2. Postfix asks saslauthd, which asks the API through PAM (`/api/internal/mail-auth`).
3. Postfix only allows envelope senders the authenticated user owns (`smtpd_sender_login_maps`, from PostgreSQL), and refuses the null sender. A mailbox owns its own address and the aliases of its organization that deliver to it; forwarding from another organization does not grant send-as.
4. An Rspamd prefilter rejects messages whose `From` header is not exactly the (already checked) envelope sender, so users cannot show someone else's address and DKIM only ever signs a domain the user may send for.
5. Rspamd signs the message with the domain's DKIM key (read from Valkey) and applies rate limits.
6. Postfix delivers it, using DANE/MTA-STS when the destination supports them.

### 9.2.1 Mail Cyrus sends (Sieve)

Sieve `redirect` and vacation replies are sent by Cyrus' `lmtpd` (its own configuration, `imapd-lmtp.conf`; every other Cyrus service keeps a closed `smtp_host`) to a Postfix port kept for it (10588), where only Cyrus' account can log in. Rspamd recognizes that port by its milter daemon name and lets through only:

- redirects, never DKIM-signed (the original signature still verifies), whose envelope sender Postfix replaces with `sieve-redirect@<MAIL_HOSTNAME>` so SPF passes at the destination (bounces of forwarded mail are not accepted back);
- vacation replies (null envelope sender), DKIM-signed with the From domain only when every hosted recipient of the message being answered was on that domain. Rspamd remembers the recipients of each message by Message-ID for two days. Sieve lets a user choose the From address; this stops them from making the server sign as another organization's domain.

### 9.3 Provisioning

- Creating a mailbox in the API creates the user's account and the row, then asks `MailEngine` to create the Cyrus mailbox with its folders and quota. If any step fails, the earlier ones are undone (each undo step independently), and the engine removes a mailbox it created only partly.
- Organizations cannot be deleted through Better Auth: that would drop rows and leave Cyrus mailboxes, accounts and DKIM keys behind. Instance administrators delete them through `DELETE /api/admin/organizations/:id` (the name must be typed to confirm), which removes sign-in providers, aliases, mailboxes (mail and accounts) and domains (DKIM keys) through the normal services before the organization row. The mail tables reference organizations with `ON DELETE RESTRICT` as a safety net.
- Domains become active only after DNS verification of the `postarix-verification=…` TXT record. A development switch (`DOMAIN_VERIFICATION=skip`) activates them immediately.
- DKIM keys are generated per domain by the API, stored encrypted in PostgreSQL and published to Valkey for Rspamd. The API re-synchronises Valkey at start and every five minutes (one failing domain does not stop the others), and verifying an active domain again re-publishes its key.

## 10. Background jobs

**BullMQ** on Valkey, inside `apps/api`. Replaces mailcow's `ofelia` container.

Examples: DKIM key rotation, periodic DNS checks for every domain, quarantine cleanup, DMARC/TLS-RPT reports, quota warnings, scheduled backups.

## 11. Observability

- Health checks in every container.
- Prometheus metrics (Postfix exporter, Rspamd, Cyrus, API).
- Optional Grafana dashboards.
- Structured JSON logs.

## 12. Deployment and scaling

| Scenario | Topology |
|---|---|
| **Personal / small business** | One server with Docker Compose. Everything on one node, automatic backups. |
| **Mid-size company** | Two Cyrus servers with replication (primary + replica). PostgreSQL with a replica. |
| **Large company / provider** | Several Cyrus pairs behind Cyrus Murder (a proxy that routes each user to their server). Postfix, Rspamd, API and frontends scale horizontally because they are stateless. Deployed with Helm on Kubernetes. |

## 13. Containers (Docker Compose install)

| Service | Image | Required |
|---|---|---|
| `postfix` | ours (Debian slim) | Yes |
| `cyrus` | ours (Debian slim), includes saslauthd | Yes |
| `rspamd` | ours (Debian slim) | Yes |
| `unbound` | ours (Debian slim) | Yes |
| `postgres` | official | Yes |
| `valkey` | official | Yes |
| `api` | ours | Yes |
| `admin` | ours | Yes |
| `webmail` | ours | Yes |
| `certs` | ours | Yes (self-signed, ACME or external mode) |
| `caddy` | official | Only in "bundled proxy" mode |
| `crowdsec` | official | Recommended |
| `clamd` | official | Optional |
| `olefy` | community | Recommended |
| `prometheus`, `grafana` | official | Optional |

## 14. Repository layout

```
postarix/
├── apps/
│   ├── api/            NestJS — business logic and Better Auth
│   ├── admin/          Next.js — admin panel
│   └── webmail/        React + Vite — webmail, calendar, contacts
├── packages/
│   ├── mail-engine/    MailEngine interface + Cyrus adapter
│   ├── jmap-client/    Typed JMAP client
│   ├── ui/             Shared components
│   └── config/         Shared TypeScript config
├── docker/
│   ├── compose/        docker-compose files for development and production
│   ├── postfix/        Dockerfile and configuration templates
│   ├── cyrus/
│   ├── rspamd/
│   └── unbound/
├── deploy/
│   ├── proxies/        Traefik, Caddy, nginx and HAProxy templates
│   └── helm/           Kubernetes chart
├── tests/
│   └── integration/    End-to-end tests against the full container stack
└── docs/               Documentation
```

## 15. Roadmap

### Phase 0 — Foundations
- [x] Monorepo (pnpm + Turborepo), CI, linters, conventions.
- [x] Development Docker Compose: PostgreSQL, Valkey.
- [x] `apps/api` with Better Auth, organizations and roles.
- [x] Initial database schema and migrations.
- [x] First multi-tenant resource (domains) with isolation tests.

### Phase 1 — Working mail
- [x] Postfix, Cyrus, Rspamd and Unbound containers.
- [x] Postfix reading domains, mailboxes and aliases from PostgreSQL.
- [x] `CyrusEngine` (create mailboxes with default folders, quotas).
- [x] Mailboxes, aliases and app passwords in the API.
- [x] Authentication bridge (saslauthd → PAM → API).
- [x] DNS verification of domains.
- [x] Integration tests that send and receive real mail through the stack.
- [x] Per-domain DKIM signing (and ARC sealing), DNS record guidance.
- [x] Certificates (self-signed, ACME, external) with automatic reload.
- [x] DANE for outgoing mail through the local validating resolver.
- [x] Reverse proxy templates (Caddy, nginx, Traefik, HAProxy), tested for internal-route leaks.
- **Milestone:** send and receive mail from a standard client (covered by the integration tests).

CrowdSec moved to Phase 5: blocking at the firewall needs a bouncer on the host,
which a container cannot provide without host networking. Until then, Postfix
limits authentication, connection and message rates per client, and the API locks
out the account password after repeated failures (app passwords keep working).

### Phase 2 — Admin panel
- [x] `apps/admin` (Next.js, shadcn/ui) served under `/admin`, with a strict nonce-based CSP.
- [x] Organizations, domains, mailboxes, aliases and members with their roles.
- [x] Live DNS status per domain (verification, MX, SPF, DKIM, DMARC), with the records to publish.
- [x] Audit log of every change, per organization.
- [x] Account page: profile, password, TOTP two-factor, passkeys, app passwords.
- [x] Playwright end-to-end tests (including cross-organization access) in CI; Docker image and proxy routes.
- Moved to Phase 5: MTA-STS (needs its policy host) and the Rspamd quarantine and logs view (needs per-organization filtering of Rspamd's history, which is instance-wide).

### Phase 3 — Webmail
- [x] `apps/webmail` (React + Vite, shadcn/ui) at the site root; `packages/jmap-client`.
- [x] JMAP through the API (`/api/jmap/*`): Cyrus' internal JMAP service, logged in as the user with short-lived API-minted tokens.
- [x] Folders, message list, full-text search (Xapian), reading, flags, moving, deleting, archiving.
- [x] Safe rendering: server-side sanitizing, sandboxed iframe with CSP, remote images blocked by default and fetched through a signed, SSRF-safe proxy; inline images embedded.
- [x] Composing, replying, forwarding, attachments, drafts; sending through the API with From ownership checks and Bcc removal.
- [x] Real-time updates (JMAP push over server-sent events).
- [x] Browser tests against the full stack in CI.
- Later: threads view, rich-text composing, Sieve filters and vacation replies, labels.

### Phase 4 — Calendar and contacts
- [x] Calendar in the webmail over JMAP Calendars (JSCalendar): month view, agenda on small screens, all-day and repeating events, places and notes.
- [x] Contacts in the webmail over Cyrus' JMAP contacts: list with search, details, editing; suggestions while writing mail.
- [x] The same calendars and address books sync to phones and desktop apps over CalDAV/CardDAV (`/dav`, discovery through `/.well-known`) with DAV-scoped app passwords; default calendar and address book created on first use.
- [x] A visual identity of its own for every interface (ink, postal yellow, airmail edge; Bricolage Grotesque and Instrument Sans, self-hosted).
- [x] Integration and browser tests: JMAP ↔ CalDAV/CardDAV sync, privacy between users, calendar and contacts in the browser.
- Later: week and day views, invitations (iTIP) and free/busy, shared calendars and address books.
- Invitations (iMIP), shared resources.

### Phase 5 — Enterprise and scale
- [x] SSO with OpenID Connect. Later: SAML, passkeys enforceable by policy.
- [x] CrowdSec (optional `crowdsec` profile) reading the Postfix and Cyrus logs, with the firewall bouncer on the host (see `docs/CROWDSEC.md`).
- Replication and Cyrus Murder; Helm chart.
- Migration from Google Workspace and Microsoft 365.
- Legal hold and archiving.
- [x] Filtering history per organization (from Rspamd's history, filtered to the organization's domains); MTA-STS policy host.
- [x] Organization deletion with full deprovisioning (Cyrus mailboxes, accounts, DKIM keys).
- External security audit → **1.0**.

## Decision log

| Date | Decision |
|---|---|
| 2026-11-01 | Project name: **Postarix**. |
| 2026-11-01 | Mailbox engine: **Cyrus IMAP** (over Dovecot CE 2.4 and Stalwart). |
| 2026-11-01 | MTA: **Postfix**. Spam filter: **Rspamd**. |
| 2026-11-01 | Backend: **NestJS**. Identity: **Better Auth**. |
| 2026-11-01 | Admin with **Next.js**; webmail as a **React + Vite SPA** over **JMAP**. |
| 2026-11-02 | Webmail JMAP goes through the API, which logs in to an internal Cyrus JMAP service **as the user** with short-lived HMAC tokens checked by the normal login bridge (Cyrus only allows `Authorize-As` proxying on Murder backends). The client never chooses the account. The proxy only lets through the JMAP capabilities and methods the webmail uses (no EmailSubmission, Sieve, backup or admin methods), and the JMAP service listens on the internal network address only. |
| 2026-11-02 | Webmail sending goes through the API (From must be in `mail.sender_logins`, Bcc removed) to an internal Postfix port with its own account; Rspamd still requires From = envelope and signs DKIM. |
| 2026-11-02 | Email HTML is sanitized on the server and shown in a sandboxed iframe (no scripts, opaque origin) with a CSP; remote images are blocked by default and loaded through a signed proxy that only reaches public addresses. |
| 2026-11-02 | Calendar and contacts in the webmail use **JMAP** (Cyrus' JMAP service loads the CalDAV/CardDAV stores behind it), so the webmail, CalDAV and CardDAV clients share one copy of the data. |
| 2026-11-02 | Visual identity: shadcn/ui's quiet neutral system tinted with ink blue (structure, actions) and postal yellow used sparingly (compose, today, the unread count). Navigation sits on an ink rail and content on an inset panel. One self-hosted typeface (Instrument Sans), so the strict CSP stays `font-src 'self'`. |
| 2026-11-02 | UI components: **shadcn/ui** (Radix UI + Tailwind CSS v4) in `packages/ui`, shared by the admin panel and the webmail. |
| 2026-11-01 | Monorepo with **pnpm workspaces + Turborepo**. |
| 2026-11-01 | Proxy-agnostic; mail ports bypass the reverse proxy. |
| 2026-11-01 | License **AGPL-3.0**. |
| 2026-11-01 | ORM: **Drizzle** (explicit SQL, strong typing, versioned migrations; official Better Auth adapter). |
| 2026-11-01 | Runtime **Node.js 22+**, **ESM** across the monorepo, **TypeScript 6** (typescript-eslint does not support TS 7 yet). |
| 2026-11-01 | User passwords hashed with **argon2id** (OWASP parameters), like app passwords. |
| 2026-11-01 | **Public sign-up disabled** and organization creation limited to super-admins by default. The first account is created with `create-admin`. |
| 2026-11-01 | Access to another organization returns **404** (not 403) so its existence isn't revealed. |
| 2026-11-01 | End-to-end tests run against a **real PostgreSQL** (CI service), not mocks. |
| 2026-11-01 | Domain ownership is proven with a **TXT record** (`postarix-verification=…`). While `pending`, several organizations may claim the same name, so nobody can squat someone else's domain or learn whether another tenant has it. Only one verified domain per name may exist. |
| 2026-11-01 | All request bodies are parsed and capped (1 MB, JSON or forms only) **before** any route, Better Auth's included. |
| 2026-11-01 | Better Auth's origin/CSRF checks are forced on explicitly; the library disables them by itself in test environments. |
| 2026-11-01 | An installation whose `AUTH_URL` uses https refuses to start unless `NODE_ENV` is `production`. |
| 2026-11-01 | The repository (code, docs, commits) is in **English**. |
| 2026-11-01 | Mail-protocol logins go through **saslauthd → PAM (`pam_exec`) → API**. The account password works for mail only while the user has no 2FA; app passwords always work. |
| 2026-11-01 | Our own images for Postfix, Cyrus, Rspamd and Unbound on **Debian trixie-slim**, so versions and configuration are under our control. |
| 2026-11-02 | DKIM private keys are stored encrypted with a key derived from `AUTH_SECRET` and published to Valkey, where Rspamd reads them. Changing `AUTH_SECRET` therefore requires re-generating DKIM keys. |
| 2026-11-02 | Internal endpoints refuse any request carrying `X-Forwarded-For`/`Forwarded`: if a proxy ever exposes them by mistake, they still answer 404. |
| 2026-11-02 | Cyrus admin rights exist only on an internal port (1143) with its own configuration; the public services have no admins. The admin account cannot even log in on the public services (sasldb only in the admin configuration). |
| 2026-11-02 | The `From` header of submitted mail must equal the envelope sender, which Postfix ties to the login; the null sender is refused on submission. This closes cross-tenant DKIM signing. |
| 2026-11-02 | Mail-login lockout (10 failures / 15 min) applies to the account password only. App passwords (~120 bits) keep working, so an attacker cannot lock real clients out. Per-IP throttling comes with CrowdSec (Phase 5). |
| 2026-11-02 | Network split: the proxy only reaches the API, Cyrus HTTP and the certs service; LMTP is a Unix socket; the API verifies Cyrus' certificate. |
| 2026-11-02 | SSO signs in only the owner of an active mailbox of the identity provider's organization (checked on every sign-in). An organization's IdP thus has no more power than its admins, who can already reset those mailboxes' passwords, and never reaches other tenants or instance administrators. Providers are owned by a banned, passwordless system account because Better Auth deletes a provider with its owning user. |

| 2026-11-02 | Cyrus sends Sieve redirects and vacation replies through Postfix (port 10588) with Rspamd rules that bound what may be sent and signed (§9.2.1), instead of not sending at all. Envelope senders of redirects are rewritten to the server's own name rather than SRS: the Cyrus package is built without libsrs2, and a rewrite needs no extra daemon. |
| 2026-11-02 | Internal secrets are derived per purpose (HMAC-SHA256) from `INTERNAL_API_TOKEN`: the mail-login bridge, the API's submission port and Cyrus' submission port each get their own, and the token never leaves the API. The API's submission connection uses STARTTLS. |
| 2026-11-02 | SSO client secrets are encrypted at rest (AES-256-GCM, key derived from `AUTH_SECRET`) and opened only by the database adapter Better Auth reads providers through. Private identity providers are allowed with `SSO_TRUSTED_ISSUERS`, trusted by Better Auth on the sign-in routes only. |
| 2026-11-02 | Rate limits, mail-login failure counters and sending quotas live in Valkey, so they hold across API replicas. |
| 2026-11-02 | No organization invitations: members are mailbox owners of the organization, added by its admins, who are told by mail (system notices through Postfix). |
| 2026-11-02 | On Kubernetes the mail pod resolves through an Unbound container of its own (DNSSEC-validating, forwarding the cluster domain to the cluster DNS), so DANE works as with Compose. CI installs the chart on kind and runs the mail tests against it. |

## Known limitations

- Bounces of mail forwarded by a Sieve `redirect` are not delivered back to the original sender (the envelope sender is the server's, not SRS).
- A vacation reply is not sent when Rspamd does not know the message it answers (received more than two days earlier, or without a Message-ID).
- The webmail has no screen for filters and vacation replies yet: users set them with any ManageSieve client (port 4190), e.g. Thunderbird or a phone app.
- The internal JMAP service and Cyrus' submission port use plain text inside the internal network (Compose) or inside the mail pod (Kubernetes, loopback); the mail-login bridge to the API crosses the cluster network in plain text with a secret good for that purpose only. Use a CNI with encryption where the pod network is not trusted.
