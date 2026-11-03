# What is Postarix

Postarix is a self-hosted, open-source (AGPL-3.0) email platform. It brings
everything you need to run your own email into one system:

- **Mail:** sending and receiving (SMTP), IMAP and POP3 for mail apps,
  server-side filters (Sieve), automatic replies and forwarding.
- **Protection:** spam filtering with Rspamd, optional virus scanning with
  ClamAV, SPF, DKIM, DMARC and ARC, MTA-STS and DANE, brute-force protection
  with CrowdSec.
- **Webmail** with conversations, labels, search, rich text, attachments and
  safe rendering of untrusted mail.
- **Calendar and contacts** in the webmail and on phones and desktop apps
  (CalDAV/CardDAV): invitations, free/busy, sharing, rooms and equipment.
- **An admin panel** for organizations, domains (with the exact DNS records to
  publish), mailboxes, aliases, members and roles, sign-in rules, single
  sign-on, filtering history, archiving and an audit log.

It works the same for one person with a domain, a company, or a provider
hosting many organizations: multi-tenancy is part of the core.

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

- **Postfix** receives and sends mail; **Rspamd** filters it; **Cyrus IMAP**
  stores mail, calendars and contacts and serves IMAP, POP3, JMAP, CalDAV and
  CardDAV.
- The **API** (NestJS) holds accounts, organizations and settings in
  PostgreSQL, and is the only component that talks to the mail store for
  administration. The **webmail** (React) and **admin panel** (Next.js) use it.
- Mail ports go straight to Postfix and Cyrus (they need the real client
  addresses); only web traffic goes through the reverse proxy.

The full picture, with the reasons behind each choice, is in
[Architecture](./architecture).

## What you need

- A server (or VM) with a public IPv4 address, 2 vCPU and 4 GB of memory for
  up to about 200 mailboxes, running Linux with Docker.
- A domain name and access to its DNS.
- A hosting provider that allows **outbound port 25** and lets you set the
  **reverse DNS (PTR)** of your IP address. Without these, other mail servers
  will not accept your mail.

Ready? [Install on Ubuntu](./install-ubuntu) or [with Dokploy](./install-dokploy) — or first [try it on your computer](./try-locally).

## Project status

Postarix is a **beta**: feature-complete for self-hosting and reviewed for
security internally; an external security audit comes before 1.0. Releases and
their notes are on [GitHub](https://github.com/postarix/postarix/releases).
