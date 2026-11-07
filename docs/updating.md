# Updating

Postarix releases are listed on
[GitHub](https://github.com/postarix/postarix/releases). **Read the release
notes before updating**: they say when a release needs more than the steps
below. Database migrations run by themselves when the API starts.

## Docker Compose (Ubuntu or any Linux)

```bash
cd /opt/postarix
# 1. Back up first
BACKUP_AGE_RECIPIENTS=/etc/postarix/backup-recipients.txt \
  deploy/scripts/backup.sh /srv/backups/postarix-before-update

# 2. Get the new release (here 1.0.0), keeping your postarix.env
git fetch --depth 1 origin tag v1.0.0
git checkout v1.0.0
sed -i 's/^POSTARIX_VERSION=.*/POSTARIX_VERSION=1.0.0/' docker/compose/postarix.env

# 3. Add any secret the new release needs (changes nothing else)
deploy/scripts/derive-secrets.sh docker/compose/postarix.env

# 4. Restart on the new images
cd docker/compose
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env pull
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env up -d --wait
```

Add the same `--profile` options and proxy file you started with.

## Dokploy

Take a backup, set the new `POSTARIX_VERSION` (and the tag, if you deploy one)
in the service's **Environment**, then **Deploy**. See
[Install with Dokploy](./install-dokploy#updating).

## Kubernetes

```bash
helm upgrade postarix oci://ghcr.io/postarix/charts/postarix --version 1.0.0 -n postarix -f my-values.yaml
```

The chart keeps the secrets it generated; new ones are created on upgrade.

## From a 0.0.1 beta

Update as above; the database migrations run by themselves. Then:

- `cyrus` and `postfix` are recreated (they no longer take the mail host name
  as their container host name), so mail apps reconnect once.
- A connected application's token for a person whose mailbox is disabled, or
  became shared, now answers `401` (before: `404`).
- An API key used beyond its limits now answers `403` with a `code` (before:
  `401`); see the [API reference](./api).

## Going back

A release's database migrations are not undone automatically. To go back,
restore the backup taken before the update ([Backups and
restore](./backup)) and start the previous version again.

## Checking the images

Release images are signed. To check that an image was built by this project's
release workflow:

```bash
cosign verify ghcr.io/postarix/api:1.0.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/postarix/postarix/\.github/workflows/release\.yml@refs/tags/v'
```
