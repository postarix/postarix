# Configuration reference

A Docker Compose installation is configured in `docker/compose/postarix.env`
(on Dokploy: the service's **Environment**). `deploy/scripts/generate-env.sh`
writes it with fresh secrets; change it with any editor and apply changes
with `docker compose … up -d`.

## Essentials

| Variable | Default | Meaning |
|---|---|---|
| `POSTARIX_VERSION` | — | The release to run, e.g. `0.0.1-beta.1` (the image tag). |
| `POSTARIX_REGISTRY` | `ghcr.io/postarix` | Where the images come from (a mirror, or your own builds). |
| `MAIL_HOSTNAME` | — | Public name of the mail server: MX target, certificate name, web address. |
| `AUTH_URL` | — | Public HTTPS URL of the web interface, normally `https://<MAIL_HOSTNAME>`. |
| `TRUSTED_PROXIES` | empty | Reverse proxies allowed to set `X-Forwarded-For` (IPs or CIDRs). The bundled Caddy: `172.30.54.0/24`. Wrong or empty behind a proxy, every visitor seems to come from the proxy (shared rate limits, useless audit addresses); the API logs a warning. |
| `TRUSTED_ORIGINS` | empty | Extra browser origins of the admin panel and webmail, if you serve them on other names. |
| `SYSTEM_MAIL_FROM` | `no-reply@<MAIL_HOSTNAME>` | Sender of the server's own notices. |
| `LOG_FORMAT` | `text` | `json` for one JSON object per log line. |

## Secrets

All required; `generate-env.sh` creates them. Never reuse them between
installations, and keep a copy of the file off the server: **`AUTH_SECRET`
decrypts the DKIM keys stored in the database**.

| Variable | Used by |
|---|---|
| `POSTGRES_PASSWORD` | the API's database account |
| `POSTFIX_DB_PASSWORD` | Postfix' read-only database account |
| `AUTH_SECRET` | sessions, and encryption of DKIM keys and SSO secrets |
| `CYRUS_ADMIN_PASSWORD` | the API's administration of the mail store |
| `INTERNAL_API_TOKEN` | the source the per-purpose secrets below are derived from |
| `POSTARIX_SECRET_MAIL_AUTH`, `…_SUBMISSION`, `…_CYRUS_SMTP`, `…_MURDER_MUPDATE`, `…_MURDER_PROXY`, `…_MURDER_XFER`, `…_REPORTS` | one secret per internal purpose, so each container gets only its own. `deploy/scripts/derive-secrets.sh` adds missing ones. Without `…_REPORTS`, the admin panel shows no mail logs or queue. |
| `RSPAMD_CONTROLLER_PASSWORD` | the API's read-only access to Rspamd (filtering history, metrics) |
| `RSPAMD_CONTROLLER_ENABLE_PASSWORD` | optional: write access to Rspamd's web interface; unset, it is read-only |
| `VALKEY_PASSWORD` | Valkey (DKIM keys for Rspamd, spam statistics) |

## Certificates for the mail ports

Postfix and Cyrus need a certificate for `MAIL_HOSTNAME`, kept current by the
`certs` service (the web certificate is your reverse proxy's business).

| Variable | Default | Meaning |
|---|---|---|
| `CERTS_MODE` | `selfsigned` | `acme` (Let's Encrypt), `external` (files you provide) or `selfsigned` (testing only). |
| `ACME_EMAIL` | — | Contact for Let's Encrypt. |
| `ACME_CHALLENGE` | `http` | `http` (the proxy routes `/.well-known/acme-challenge/` to `certs:80`; the bundled Caddy does) or `dns`. |
| `ACME_DNS_PROVIDER` | — | With `dns`: a [lego provider](https://go-acme.github.io/lego/dns/) name, e.g. `cloudflare`. |
| `ACME_DNS_ENV_FILE` | — | With `dns`: a file with the provider's credentials (e.g. `CLOUDFLARE_DNS_API_TOKEN=…`). |
| `ACME_DOMAINS` | `MAIL_HOSTNAME` | More names on the same certificate, comma-separated. |
| `ACME_SERVER` | Let's Encrypt | Use the staging URL while testing. |
| `CERTS_EXTERNAL_PATH`, `CERTS_EXTERNAL_CERT`, `CERTS_EXTERNAL_KEY` | —, `fullchain.pem`, `privkey.pem` | With `external`: the directory and file names. |

## Mail

| Variable | Default | Meaning |
|---|---|---|
| `MESSAGE_SIZE_LIMIT` | `52428800` (50 MB) | Largest message accepted or sent, in bytes. |
| `RSPAMD_GREYLIST` | `true` | Greylisting of unknown senders (delays their first message a few minutes). |
| `QUARANTINE_MAX_BYTES` | `10485760` (10 MB) | Refused spam up to this size is kept in quarantine for its recipients; `0` turns quarantine off. |
| `QUARANTINE_RETENTION_DAYS` | `30` | Days quarantined mail is kept. |
| `CLAMAV_SERVERS` | empty | `clamav:3310` with `--profile clamav` to scan for viruses ([Antivirus](./antivirus)). |
| `MAIL_IMPORT_ALLOWED_HOSTS` | empty | IMAP servers on a private network people may import mail from ([Migration](./migration)). |
| `SSO_TRUSTED_ISSUERS` | empty | Identity providers on a private network organizations may use for single sign-on. |
| `SMTP_PORT`, `SUBMISSIONS_PORT`, `SUBMISSION_PORT` | 25, 465, 587 | Host ports Postfix publishes. |
| `IMAP_PORT`, `IMAPS_PORT`, `POP3S_PORT`, `SIEVE_PORT` | 143, 993, 995, 4190 | Host ports Cyrus publishes. |

## Networks

| Variable | Default | Meaning |
|---|---|---|
| `POSTARIX_SUBNET` | `172.30.53.0/24` | The internal network. Change it if it overlaps one of yours. |
| `POSTARIX_IP_RANGE` | `172.30.53.128/25` | Addresses handed out automatically within it. |
| `CYRUS_IP`, `UNBOUND_IP` | `172.30.53.10`, `172.30.53.53` | Fixed addresses inside `POSTARIX_SUBNET`. |
| `POSTARIX_PROXY_SUBNET` | `172.30.54.0/24` | The network the reverse proxy shares with the web services. |

## Reverse proxy (Traefik template)

With `deploy/proxies/traefik/compose.traefik.yml` (an existing Traefik,
Dokploy, Coolify…):

| Variable | Default | Meaning |
|---|---|---|
| `TRAEFIK_NETWORK` | `traefik` | The Docker network Traefik watches (`dokploy-network` on Dokploy). |
| `TRAEFIK_ENTRYPOINT` | `websecure` | The HTTPS entrypoint. |
| `TRAEFIK_HTTP_ENTRYPOINT` | `web` | The HTTP entrypoint (redirected to HTTPS). |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | The ACME resolver for the web certificate. |

## Other optional services

| Variable | Default | Meaning |
|---|---|---|
| `CROWDSEC_BOUNCER_KEY`, `CROWDSEC_LAPI_PORT` | —, `8081` | [CrowdSec](./crowdsec) with `--profile crowdsec`. |
| `PROMETHEUS_RETENTION` | `30d` | With `monitoring.yml` ([Monitoring](./monitoring)). |

## Kubernetes

The Helm chart is configured through its values; every option is documented
in [`values.yaml`](../deploy/helm/postarix/values.yaml).
