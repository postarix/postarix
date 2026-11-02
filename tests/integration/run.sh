#!/usr/bin/env bash
# Builds and starts the full stack, runs the integration tests against it, and
# tears it down. Extra environment (e.g. BASE_IMAGE) is passed to compose.
#   tests/integration/run.sh            # build, test, tear down
#   KEEP_STACK=1 tests/integration/run.sh   # leave the stack running afterwards
#   MURDER=1 tests/integration/run.sh       # with a Cyrus Murder (two backends)
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE="${ENV_FILE:-docker/compose/test.env}"
COMPOSE_FILES=(-f docker/compose/postarix.yml -f docker/compose/test.yml)
if [ -n "${MURDER:-}" ]; then
  COMPOSE_FILES+=(-f docker/compose/murder.yml)
  # The backup scripts handle a single Cyrus.
  SKIP_BACKUP_TEST=1
fi
COMPOSE=(docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE")
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@postarix.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-integration admin password}"
export ADMIN_EMAIL ADMIN_PASSWORD

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::Container logs"
    "${COMPOSE[@]}" ps -a || true
    "${COMPOSE[@]}" logs --no-color --tail 200 || true
    echo "::endgroup::"
  fi
  if [ -z "${KEEP_STACK:-}" ]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT

BUILD_FLAG=--build
[ -n "${SKIP_BUILD:-}" ] && BUILD_FLAG=--no-build
"${COMPOSE[@]}" up -d "$BUILD_FLAG" --wait --wait-timeout 300

"${COMPOSE[@]}" exec -T -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_NAME=Admin api node dist/cli/create-admin.js \
  || echo "admin already exists"

pnpm --filter @postarix/integration-tests test:integration

# Backup and restore round trip: the stack the tests filled is backed up,
# destroyed and restored, and must come back with the same accounts and mail.
if [ -z "${SKIP_BACKUP_TEST:-}" ]; then
  export COMPOSE_FILE=docker/compose/postarix.yml:docker/compose/test.yml ENV_FILE
  counts() {
    "${COMPOSE[@]}" exec -T postgres psql -U postarix -d postarix -tAc 'select count(*) from mailboxes'
    "${COMPOSE[@]}" exec -T -u cyrus cyrus sh -c \
      'find /var/spool/cyrus -name "[0-9]*." | wc -l; /usr/lib/cyrus/bin/ctl_mboxlist -d | grep -c "\"name\""'
  }
  before=$(counts)
  backup_dir=$(mktemp -d)
  deploy/scripts/backup.sh "$backup_dir/backup"
  "${COMPOSE[@]}" down -v >/dev/null 2>&1
  "${COMPOSE[@]}" up -d --no-build --wait postgres valkey
  YES=1 deploy/scripts/restore.sh "$backup_dir/backup"
  after=$(counts)
  rm -rf "$backup_dir"
  echo "before restore: $(echo $before)  after: $(echo $after)  (mailboxes in the database, messages, Cyrus mailboxes)"
  [ "$before" = "$after" ] || { echo "the restored installation differs from the backed-up one" >&2; exit 1; }
fi
