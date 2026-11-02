# Install with Dokploy

[Dokploy](https://dokploy.com) is a self-hosted platform that deploys Docker
Compose apps behind its own Traefik. Postarix runs on it as a **Compose**
service: Dokploy's Traefik serves the web (webmail, admin, API, calendars),
and the mail ports go straight to Postfix and Cyrus, as they must.

::: info Read this first
- **Mail needs its own ports.** Postarix publishes 25, 465, 587, 143, 993,
  995 and 4190 on the server. Nothing else on that server may use them.
- **Same requirements as any mail server:** outbound port 25 open, reverse DNS
  (PTR) set to your mail hostname, a clean IP. See
  [Install on Ubuntu, step 1](./install-ubuntu#_1-choose-a-server).
- Plan for at least **6 GB of memory** (Dokploy itself uses about 1 GB).
:::

The examples use `mail.example.com` for the mail server's name and
`0.0.1-beta.1` for the [release](https://github.com/postarix/postarix/releases).

## 1. DNS

| Name | Type | Value |
|---|---|---|
| `mail.example.com` | A (and AAAA) | the Dokploy server's IP |
| `mail.example.com` | TXT | `v=spf1 a -all` |

Set the reverse DNS (PTR) of the server's IP to `mail.example.com` at your
hosting provider.

## 2. Open the mail ports

Dokploy opens 80, 443 and its own panel's port. Also open the mail ports in
your provider's firewall and on the server, for example with ufw:

```bash
ufw allow 25,465,587,143,993,995,4190/tcp
```

## 3. Generate the configuration

Postarix needs a set of random secrets. Generate them on the Dokploy server
(over SSH), in a temporary copy of the project:

```bash
git clone --depth 1 --branch v0.0.1-beta.1 https://github.com/postarix/postarix /tmp/postarix
/tmp/postarix/deploy/scripts/generate-env.sh mail.example.com you@example.com 0.0.1-beta.1
cat /tmp/postarix/docker/compose/postarix.env
```

Copy the output: you will paste it into Dokploy in step 5. Keep a copy in a
password manager too; it is not part of the backups. Then remove the
temporary copy:

```bash
rm -rf /tmp/postarix
```

Find the address range of Dokploy's network (the API must trust Traefik's
`X-Forwarded-For` header from it):

```bash
docker network inspect dokploy-network --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
# e.g. 10.0.1.0/24
```

## 4. Certificates for the mail ports

Dokploy's Traefik gets the HTTPS certificate for the web. Postfix and Cyrus
need one too, and Traefik keeps the HTTP challenge for itself, so Postarix
gets its own through a **DNS challenge**. With Cloudflare, for example,
create an API token with *Zone → DNS → Edit* on your zone, and store it on the
server:

```bash
mkdir -p /etc/postarix
printf 'CLOUDFLARE_DNS_API_TOKEN=%s\n' 'your-token' > /etc/postarix/acme-dns.env
chmod 600 /etc/postarix/acme-dns.env
```

Any [lego DNS provider](https://go-acme.github.io/lego/dns/) works (OVH,
Route 53, Hetzner, DigitalOcean, Gandi…): set its variables in that file and
its name in `ACME_DNS_PROVIDER` below.

::: details No DNS API? Use Traefik's certificate instead
Dump the certificate Dokploy's Traefik obtained (it is in
`/etc/dokploy/traefik/dynamic/acme.json`) with
[traefik-certs-dumper](https://github.com/ldez/traefik-certs-dumper) into a
directory, and set `CERTS_MODE=external` with `CERTS_EXTERNAL_PATH` pointing
at the directory for `mail.example.com` (see the
[configuration reference](./configuration#certificates-for-the-mail-ports)).
For Traefik to request it in the first place, add `mail.example.com` as a
domain of the `webmail` service in Dokploy (step 6).
:::

## 5. Create the service in Dokploy

1. **Create a project** (e.g. *Mail*), then **Create Service → Compose**.
2. **General → Provider:** *Git* (or *GitHub*), repository
   `https://github.com/postarix/postarix`, branch `main` — or, better, the
   release tag `v0.0.1-beta.1` if your Dokploy version lets you pick tags.
   **Compose path:** `docker/compose/postarix.yml`. Compose type: *Docker
   Compose* (not Stack).
3. **Environment:** paste the configuration from step 3, then change or add
   these lines:

   ```dotenv
   # Dokploy's Traefik
   TRAEFIK_NETWORK=dokploy-network
   TRAEFIK_ENTRYPOINT=websecure
   TRAEFIK_HTTP_ENTRYPOINT=web
   TRAEFIK_CERTRESOLVER=letsencrypt
   TRUSTED_PROXIES=10.0.1.0/24          # the range from step 3

   # Certificates for the mail ports (step 4)
   CERTS_MODE=acme
   ACME_CHALLENGE=dns
   ACME_DNS_PROVIDER=cloudflare
   ACME_DNS_ENV_FILE=/etc/postarix/acme-dns.env
   ```

4. **Advanced → Command:** replace the default command so Dokploy uses the
   published images (no build) and adds Postarix' Traefik labels. Keep the
   project name Dokploy shows in its default command (here `<app-name>`):

   ```
   compose -p <app-name> -f docker/compose/postarix.yml -f deploy/proxies/traefik/compose.traefik.yml up -d --remove-orphans
   ```

5. Leave **Isolated deployment** off: Postarix creates its own internal
   networks, and only its web services join `dokploy-network`.
6. **Deploy.** The first deployment downloads the images and takes a few
   minutes. In **Logs**, every container should end up running; `api`,
   `cyrus` and `postfix` report *healthy* after a minute or two.

## 6. Domains

Postarix' Traefik labels already route `https://mail.example.com` (webmail at
`/`, admin at `/admin`, API, calendars and contacts) with Dokploy's
Let's Encrypt resolver, and redirect plain HTTP to HTTPS. **Do not add
`mail.example.com` in Dokploy's Domains tab**: that would create a second,
conflicting route.

Later, when you host mail domains, their `autoconfig.<domain>` and
`mta-sts.<domain>` names (which mail apps and other servers look up) need
HTTPS too. Add each one in Dokploy's **Domains** tab: service `api`, port
`3000`, path `/`, HTTPS with Let's Encrypt.

## 7. Create your administrator account

Over SSH on the server:

```bash
docker exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase' \
  "$(docker ps -q --filter label=com.docker.compose.project=<app-name> --filter label=com.docker.compose.service=api)" \
  node dist/cli/create-admin.js
```

Open `https://mail.example.com/admin`, sign in, set up two-step sign-in, and
continue with [First steps](./first-steps).

## 8. Backups

Dokploy's volume backups copy named volumes while the services run; for a
consistent mail store, use Postarix' backup script instead. Over SSH, from the
folder Dokploy deploys into (usually `/etc/dokploy/compose/<app-name>/code`):

```bash
cd /etc/dokploy/compose/<app-name>/code
COMPOSE_PROJECT_NAME=<app-name> ENV_FILE=docker/compose/.env \
COMPOSE_FILE=docker/compose/postarix.yml:deploy/proxies/traefik/compose.traefik.yml \
BACKUP_AGE_RECIPIENTS=/etc/postarix/backup-recipients.txt \
  deploy/scripts/backup.sh /srv/backups/postarix-$(date +%F)
```

Schedule it with cron as in [Install on Ubuntu, step 9](./install-ubuntu#_9-backups),
and read [Backups and restore](./backup).

## Updating

Change `POSTARIX_VERSION` in **Environment** (and the branch or tag, if you
deploy one), then **Deploy**. Read the release notes first, and take a backup.
When a release adds secrets, generate them as in step 3 with the new release
(compare the files) or run `deploy/scripts/derive-secrets.sh` on a copy of
your environment. See [Updating](./updating).

## Troubleshooting on Dokploy

- **The web works but mail apps warn about the certificate:** the certs
  service has not obtained its certificate yet. Check its logs in Dokploy
  (`certs` container) for DNS-challenge errors (token permissions, provider
  name).
- **Sign-ins are throttled for everyone / the audit log shows Traefik's
  address:** `TRUSTED_PROXIES` does not match `dokploy-network`'s range.
- **Port 25 is already in use:** another app on the server publishes it.
- More in [Troubleshooting](./troubleshooting).
