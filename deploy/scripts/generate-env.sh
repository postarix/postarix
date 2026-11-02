#!/usr/bin/env bash
# Writes docker/compose/postarix.env for a new installation, with fresh random
# secrets. It never overwrites an existing file.
#   deploy/scripts/generate-env.sh mail.example.com admin@example.com [version]
set -euo pipefail

hostname="${1:?usage: generate-env.sh <mail hostname> <ACME e-mail> [version]}"
acme_email="${2:?usage: generate-env.sh <mail hostname> <ACME e-mail> [version]}"
version="${3:-}"
cd "$(dirname "$0")/../.."
target=docker/compose/postarix.env
if [ -e "$target" ]; then
  echo "$target already exists; not touching it." >&2
  exit 1
fi
if ! [[ "$hostname" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "Not a host name: $hostname" >&2
  exit 1
fi
secret() { openssl rand -base64 48 | tr -d '/+=\n' | head -c 48; }

umask 077
sed -e "s|^MAIL_HOSTNAME=.*|MAIL_HOSTNAME=$hostname|" \
    -e "s|^AUTH_URL=.*|AUTH_URL=https://$hostname|" \
    -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$acme_email|" \
    -e "s|^POSTARIX_VERSION=.*|POSTARIX_VERSION=$version|" \
    -e "s|^TRUSTED_PROXIES=.*|TRUSTED_PROXIES=172.30.54.0/24|" \
    docker/compose/postarix.env.example > "$target"
for name in POSTGRES_PASSWORD POSTFIX_DB_PASSWORD AUTH_SECRET CYRUS_ADMIN_PASSWORD INTERNAL_API_TOKEN RSPAMD_CONTROLLER_PASSWORD VALKEY_PASSWORD; do
  sed -i "s|^$name=.*|$name=$(secret)|" "$target"
done
deploy/scripts/derive-secrets.sh "$target" >/dev/null
echo "Wrote $target (readable by you only). Keep a copy somewhere safe: it is not in the backups."
