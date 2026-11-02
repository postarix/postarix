#!/usr/bin/env bash
# Builds and starts the full stack, runs the integration tests against it, and
# tears it down. Extra environment (e.g. BASE_IMAGE) is passed to compose.
#   tests/integration/run.sh            # build, test, tear down
#   KEEP_STACK=1 tests/integration/run.sh   # leave the stack running afterwards
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE="${ENV_FILE:-docker/compose/test.env}"
COMPOSE=(docker compose -f docker/compose/postarix.yml -f docker/compose/test.yml --env-file "$ENV_FILE")
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
