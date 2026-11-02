# Reverse proxy templates

Only **HTTP** goes through your reverse proxy. Mail ports (25, 465, 587, 143,
993, 995, 4190) are published directly by the Postfix and Cyrus containers so
they see real client IPs.

## Routes

| Path | Upstream | Notes |
|---|---|---|
| `/api/internal/*` | — | **Never proxied.** Return 404. Used only inside the Docker network. |
| `/api/*` | `api:3000` | Postarix API (auth, admin operations). |
| `/.well-known/caldav`, `/.well-known/carddav` | `cyrus:8080` | DAV discovery for calendar/contact clients. |
| `/dav/*` | `cyrus:8080` | CalDAV / CardDAV. |
| `/admin`, `/admin/*` | `admin:3001` | Admin panel. |
| `/.well-known/acme-challenge/*` | `certs:80` | Only with `CERTS_MODE=acme` and `ACME_CHALLENGE=http`. |
| `/` (everything else) | `webmail:3002` | Webmail. |

Route `/api` to the API from the proxy itself, as these templates do. The admin
server can also forward `/api` (handy in development), but it passes on any
`X-Forwarded-For` it receives, so never expose the admin server directly.

The proxy must pass the client address in `X-Forwarded-For`. Tell the API which
proxies to trust with `TRUSTED_PROXIES` (their IP or the Docker network's CIDR),
otherwise it ignores the header and every request seems to come from the proxy.

## Templates

| Proxy | File | How to use |
|---|---|---|
| Caddy | [`caddy/Caddyfile`](caddy/Caddyfile) | Run Caddy on the `postarix_proxy` network; it obtains its own HTTPS certificate. |
| nginx | [`nginx/postarix.conf`](nginx/postarix.conf) | Include in `http {}`; adjust the certificate paths. |
| Traefik | [`traefik/compose.traefik.yml`](traefik/compose.traefik.yml) | Extra compose file with labels for an existing Traefik. |
| HAProxy | [`haproxy/haproxy.cfg`](haproxy/haproxy.cfg) | Standalone config; adjust the certificate path. |

### Certificates for Postfix and Cyrus when Traefik owns them

If Traefik already obtains the certificate for your mail hostname, export it with
[traefik-certs-dumper](https://github.com/ldez/traefik-certs-dumper) into a
directory and run the certs service in external mode:

```env
CERTS_MODE=external
CERTS_EXTERNAL_PATH=/path/to/dumped/certs/mail.example.com
CERTS_EXTERNAL_CERT=certificate.crt
CERTS_EXTERNAL_KEY=privatekey.key
```
