#!/bin/sh
# Serves the standalone build, as the Docker image does.
set -eu
cd "$(dirname "$0")/.."
rm -rf .next/standalone/apps/admin/.next/static
cp -r .next/static .next/standalone/apps/admin/.next/static
exec node .next/standalone/apps/admin/server.js
