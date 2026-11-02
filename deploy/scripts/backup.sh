#!/usr/bin/env bash
# Backs up a Docker Compose installation of Postarix into one directory:
#   - database.dump   PostgreSQL (accounts, organizations, domains, DKIM keys
#                     encrypted with AUTH_SECRET, audit log…), pg_dump custom format
#   - mailboxes.txt   Cyrus' mailbox list (ctl_mboxlist -d)
#   - cyrus.tar.gz    mail, calendars, contacts, Sieve scripts and Cyrus' metadata
#   - valkey.rdb      Rspamd's learned spam data and history (optional to restore)
#   - MANIFEST        versions and checksums
#
# With a Cyrus Murder (murder.yml), each backend has its own pair instead:
# mailboxes-<service>.txt and cyrus-<service>.tar.gz. The frontend and the
# mupdate server hold no mail; their mailbox lists are rebuilt from the
# backends when they start.
#
# Encryption: with BACKUP_AGE_RECIPIENTS set to a file of age public keys
# (https://age-encryption.org, `apt install age`), every file is encrypted as
# it is written (<name>.age) and nothing readable touches the disk. Keep the
# matching private key away from the server; restore.sh needs it
# (BACKUP_AGE_IDENTITY).
#
# It does not copy postarix.env: keep a copy of it somewhere safe. Without
# AUTH_SECRET the DKIM keys in the database cannot be decrypted.
#
#   deploy/scripts/backup.sh /srv/backups/postarix-$(date +%F)
#
# Environment: COMPOSE_FILE (default docker/compose/postarix.yml; with a
# Murder "docker/compose/postarix.yml:docker/compose/murder.yml"),
# ENV_FILE (default docker/compose/postarix.env), BACKUP_AGE_RECIPIENTS.
set -euo pipefail

target="$(realpath -m "${1:?usage: backup.sh <directory>}")"
recipients="${BACKUP_AGE_RECIPIENTS:-}"
[ -z "$recipients" ] || recipients="$(realpath "$recipients")"
cd "$(dirname "$0")/../.."
# COMPOSE_FILE may list several files separated by ":" (Docker Compose reads it).
export COMPOSE_FILE="${COMPOSE_FILE:-docker/compose/postarix.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE:-docker/compose/postarix.env}")
log() { printf '[backup] %s\n' "$*"; }

if [ -n "$recipients" ]; then
  command -v age >/dev/null || { echo "BACKUP_AGE_RECIPIENTS is set but age is not installed" >&2; exit 1; }
  [ -s "$recipients" ] || { echo "$recipients is missing or empty" >&2; exit 1; }
fi

mkdir -p "$target"
chmod 700 "$target"
umask 077

# Writes standard input to <name> in the backup, encrypted when asked.
save() {
  if [ -n "$recipients" ]; then
    age -R "$recipients" -o "$target/$1.age"
  else
    cat >"$target/$1"
  fi
}

log "database"
"${COMPOSE[@]}" exec -T postgres pg_dump -U postarix -d postarix -Fc | save database.dump

# The Cyrus services that hold mail: the Murder's backends, or the single Cyrus.
mapfile -t backends < <("${COMPOSE[@]}" config --services | grep -E '^cyrus-backend-' | sort || true)
if [ "${#backends[@]}" -gt 0 ]; then
  stores=("${backends[@]}")
else
  stores=(cyrus)
fi

for service in "${stores[@]}"; do
  suffix=""
  [ "$service" = cyrus ] || suffix="-$service"
  log "mailbox list ($service)"
  "${COMPOSE[@]}" exec -T -u cyrus "$service" /usr/lib/cyrus/bin/ctl_mboxlist -d | save "mailboxes$suffix.txt"

  log "mail store of $service (this can take a while)"
  # Messages are files that are written once, so copying a live store is safe;
  # the mailbox list dumped above is the consistent index to restore from, and
  # the restore rebuilds every mailbox's index from the message files. A
  # checkpoint first flushes Cyrus' databases to their files.
  "${COMPOSE[@]}" exec -T -u cyrus "$service" /usr/lib/cyrus/bin/ctl_cyrusdb -c >/dev/null
  "${COMPOSE[@]}" exec -T "$service" tar -C / --exclude=var/lib/cyrus/socket -czf - var/spool/cyrus var/spool/sieve var/lib/cyrus \
    | save "cyrus$suffix.tar.gz"
done

log "spam filter data"
valkey_file=valkey.rdb
[ -z "$recipients" ] || valkey_file=valkey.rdb.age
if "${COMPOSE[@]}" exec -T valkey sh -c 'valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning SAVE >/dev/null && cat /data/dump.rdb' 2>/dev/null | save valkey.rdb \
  && [ -s "$target/$valkey_file" ]; then
  :
else
  log "could not copy Valkey's data (skipped; it is optional)"
  rm -f "$target/$valkey_file"
fi

{
  echo "created: $(date -u +%FT%TZ)"
  echo "api: $("${COMPOSE[@]}" images api --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | head -1)"
  echo "stores: ${stores[*]}"
  [ -z "$recipients" ] || echo "encrypted: age"
  (cd "$target" && find . -maxdepth 1 -type f ! -name MANIFEST -printf '%f\n' | sort | xargs sha256sum)
} >"$target/MANIFEST"
chmod 600 "$target"/*
log "done: $target"
