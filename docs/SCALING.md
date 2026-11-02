# Scaling out mail storage (Cyrus Murder)

One Cyrus server holds every mailbox by default. When one server is no longer
enough, Postarix spreads mailboxes over several Cyrus **backends** with
[Cyrus Murder](https://www.cyrusimap.org/imap/reference/architecture/murder.html):

```
 mail apps, Postfix ──► frontend (the "cyrus" service / mail pod)
                          │  routes each user to their backend
                          ▼
             ┌──────── backend 1 ── backend 2 ── … ───┐
             │   mailboxes, calendars, contacts, Sieve │
             └──────────────┬─────────────────────────┘
                            ▼
                     mupdate server (which mailbox is where)

 Postarix API ──► the user's backend directly (administration, JMAP for the webmail)
```

- **Frontend**: where IMAP, POP3, ManageSieve, CalDAV/CardDAV clients and
  Postfix (LMTP delivery) connect, as before. It holds no mail; it looks the
  user up in its copy of the mailbox list and passes the connection on to
  their backend.
- **Backends**: hold the mailboxes. They are reached only inside the
  installation (never by clients directly).
- **mupdate server**: the list of which mailbox lives on which backend. Each
  backend publishes its mailboxes there; the frontends follow it.
- **The API** records each mailbox's backend (`mailboxes.mail_server`).
  An organization's mailboxes stay together on one backend (so calendars and
  contacts shared between colleagues work everywhere); a new organization goes
  to the backend with the fewest mailboxes. Administration (quota, deletion,
  calendar sharing) and the webmail's JMAP go to the mailbox's backend.
  Frontends learn a new mailbox within about a second; creating one waits for
  that.

Internal accounts used between the servers (`postarix-mupdate`,
`postarix-murder`) get passwords derived from `INTERNAL_API_TOKEN` and are
valid only on the backends and the mupdate server, never on the frontend's
public ports.

## Docker Compose

```bash
docker compose -f docker/compose/postarix.yml -f docker/compose/murder.yml \
  --env-file docker/compose/postarix.env up -d
```

`murder.yml` adds the mupdate server and two backends, turns the `cyrus`
service into the frontend and tells the API about the backends
(`CYRUS_BACKENDS=b1=cyrus-backend-1,b2=cyrus-backend-2`). To add a backend,
copy `cyrus-backend-2` there with its own name, volumes and
`CYRUS_SERVERNAME`, and add it to `MURDER_BACKENDS` (frontend) and
`CYRUS_BACKENDS` (API).

## Kubernetes (Helm)

```yaml
mail:
  murder:
    enabled: true
    backends: 3
```

The backends are a StatefulSet (`<release>-cyrus-backend-N`), each with its
own volume; the mail pod's Cyrus becomes the frontend. Raise `backends` to add
servers: new organizations go to the emptiest one.

## Moving an existing installation to a Murder

Mailboxes created before the Murder have no recorded backend; the API treats
them as living on `CYRUS_DEFAULT_BACKEND` (the first backend by default). Move
the existing Cyrus data (`/var/lib/cyrus`, `/var/spool/cyrus`,
`/var/spool/sieve`) to that backend's volumes before switching, as when
restoring a backup (`docs/BACKUP.md`); the backend publishes its mailboxes to
the mupdate server when it starts.

## Limits

- Lowering the number of backends, or removing one, needs its mailboxes moved
  first (Cyrus' `XFER`); Postarix does not do it automatically yet.
- An organization larger than one backend can hold does not fit this
  placement yet. Calendars and contacts shared between people on different
  backends would not be visible in the webmail (JMAP only reaches the person's
  own backend); free/busy and invitations work across backends.
- `deploy/scripts/backup.sh` backs up a single Cyrus; back up each backend's
  volumes in a Murder.
