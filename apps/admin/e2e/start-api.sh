#!/bin/sh
# Starts the built API for the end-to-end tests: memory mail engine, domains
# activated without DNS, and a fresh super-admin.
set -eu
cd "$(dirname "$0")/../../api"
node dist/db/migrate.js
node dist/cli/create-admin.js 2>/dev/null || echo "super-admin already exists"
exec node dist/main.js
