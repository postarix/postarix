#!/usr/bin/env bash
# Restores a backup made by backup.sh into a Docker Compose installation.
# Use the same postarix.env (AUTH_SECRET, passwords) as the backed-up server,
# and the same Compose files: a Murder backup restores into the same backends
# (same service names).
#
# The stack must be created but may be empty (e.g. a new server):
#   docker compose … up -d postgres valkey   # the rest is started by this script
#   deploy/scripts/restore.sh /srv/backups/postarix-2026-11-02
#
# An encrypted backup (*.age) needs the private key: BACKUP_AGE_IDENTITY=<key file>.
#
# It REPLACES the database and the mail store of the target installation.
set -euo pipefail

source_dir="$(realpath -m "${1:?usage: restore.sh <backup directory>}")"
identity="${BACKUP_AGE_IDENTITY:-}"
[ -z "$identity" ] || identity="$(realpath "$identity")"
cd "$(dirname "$0")/../.."
# COMPOSE_FILE may list several files separated by ":" (Docker Compose reads it).
export COMPOSE_FILE="${COMPOSE_FILE:-docker/compose/postarix.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE:-docker/compose/postarix.env}")
log() { printf '[restore] %s\n' "$*"; }

encrypted=""
if [ -e "$source_dir/database.dump.age" ]; then
  encrypted=1
  command -v age >/dev/null || { echo "this backup is encrypted: install age" >&2; exit 1; }
  [ -s "$identity" ] || { echo "this backup is encrypted: set BACKUP_AGE_IDENTITY to the private key file" >&2; exit 1; }
fi
present() { [ -s "$source_dir/$1${encrypted:+.age}" ]; }
# Writes a backup file to standard output, decrypting it when needed.
load() {
  if [ -n "$encrypted" ]; then age -d -i "$identity" "$source_dir/$1.age"; else cat "$source_dir/$1"; fi
}

# The Cyrus services that hold mail, as in backup.sh.
mapfile -t backends < <("${COMPOSE[@]}" config --services | grep -E '^cyrus-backend-' | sort || true)
if [ "${#backends[@]}" -gt 0 ]; then stores=("${backends[@]}"); else stores=(cyrus); fi
store_file() { if [ "$1" = cyrus ]; then echo cyrus.tar.gz; else echo "cyrus-$1.tar.gz"; fi; }

present database.dump || { echo "missing database.dump in $source_dir" >&2; exit 1; }
for service in "${stores[@]}"; do
  present "$(store_file "$service")" || { echo "missing $(store_file "$service") in $source_dir (was the backup made with the same Compose files?)" >&2; exit 1; }
done
(cd "$source_dir" && sha256sum --check --quiet <(grep -E '^[0-9a-f]{64} ' MANIFEST)) || { echo "checksums do not match" >&2; exit 1; }
# Fail now, not halfway through, if the key is wrong.
[ -z "$encrypted" ] || load database.dump >/dev/null || { echo "cannot decrypt the backup with $identity" >&2; exit 1; }

if [ -z "${YES:-}" ]; then
  read -r -p "This replaces the database and all mail of this installation. Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || exit 1
fi

log "stopping the services that write mail and data"
"${COMPOSE[@]}" stop api postfix cyrus "${backends[@]}" admin webmail >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait postgres valkey

log "database"
load database.dump | "${COMPOSE[@]}" exec -T postgres pg_restore -U postarix -d postarix --clean --if-exists --no-owner

for service in "${stores[@]}"; do
  log "mail store of $service"
  # Cyrus is stopped: unpack into its volumes through a one-off container.
  load "$(store_file "$service")" | "${COMPOSE[@]}" run --rm -T --no-deps --entrypoint sh "$service" -c '
    set -e
    rm -rf /var/spool/cyrus/* /var/spool/sieve/* /var/lib/cyrus/*
    tar -C / -xzf -
    chown -R cyrus:mail /var/spool/cyrus /var/spool/sieve /var/lib/cyrus
  '
done
# The mailbox lists come back with Cyrus' databases (checkpointed by the
# backup); mailboxes*.txt are readable copies for manual recovery. Murder
# backends push their lists to the mupdate server when they start.

if present valkey.rdb; then
  log "spam filter data"
  "${COMPOSE[@]}" stop valkey >/dev/null
  # Valkey loads the snapshot when no append-only log is present.
  load valkey.rdb | "${COMPOSE[@]}" run --rm -T --no-deps --entrypoint sh valkey -c 'rm -rf /data/appendonlydir && cat >/data/dump.rdb'
fi

log "starting everything"
"${COMPOSE[@]}" up -d --wait
for service in "${stores[@]}"; do
  log "rebuilding the indexes of $service"
  "${COMPOSE[@]}" exec -T -u cyrus "$service" /usr/lib/cyrus/bin/reconstruct -r -G "*" >/dev/null || log "reconstruct reported problems on $service; check its logs"
done
log "done"
