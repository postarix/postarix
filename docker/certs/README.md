# Certificates

The `certs` service keeps `/certs/fullchain.pem` and `/certs/privkey.pem` current
in a shared volume. Postfix and Cyrus check them every minute and reload when they
change, so renewals need no restart.

| `CERTS_MODE` | What it does |
|---|---|
| `selfsigned` (default) | Generates a self-signed certificate. Development only. |
| `acme` | Obtains and renews a Let's Encrypt certificate with [lego](https://go-acme.github.io/lego/). |
| `external` | Copies a certificate produced elsewhere (e.g. by Traefik via traefik-certs-dumper). |

Until a real certificate exists (ACME issuance pending, external files missing), a
temporary self-signed one is served so the mail services can start; it is replaced
as soon as the real one arrives.

## ACME

```env
CERTS_MODE=acme
ACME_EMAIL=admin@example.com
# Optional: more names on the same certificate (the first one names the files).
ACME_DOMAINS=mail.example.com,autoconfig.example.com
```

**HTTP-01** (`ACME_CHALLENGE=http`, default): Let's Encrypt must reach
`http://<name>/.well-known/acme-challenge/` on the certs container's port 80.
Either route that path from your reverse proxy to `certs:80` (see
`deploy/proxies`), or, without a proxy, publish port 80 of the certs service.

**DNS-01** (`ACME_CHALLENGE=dns`): set `ACME_DNS_PROVIDER` to a
[lego provider](https://go-acme.github.io/lego/dns/) and put its credentials in a
file referenced by `ACME_DNS_ENV_FILE`, for example:

```env
ACME_CHALLENGE=dns
ACME_DNS_PROVIDER=cloudflare
ACME_DNS_ENV_FILE=./cloudflare.env   # contains CLOUDFLARE_DNS_API_TOKEN=...
```

Use `ACME_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory` while testing.

## External

```env
CERTS_MODE=external
CERTS_EXTERNAL_PATH=/path/to/directory/with/the/files
CERTS_EXTERNAL_CERT=fullchain.pem
CERTS_EXTERNAL_KEY=privkey.pem
```

The directory is mounted read-only and checked every five minutes.
