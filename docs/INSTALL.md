# Installing Postarix in production

This guide takes a fresh server to a working mail service with Docker
Compose, on any Linux. Step-by-step versions: [Install on
Ubuntu](install-ubuntu.md) and [Install with Dokploy](install-dokploy.md). For
Kubernetes, see the end of this page.

## 1. Before you start

**A server** with a public IPv4 address (IPv6 too, if you have it):

| Mailboxes | CPU | Memory | Disk |
|---|---|---|---|
| up to ~200 | 2 vCPU | 4 GB (6 GB with antivirus) | 40 GB + the mail you expect |
| up to ~2,000 | 4 vCPU | 8 GB | as needed (SSD) |
| more | see [`SCALING.md`](SCALING.md) | | |

Any Linux with Docker Engine 27+ and the Compose plugin works. amd64 and
arm64 images are published.

**Check with your hosting provider:**

- **Outbound port 25 is open.** Many cloud providers block it by default; ask
  them to lift the block, or you cannot deliver mail to other servers.
- **Reverse DNS (PTR)** of the server's IP points to your mail hostname
  (e.g. `mail.example.com`). Set it in the provider's panel. Without it, Gmail
  and Outlook reject or junk your mail.
- The IP is not on blocklists: check it at
  [MXToolbox](https://mxtoolbox.com/blacklists.aspx) before you start.

**Ports to open in the firewall:** 25 (SMTP), 465 and 587 (sending from mail
apps), 143 and 993 (IMAP), 995 (POP3), 4190 (Sieve filters), 80 and 443 (web).

## 2. DNS for the server

| Name | Type | Value |
|---|---|---|
| `mail.example.com` | A (and AAAA) | the server's IP |
| `mail.example.com` | TXT | `v=spf1 a -all` |
| the server's IP | PTR (at your provider) | `mail.example.com` |

Each mail domain you host gets its own records later (MX, SPF, DKIM, DMARC,
MTA-STS, autoconfig): the admin panel lists them with the exact values.

## 3. Install

```bash
# The release's files (Compose files, scripts, proxy templates)
sudo git clone --depth 1 --branch v<version> https://github.com/postarix/postarix /opt/postarix
cd /opt/postarix

# Configuration with fresh random secrets
sudo deploy/scripts/generate-env.sh mail.example.com you@example.com <version>
```

Keep a copy of `docker/compose/postarix.env` somewhere safe (a password
manager): it holds the secrets, and it is **not** in the backups.

Start everything, with the bundled reverse proxy (Caddy, which obtains the
HTTPS certificates):

```bash
cd docker/compose
sudo docker compose -f postarix.yml -f caddy.yml --env-file postarix.env up -d --wait
```

Add `--profile clamav` for virus scanning (about 1.5 GB more memory) and
`--profile crowdsec` to block attackers by IP (see [`CROWDSEC.md`](CROWDSEC.md)).
Already running a proxy (Traefik, nginx, HAProxy…)? Leave out `caddy.yml` and
use a template from [`deploy/proxies`](../deploy/proxies).

Create the first account, the instance administrator:

```bash
sudo docker compose -f postarix.yml --env-file postarix.env exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase' \
  api node dist/cli/create-admin.js
```

## 4. First steps

1. Open `https://mail.example.com/admin` and sign in. Set up two-step sign-in
   for your account right away (Account → two-factor authentication, or a passkey).
2. Create an organization, add your domain and publish the verification
   record; press **Verify**.
3. Publish the records the panel lists for the domain: MX, SPF, DKIM, DMARC,
   MTA-STS and autoconfig.
4. Create mailboxes. People sign in to the webmail at `https://mail.example.com`.
5. Coming from another provider? Follow [`MIGRATION.md`](MIGRATION.md).

## 5. Check that mail flows

- Send a message from the webmail to a Gmail and an Outlook address, and
  answer back. Look at the received message's headers: SPF, DKIM and DMARC
  must say `pass`.
- Send a message to [mail-tester.com](https://www.mail-tester.com) and aim
  for 10/10.
- Check TLS and MTA-STS at
  [internet.nl](https://internet.nl/test-mail/).

## 6. Backups

Schedule the backup script and copy the result off the server:

```
30 2 * * * cd /opt/postarix && deploy/scripts/backup.sh /srv/backups/postarix-$(date +\%F) >>/var/log/postarix-backup.log 2>&1
```

Details, encryption and restoring: [`BACKUP.md`](BACKUP.md). Try a restore on
a spare machine before you depend on it.

## 7. Updating

Read the release notes first: they say when an update needs anything more than
this.

```bash
cd /opt/postarix
deploy/scripts/backup.sh /srv/backups/postarix-before-<new version>
git fetch --depth 1 origin tag v<new version> && git checkout v<new version>
sudo sed -i 's/^POSTARIX_VERSION=.*/POSTARIX_VERSION=<new version>/' docker/compose/postarix.env
cd docker/compose
sudo docker compose -f postarix.yml -f caddy.yml --env-file postarix.env pull
sudo docker compose -f postarix.yml -f caddy.yml --env-file postarix.env up -d --wait
```

Releases may add secrets to `postarix.env`; `deploy/scripts/derive-secrets.sh
docker/compose/postarix.env` adds any that are missing (it changes nothing
else) and is safe to run on every update, before `up`.

The API applies database migrations when it starts. To go back, restore the
backup taken before the update and set the old version again.

## 8. Keep an eye on it

- `docker compose ps` shows each service's health.
- Metrics for Prometheus and logs: [`MONITORING.md`](MONITORING.md).
- The admin panel's **Mail log** shows delivery and filtering per organization.

## 9. Security checklist

- [ ] `postarix.env` is readable by root only (the script sets this) and backed up separately.
- [ ] Two-step sign-in on every administrator account; consider requiring it for
      whole organizations (Admin → Sign-in).
- [ ] Only the ports listed in section 1 are open.
- [ ] Backups are copied off the server, and a restore was tested.
- [ ] Unattended OS security updates on the host.
- [ ] Image signatures checked, if you want to be sure the images are the ones
      this project built:

```bash
cosign verify ghcr.io/postarix/api:<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/postarix/postarix/\.github/workflows/release\.yml@refs/tags/v'
```

Report vulnerabilities as described in [`SECURITY.md`](../SECURITY.md).

## Kubernetes

The Helm chart is published with each release:

```bash
helm install postarix oci://ghcr.io/postarix/charts/postarix --version <version> \
  -n postarix --create-namespace -f my-values.yaml
```

Start from [`deploy/helm/postarix/values.yaml`](../deploy/helm/postarix/values.yaml):
set `mailHostname`, `publicUrl`, the TLS secret for the mail hostname
(`tls.secretName`, or `tls.certManager`), and how the mail ports reach the
Internet (`mail.service`; they must keep the client IP). Mail ports never go
through the ingress.
