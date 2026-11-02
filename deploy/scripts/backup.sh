#!/usr/bin/env bash
# Backs up a Docker Compose installation of Postarix into one directory:
#   - database.dump   PostgreSQL (accounts, organizations, domains, DKIM keys
#                     encrypted with AUTH_SECRET, audit log…), pg_dump custom format
#   - mailboxes.txt   Cyrus' mailbox list (ctl_mboxlist -d)
#   - cyrus.tar.gz    mail, calendars, contacts, Sieve scripts and Cyrus' metadata
#   - valkey.rdb      Rspamd's learned spam data and history (optional to restore)
#   - MANIFEST        versions and checksums
#
# It does not copy postarix.env: keep a copy of it somewhere safe. Without
# AUTH_SECRET the DKIM keys in the database cannot be decrypted.
#
#   deploy/scripts/backup.sh /srv/backups/postarix-$(date +%F)
#
# Environment: COMPOSE_FILE (default docker/compose/postarix.yml),
# ENV_FILE (default docker/compose/postarix.env).
set -euo pipefail

target="$(realpath -m "${1:?usage: backup.sh <directory>}")"
cd "$(dirname "$0")/../.."
# COMPOSE_FILE may list several files separated by ":" (Docker Compose reads it).
export COMPOSE_FILE="${COMPOSE_FILE:-docker/compose/postarix.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE:-docker/compose/postarix.env}")

mkdir -p "$target"
chmod 700 "$target"
log() { printf '[backup] %s\n' "$*"; }

log "database"
"${COMPOSE[@]}" exec -T postgres pg_dump -U postarix -d postarix -Fc >"$target/database.dump"

log "mailbox list"
"${COMPOSE[@]}" exec -T -u cyrus cyrus /usr/lib/cyrus/bin/ctl_mboxlist -d >"$target/mailboxes.txt"

log "mail store (this can take a while)"
# Messages are files that are written once, so copying a live store is safe;
# the mailbox list dumped above is the consistent index to restore from, and
# the restore rebuilds every mailbox's index from the message files. A
# checkpoint first flushes Cyrus' databases to their files.
"${COMPOSE[@]}" exec -T -u cyrus cyrus /usr/lib/cyrus/bin/ctl_cyrusdb -c >/dev/null
"${COMPOSE[@]}" exec -T cyrus tar -C / --exclude=var/lib/cyrus/socket -czf - var/spool/cyrus var/spool/sieve var/lib/cyrus >"$target/cyrus.tar.gz"

log "spam filter data"
if "${COMPOSE[@]}" exec -T valkey sh -c 'valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning SAVE >/dev/null && cat /data/dump.rdb' >"$target/valkey.rdb" 2>/dev/null; then
  :
else
  log "could not copy Valkey's data (skipped; it is optional)"
  rm -f "$target/valkey.rdb"
fi

{
  echo "created: $(date -u +%FT%TZ)"
  echo "api: $("${COMPOSE[@]}" images api --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | head -1)"
  (cd "$target" && sha256sum ./*.dump ./*.txt ./*.tar.gz ./*.rdb 2>/dev/null)
} >"$target/MANIFEST"
chmod 600 "$target"/*
log "done: $target"
