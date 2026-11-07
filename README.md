<p align="center">
  <img src="docs/public/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">Postarix</h1>

<p align="center">
  <strong>Your own email, done properly.</strong><br>
  Mail, webmail, calendar, contacts and an admin panel in one self-hosted, open-source system.
</p>

<p align="center">
  <a href="https://github.com/postarix/postarix/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/postarix/postarix?sort=semver"></a>
  <a href="https://github.com/postarix/postarix/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/postarix/postarix/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <a href="https://postarix.github.io/postarix/"><img alt="Documentation" src="https://img.shields.io/badge/docs-postarix.github.io-informational"></a>
</p>

<p align="center">
  <a href="https://postarix.github.io/postarix/">Documentation</a> ·
  <a href="https://postarix.github.io/postarix/install-ubuntu">Install</a> ·
  <a href="https://postarix.github.io/postarix/api">API</a> ·
  <a href="https://github.com/postarix/postarix/releases">Releases</a>
</p>

---

Postarix runs everything an email service needs on your own server: sending and
receiving, spam and virus filtering, a modern webmail with calendar and
contacts, and an admin panel. It works the same for one person with a domain,
a company, or a provider hosting thousands of organizations. Multi-tenancy is
part of the core.

It is built on proven mail software (**Postfix**, **Cyrus IMAP**,
**Rspamd**), configured and wired together, with its own API and interfaces
written in TypeScript.

## Features

**Mail**
- SMTP, IMAP, POP3, JMAP, Sieve filters, automatic replies and forwarding.
- Spam filtering with Rspamd (per-mailbox allow and block lists, quarantine
  with digests), optional virus scanning with ClamAV.
- SPF, per-domain DKIM (generated or imported keys), DMARC, ARC, MTA-STS and DANE.
- Aliases, alias domains, catch-alls, backup MX, BCC copies, smart hosts
  per domain, sending limits.
- **Shared mailboxes** (`support@`, `sales@`) with members and rights; an
  existing mailbox can be converted into one, keeping its mail.

**Webmail, calendar and contacts**
- Conversations, labels, full-text search, rich-text composing, drafts and
  attachments, real-time updates.
- Untrusted mail rendered safely: sanitized on the server, shown in a
  sandboxed frame, remote images blocked until asked for.
- Calendar with invitations (iTIP/iMIP), free/busy, sharing, rooms and
  equipment; contacts with suggestions while writing.
- Everything syncs with phones and desktop apps over IMAP, CalDAV and CardDAV.
- Import from Gmail or any IMAP server, and from `.ics` and `.vcf` files.

**Administration**
- Organizations, domains with live DNS status and the exact records to
  publish, mailboxes, quotas, members and roles, templates.
- Two-step sign-in (authenticator app or passkey) that an organization can
  require, app passwords limited by protocol.
- Single sign-on with OpenID Connect and SAML 2.0.
- Archiving and legal hold, filtering history, mail queue, logs, an audit log
  of every change.
- Custom name and logo.

**Integration**
- A documented REST API ([OpenAPI](https://postarix.github.io/postarix/api),
  browsable at `/api/docs` on every server) with API keys limited by
  organization, address and access.
- Other applications can act for your people (OAuth 2.0 Token Exchange,
  RFC 8693) and use JMAP, so a helpdesk or an intranet can be their mail
  client without ever seeing a password.

**Operations**
- Docker Compose with templates for Caddy, Traefik, nginx and HAProxy; Dokploy;
  a Helm chart for Kubernetes.
- Scale-out with Cyrus Murder, moving mailboxes between backends.
- Signed multi-architecture images (amd64, arm64) with SBOMs.
- Encrypted backups and restore, Prometheus metrics and alerts, CrowdSec.

## Getting started

You need a Linux server with a public IPv4 address (2 vCPU and 4 GB of memory
are enough for about 200 mailboxes), a domain, and a provider that allows
outbound port 25 and lets you set the reverse DNS of your address.

| Guide | For |
|---|---|
| [Install on Ubuntu](https://postarix.github.io/postarix/install-ubuntu) | One server, step by step, from a fresh Ubuntu |
| [Install with Dokploy](https://postarix.github.io/postarix/install-dokploy) | Servers already managed with Dokploy |
| [Production guide](https://postarix.github.io/postarix/install) | Any Linux with Docker, your own reverse proxy, or Kubernetes |
| [Try it on your computer](https://postarix.github.io/postarix/try-locally) | A local test without a domain |

In short, on a server with Docker:

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/postarix/postarix /opt/postarix
cd /opt/postarix
deploy/scripts/generate-env.sh mail.example.com you@example.com 1.0.0

cd docker/compose
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env up -d --wait
docker compose -f postarix.yml --env-file postarix.env exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase' \
  api node dist/cli/create-admin.js
```

Then open `https://mail.example.com/admin`, add your domain and publish the DNS
records it shows. [First steps](https://postarix.github.io/postarix/first-steps)
walks through it.

## Documentation

- **Running a server:** [configuration](https://postarix.github.io/postarix/configuration),
  [updating](https://postarix.github.io/postarix/updating),
  [backups](https://postarix.github.io/postarix/backup),
  [monitoring](https://postarix.github.io/postarix/monitoring),
  [antivirus](https://postarix.github.io/postarix/antivirus),
  [CrowdSec](https://postarix.github.io/postarix/crowdsec),
  [scaling out](https://postarix.github.io/postarix/scaling),
  [troubleshooting](https://postarix.github.io/postarix/troubleshooting).
- **Using it:** [administration](https://postarix.github.io/postarix/administration),
  [connecting devices](https://postarix.github.io/postarix/connecting-devices),
  [calendar](https://postarix.github.io/postarix/calendar),
  [archiving](https://postarix.github.io/postarix/archiving),
  [moving from another provider](https://postarix.github.io/postarix/migration).
- **Building on it:** [API reference](https://postarix.github.io/postarix/api),
  [integrating another application](https://postarix.github.io/postarix/integrations),
  [architecture and decisions](docs/ARCHITECTURE.md).

## How it fits together

```
           Internet
   ┌──────────┴───────────────────────────────┐
   │ 80/443 (web)                 25, 465, 587, 143, 993, 995, 4190 (mail)
   ▼                                          ▼
 Reverse proxy ──► webmail, admin, API    Postfix ─► Rspamd (+ ClamAV)
 (Caddy, Traefik…)        │                  │
                          ▼                  ▼
                  PostgreSQL, Valkey ◄──── Cyrus IMAP (mail, calendars, contacts)
```

| Layer | Technology |
|---|---|
| SMTP | Postfix |
| Mailboxes, IMAP, POP3, JMAP, CalDAV, CardDAV | Cyrus IMAP |
| Spam filtering, DKIM, DMARC, ARC | Rspamd |
| Antivirus | ClamAV (optional) |
| DNS (DNSSEC, DANE) | Unbound |
| Brute-force protection | CrowdSec (optional) |
| API | NestJS, Better Auth |
| Admin panel | Next.js |
| Webmail | React, Vite |
| Data | PostgreSQL, Valkey |

Mail ports go straight to Postfix and Cyrus; only web traffic goes through the
reverse proxy. The mail software is configured, never modified. The reasons
behind each choice are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

Requirements: Node.js 22 or newer (24 LTS recommended), pnpm (through
Corepack) and Docker.

```bash
corepack enable
pnpm install
cp .env.example .env                       # fill in AUTH_SECRET
pnpm dev:services                          # PostgreSQL and Valkey
pnpm --filter @postarix/api db:migrate     # creates the tables
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' \
  pnpm --filter @postarix/api create-admin # first account (instance administrator)
pnpm dev                                   # API, admin panel and webmail
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. The
integration tests in `tests/integration` run against the full container stack.

```
apps/
  api/          API (NestJS)
  admin/        Admin panel (Next.js)
  webmail/      Webmail, calendar and contacts (React + Vite)
packages/
  mail-engine/  Adapter to the mail server (Cyrus, Cyrus Murder)
  jmap-client/  JMAP client
  ui/           Shared components (shadcn/ui)
  config/       Shared configuration
docker/         Images and Compose files
deploy/         Proxy templates, scripts, monitoring and the Helm chart
tests/          Integration tests against the full stack
docs/           Documentation (the site: pnpm --filter @postarix/docs docs:dev)
```

Contributions are welcome: read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.

## Security

Report vulnerabilities privately, never in a public issue: see
[`SECURITY.md`](SECURITY.md).

## License

Postarix is free software under the
[GNU Affero General Public License v3.0](LICENSE).
