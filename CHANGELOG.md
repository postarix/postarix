# Changelog

All notable changes to Postarix. The project follows
[semantic versioning](https://semver.org); every release, with its images and
Compose files, is on [GitHub](https://github.com/postarix/postarix/releases).

## 1.0.0

The first stable release.

**Mail**
- Postfix, Cyrus IMAP, Rspamd and Unbound configured and wired together:
  SMTP, IMAP, POP3, JMAP, Sieve, CalDAV and CardDAV.
- Domains, mailboxes, aliases, alias domains, catch-alls, backup MX, BCC copies,
  smart hosts per domain, quotas and sending limits.
- SPF, per-domain DKIM (generated or imported keys), DMARC, ARC, MTA-STS and
  DANE; certificates by ACME, from files or from cert-manager, reloaded
  automatically.
- Spam filtering with per-mailbox lists and quarantine, content filters, IP
  access rules; optional ClamAV and CrowdSec.
- Shared mailboxes with members and rights (read, read and organize, send),
  one read state for the team, and an optional `Sender:` header. Any mailbox can
  be converted into a shared one, and back, keeping its mail.

**Webmail, calendar and contacts**
- Conversations, labels, full-text search, rich-text composing, safe rendering
  of untrusted mail, filters, automatic replies, real-time updates.
- Calendar with invitations, free/busy, sharing, rooms and equipment; contacts.
- Import from any IMAP server (Gmail included) and from `.ics` and `.vcf`.

**Administration and accounts**
- Organizations, domains with live DNS status, members and roles, templates,
  archiving and legal hold, filtering history, mail queue, logs, audit log.
- Two-step sign-in (authenticator app, passkeys) that organizations can
  require; app passwords by protocol; OpenID Connect and SAML 2.0 single
  sign-on; external identities.
- Open sessions everywhere (webmail and mail apps) end when access is taken
  away.

**Integration**
- REST API documented with OpenAPI (`/api/docs`), API keys limited by
  organization, address and access, with explicit refusal codes.
- Connected applications acting for people through OAuth 2.0 Token Exchange
  (RFC 8693) with client secrets or `private_key_jwt` (RFC 7523), JMAP access,
  unread counts, and audited, read-only supervision.

**Operations**
- Docker Compose with Caddy, Traefik, nginx and HAProxy templates; Dokploy;
  Helm chart; Cyrus Murder with mailbox moves between backends.
- Signed amd64 and arm64 images with SBOMs, encrypted backups, Prometheus
  metrics and alerts.

Updating from a 0.0.1 beta: see [Updating](docs/updating.md).
