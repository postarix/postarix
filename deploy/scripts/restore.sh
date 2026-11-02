#!/usr/bin/env bash
# Restores a backup made by backup.sh into a Docker Compose installation.
# Use the same postarix.env (AUTH_SECRET, passwords) as the backed-up server.
#
# The stack must be created but may be empty (e.g. a new server):
#   docker compose … up -d postgres valkey   # the rest is started by this script
#   deploy/scripts/restore.sh /srv/backups/postarix-2026-11-02
#
# It REPLACES the database and the mail store of the target installation.
set -euo pipefail

source_dir="$(realpath -m "${1:?usage: restore.sh <backup directory>}")"
cd "$(dirname "$0")/../.."
# COMPOSE_FILE may list several files separated by ":" (Docker Compose reads it).
export COMPOSE_FILE="${COMPOSE_FILE:-docker/compose/postarix.yml}"
COMPOSE=(docker compose --env-file "${ENV_FILE:-docker/compose/postarix.env}")
log() { printf '[restore] %s\n' "$*"; }

for file in database.dump mailboxes.txt cyrus.tar.gz; do
  [ -s "$source_dir/$file" ] || { echo "missing $source_dir/$file" >&2; exit 1; }
done
(cd "$source_dir" && sha256sum --check --quiet <(grep -E '^[0-9a-f]{64} ' MANIFEST)) || { echo "checksums do not match" >&2; exit 1; }

if [ -z "${YES:-}" ]; then
  read -r -p "This replaces the database and all mail of this installation. Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || exit 1
fi

log "stopping the services that write mail and data"
"${COMPOSE[@]}" stop api postfix cyrus admin webmail >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait postgres valkey

log "database"
"${COMPOSE[@]}" exec -T postgres pg_restore -U postarix -d postarix --clean --if-exists --no-owner <"$source_dir/database.dump"

log "mail store"
# Cyrus is stopped: unpack into its volumes through a one-off container.
"${COMPOSE[@]}" run --rm -T --no-deps --entrypoint sh cyrus -c '
  set -e
  rm -rf /var/spool/cyrus/* /var/spool/sieve/* /var/lib/cyrus/*
  tar -C / -xzf -
  chown -R cyrus:mail /var/spool/cyrus /var/spool/sieve /var/lib/cyrus
' <"$source_dir/cyrus.tar.gz"
# The mailbox list comes back with Cyrus' databases (checkpointed by the
# backup); mailboxes.txt is a readable copy of it for manual recovery. Cyrus
# rebuilds each mailbox's index from the message files once it is running.

if [ -s "$source_dir/valkey.rdb" ]; then
  log "spam filter data"
  "${COMPOSE[@]}" stop valkey >/dev/null
  # Valkey loads the snapshot when no append-only log is present.
  "${COMPOSE[@]}" run --rm -T --no-deps --entrypoint sh valkey -c 'rm -rf /data/appendonlydir && cat >/data/dump.rdb' <"$source_dir/valkey.rdb"
fi

log "starting everything"
"${COMPOSE[@]}" up -d --wait
log "rebuilding Cyrus' indexes"
"${COMPOSE[@]}" exec -T -u cyrus cyrus /usr/lib/cyrus/bin/reconstruct -r -G "*" >/dev/null || log "reconstruct reported problems; check the Cyrus logs"
log "done"
