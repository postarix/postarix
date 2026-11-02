# Postarix

**A modern, self-hosted, open-source email platform.**

Postarix brings everything you need to run your own email into one system: sending and receiving, spam and virus filtering, webmail, calendar, contacts and an admin panel. It works the same for a single person as for a large company or a provider hosting many organizations.

> **Status: release candidate.** Feature-complete for self-hosting (mail, webmail, calendar, contacts, admin panel, SSO, scaling with Cyrus Murder) and hardened by an internal security review; an external security audit comes before 1.0. Start with [`docs/INSTALL.md`](docs/INSTALL.md).

## Why Postarix

- **Its own modern interface.** Webmail, calendar, contacts and admin built with React, Next.js and TypeScript. No SOGo, no Roundcube.
- **Multi-tenant from the start.** Organizations, domains, roles and quotas are part of the core, not an add-on.
- **Scales without changing architecture.** From a VPS to a cluster with the same building blocks.
- **100% open source.** No components with features held back for paid editions.
- **Secure by default.** 2FA, passkeys, app passwords, MTA-STS, DANE, isolation between organizations.
- **Works with your proxy.** Traefik, Caddy, nginx or HAProxy, or a bundled proxy.

## Stack

| Layer | Technology |
|---|---|
| SMTP | Postfix |
| Mailboxes, IMAP, JMAP, CalDAV, CardDAV | Cyrus IMAP |
| Spam filtering, DKIM, DMARC | Rspamd |
| Antivirus | ClamAV (optional) |
| DNS | Unbound |
| Brute-force protection | CrowdSec |
| Backend | NestJS + Better Auth |
| Admin panel | Next.js |
| Webmail | React + Vite |
| Data | PostgreSQL + Valkey |

The full architecture, with the reasoning behind each decision, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

```
apps/
  api/          Backend (NestJS)
  admin/        Admin panel (Next.js)
  webmail/      Webmail, calendar and contacts (React + Vite)
packages/
  mail-engine/  Adapter to the mail server
  jmap-client/  JMAP client
  ui/           Shared components
  config/       Shared configuration
docker/         Images and docker-compose files
deploy/         Proxy templates and Helm chart
tests/          Integration tests against the full stack
docs/           Documentation
```

## Development

Requirements: Node.js 22 or newer (24 LTS recommended), pnpm (via Corepack) and Docker.

```bash
corepack enable
pnpm install
cp .env.example .env                       # fill in AUTH_SECRET
pnpm dev:services                          # starts PostgreSQL and Valkey
pnpm --filter @postarix/api db:migrate     # creates the tables
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' \
  pnpm --filter @postarix/api create-admin # first account (super-admin)
pnpm dev                                   # starts the apps
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Roadmap

1. **Phase 0** — Foundations: monorepo, CI, API with authentication and organizations.
2. **Phase 1** — Working mail: Postfix, Cyrus, Rspamd, DKIM, certificates.
3. **Phase 2** — Admin panel.
4. **Phase 3** — Webmail.
5. **Phase 4** — Calendar and contacts.
6. **Phase 5** — Enterprise features, high availability and 1.0.

Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#15-roadmap).

Using Postarix with Thunderbird, Apple Mail, Outlook or a phone: [`docs/CONNECTING-DEVICES.md`](docs/CONNECTING-DEVICES.md).

## Security

If you find a vulnerability, **do not open a public issue**. Follow [`SECURITY.md`](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE).
