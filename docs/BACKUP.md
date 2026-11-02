# Backups and restore

Everything Postarix needs to come back lives in four places:

| What | Where | In the backup |
|---|---|---|
| Accounts, organizations, domains, aliases, app passwords, sign-in providers, DKIM keys (encrypted), audit log | PostgreSQL | `database.dump` |
| Mail, calendars, contacts, Sieve scripts | Cyrus volumes (`cyrus-spool`, `cyrus-sieve`, `cyrus-lib`) | `cyrus.tar.gz` + `mailboxes.txt` |
| Learned spam data, filtering history | Valkey | `valkey.rdb` (optional) |
| Secrets and settings | `docker/compose/postarix.env` | **no** — keep your own copy |

Keep `postarix.env` safe and separate from the backups: `AUTH_SECRET` decrypts the
DKIM keys stored in the database, and the other secrets are needed to start the
stack. Without it, a restored server needs new DKIM keys (and new DNS records).

TLS certificates are not backed up: self-signed and ACME certificates are issued
again on start.

## Making a backup

```bash
deploy/scripts/backup.sh /srv/backups/postarix-$(date +%F)
```

The server keeps running. The script dumps the database, Cyrus' mailbox list and
the mail store, and writes a `MANIFEST` with checksums. Copy the directory off
the server (restic, borg, rsync to another host…) and keep several generations.

Scheduling, for example nightly with cron:

```
30 2 * * * cd /opt/postarix && deploy/scripts/backup.sh /srv/backups/postarix-$(date +\%F) >>/var/log/postarix-backup.log 2>&1
```

### Encrypted backups

Backups hold every message and the password hashes, so encrypt them before
they leave the server. Install [age](https://age-encryption.org)
(`apt install age`), create a key pair **on another machine**, and give the
server only the public key:

```bash
age-keygen -o postarix-backup.key          # on your workstation; keep it safe
age-keygen -y postarix-backup.key > recipients.txt
# copy recipients.txt to the server, e.g. /etc/postarix/backup-recipients.txt
BACKUP_AGE_RECIPIENTS=/etc/postarix/backup-recipients.txt \
  deploy/scripts/backup.sh /srv/backups/postarix-$(date +%F)
```

Every file is encrypted as it is written (`database.dump.age`,
`cyrus.tar.gz.age`…); nothing readable touches the disk, and a stolen backup
(or the server itself) cannot decrypt it. Several public keys, one per line,
let any of their holders restore.

### Cyrus Murder

With `murder.yml`, list both Compose files:

```bash
COMPOSE_FILE=docker/compose/postarix.yml:docker/compose/murder.yml \
  deploy/scripts/backup.sh /srv/backups/postarix-$(date +%F)
```

Each backend gets its own `cyrus-<service>.tar.gz` and
`mailboxes-<service>.txt`. The frontend and the mupdate server hold no mail;
their mailbox lists are rebuilt from the backends when those start. Restore
into the same backends (same service names), with the same `COMPOSE_FILE`.

Test a restore on a spare machine from time to time: a backup that has never been
restored is a hope, not a backup.

## Restoring

On the new (or repaired) server, with the same `postarix.env`:

```bash
docker compose -f docker/compose/postarix.yml --env-file docker/compose/postarix.env up -d postgres valkey
deploy/scripts/restore.sh /srv/backups/postarix-2026-11-02
```

For an encrypted backup, also pass the private key:
`BACKUP_AGE_IDENTITY=postarix-backup.key deploy/scripts/restore.sh …`.

The script checks the checksums, asks for confirmation (`YES=1` skips it), stops
the services that write data, restores the database and the mail store, starts
everything and lets Cyrus rebuild its indexes. Point DNS at the new server if
its address changed; DKIM records stay valid because the keys are restored.

## Kubernetes

With the Helm chart, back up the PostgreSQL database with your usual tooling
(e.g. the operator's backups) and the Cyrus persistent volumes with volume
snapshots or Velero. The same rule applies: keep the chart's secrets.
