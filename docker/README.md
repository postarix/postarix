# Containers

Postarix runs as a set of containers. Our own images build on Debian trixie-slim;
PostgreSQL and Valkey use their official images.

| Directory | Image | Role |
|---|---|---|
| `cyrus/` | `postarix/cyrus` | Mailboxes: IMAP, POP3, ManageSieve, CalDAV, CardDAV, and JMAP for the API (webmail). Also runs saslauthd, the login bridge to the API. |
| `postfix/` | `postarix/postfix` | SMTP: inbound mail (25), submission (587, 465) and an internal port (10587) for webmail sending. |
| `rspamd/` | `postarix/rspamd` | Spam filtering and DKIM, as a Postfix milter. |
| `unbound/` | `postarix/unbound` | DNSSEC-validating resolver for Rspamd. |
| `postgres/` | — | Init script that creates the read-only role Postfix uses. |
| `certs/` | `postarix/certs` | TLS certificates (self-signed, ACME or external) shared with Postfix and Cyrus. |
| `../apps/api/Dockerfile` | `postarix/api` | The Postarix API. Applies database migrations on start. |
| `../apps/admin/Dockerfile` | `postarix/admin` | The admin panel, served under `/admin`. |
| `../apps/webmail/Dockerfile` | `postarix/webmail` | The webmail, served at the site root. |

## Running the stack

```bash
cp docker/compose/postarix.env.example docker/compose/postarix.env
# Fill in MAIL_HOSTNAME, AUTH_URL and every secret (openssl rand -base64 36 | tr -d '/+=').
docker compose -f docker/compose/postarix.yml --env-file docker/compose/postarix.env up -d --build

# First account (instance super-admin):
docker compose -f docker/compose/postarix.yml --env-file docker/compose/postarix.env \
  exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase' api node dist/cli/create-admin.js
```

The API listens on port 3000 inside the Docker network; put your reverse proxy in
front of it (see `deploy/proxies`). Never expose `/api/internal/*`.

## How a login works

1. A mail client logs in to Cyrus (IMAP/POP3/Sieve) or Postfix (SMTP submission).
2. Both ask **saslauthd**, which runs in the Cyrus container. Postfix reaches it
   through the shared `saslauthd-run` volume.
3. saslauthd uses PAM; `pam_exec` runs `postarix-mail-auth`, which posts the
   credentials to `http://api:3000/api/internal/mail-auth` with the shared
   `INTERNAL_API_TOKEN`.
4. The API accepts app passwords with the right scope, and the account password
   while the user has no second factor.

The Cyrus admin account (used by the API to create mailboxes) only exists on an
internal admin port (1143) that is never published.

## Integration tests

```bash
tests/integration/run.sh              # build, start, test, tear down
KEEP_STACK=1 tests/integration/run.sh # leave the stack running afterwards
```

The tests send and receive real mail through Postfix, Rspamd and Cyrus, and log
in over IMAP with account and app passwords. CI runs them on every change.
