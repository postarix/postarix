#!/usr/bin/env bash
# Adds the per-purpose internal secrets to postarix.env, derived from its
# INTERNAL_API_TOKEN (the same values the API derives), so that each mail
# container gets only the secrets it needs instead of the token itself.
# Safe to run again: secrets already in the file are kept.
#   deploy/scripts/derive-secrets.sh [docker/compose/postarix.env]
set -euo pipefail

file="${1:-$(dirname "$0")/../../docker/compose/postarix.env}"
token=$(sed -n 's/^INTERNAL_API_TOKEN=//p' "$file" | tail -n 1)
if [ "${#token}" -lt 32 ]; then
  echo "INTERNAL_API_TOKEN is missing or shorter than 32 characters in $file" >&2
  exit 1
fi
derive() { printf 'postarix:%s' "$1" | openssl dgst -sha256 -hmac "$token" -r | cut -d' ' -f1; }

added=0
for purpose in mail-auth submission cyrus-smtp murder-mupdate murder-proxy murder-xfer; do
  name="POSTARIX_SECRET_$(echo "$purpose" | tr 'a-z-' 'A-Z_')"
  if grep -q "^$name=." "$file"; then continue; fi
  sed -i "/^$name=/d" "$file"
  echo "$name=$(derive "$purpose")" >> "$file"
  added=$((added + 1))
done
echo "Internal secrets: $added added to $file."
