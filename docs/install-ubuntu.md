# Install on Ubuntu

This guide takes a fresh **Ubuntu Server 24.04 or 26.04 LTS** (or **Debian
12 or 13**) to a working mail server in about 30 minutes. Every command is meant to be copied as is;
replace the example values:

| Example | Replace with |
|---|---|
| `mail.example.com` | the name of your mail server (it does not have to be your mail domain) |
| `example.com` | your mail domain (addresses will be `you@example.com`) |
| `you@example.com` | an address where you read mail now (Let's Encrypt notices) |
| `203.0.113.10` | the server's public IPv4 address |
| `0.0.1-beta.5` | the [latest release](https://github.com/postarix/postarix/releases) |

::: tip Not on Ubuntu?
Any Linux with Docker Engine 27+ works: follow the same steps with your
distribution's way of installing Docker, or read the
[production guide](./install).
:::

## 1. Choose a server

| Mailboxes | CPU | Memory | Disk |
|---|---|---|---|
| up to ~200 | 2 vCPU | 4 GB (6 GB with antivirus) | 40 GB + the mail you expect |
| up to ~2,000 | 4 vCPU | 8 GB | as needed (SSD) |

Before you pay for it, check with the provider:

- **Outbound port 25 must be open.** Without it you can receive mail but not
  deliver it. Many clouds block it by default: AWS, Google Cloud, Azure and
  Hetzner (new accounts) lift the block on request; **DigitalOcean blocks
  25, 465 and 587 on every Droplet** and rarely lifts it. Where it stays
  blocked, send through a relay on port 2525 (see [Port 25 is
  blocked](./troubleshooting#port-25-is-blocked)).
- **You can set the reverse DNS (PTR)** of the IPv4 address (and IPv6, if
  any) in their panel.
- The IP address is not on blocklists: check it at
  [MXToolbox](https://mxtoolbox.com/blacklists.aspx).

## 2. DNS for the server

At your DNS provider, create:

| Name | Type | Value |
|---|---|---|
| `mail.example.com` | A | `203.0.113.10` |
| `mail.example.com` | AAAA | the IPv6 address (only if the server has one) |
| `mail.example.com` | TXT | `v=spf1 a -all` |

In the **hosting provider's** panel, set the reverse DNS (PTR) of
`203.0.113.10` to `mail.example.com`.

The records for your mail domain itself (MX, SPF, DKIM, DMARC…) come later:
the admin panel shows them with the exact values.

## 3. Prepare Ubuntu

Connect with SSH and become root (every command below runs as root; as
another user, start with `sudo -i`):

```bash
ssh root@203.0.113.10     # or: ssh ubuntu@… then: sudo -i
```

Update the system, install the basic tools, and name the server:

```bash
apt update && apt full-upgrade -y
apt install -y ca-certificates curl git openssl ufw unattended-upgrades netcat-openbsd
hostnamectl set-hostname mail.example.com
dpkg-reconfigure -f noninteractive unattended-upgrades   # automatic security updates
```

Check that outbound port 25 is open (it should print `succeeded`):

```bash
nc -vz -w 10 gmail-smtp-in.l.google.com 25
```

If it times out, your provider blocks port 25: ask them to lift it, or plan
to send through a relay ([Port 25 is blocked](./troubleshooting#port-25-is-blocked)).
Receiving works either way.

## 4. Install Docker

From Docker's own repository (the distribution's `docker.io` package is often
too old). This works on Ubuntu and Debian alike:

```bash
. /etc/os-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker version && docker compose version
```

::: details "apt update" fails with a 404 for docker.com?
Docker publishes packages for a new release of Ubuntu or Debian a little
after it comes out. Until then, use the previous release's packages (`noble`
for Ubuntu, `bookworm` for Debian), then run the last two commands again:

```bash
sed -i "s/^Suites: .*/Suites: $([ "$ID" = ubuntu ] && echo noble || echo bookworm)/" /etc/apt/sources.list.d/docker.sources
```

Docker's own script does all of the above in one step too:
`curl -fsSL https://get.docker.com | sh`.
:::

## 5. Open the firewall

```bash
ufw allow OpenSSH
ufw allow 80,443/tcp          # web (HTTPS certificates, webmail, admin)
ufw allow 443/udp             # HTTP/3
ufw allow 25,465,587/tcp      # SMTP: receiving, and sending from mail apps
ufw allow 143,993,995/tcp     # IMAP and POP3
ufw allow 4190/tcp            # Sieve filters from mail apps
ufw enable
```

::: warning Docker and ufw
Ports published by Docker containers bypass ufw's rules. That is fine for
these ports (they must be open anyway), but do not rely on ufw to hide a port
you publish yourself later. Postarix publishes nothing else.
:::

## 6. Get Postarix

```bash
git clone --depth 1 --branch v0.0.1-beta.5 https://github.com/postarix/postarix /opt/postarix
cd /opt/postarix
```

Create the configuration, with fresh random secrets, for your server name,
your e-mail and the release you cloned:

```bash
deploy/scripts/generate-env.sh mail.example.com you@example.com 0.0.1-beta.5
```

This writes `docker/compose/postarix.env`, readable by root only. **Copy it
somewhere safe now** (a password manager): it holds every secret, and it is
not part of the backups. The [configuration reference](./configuration)
explains each setting.

## 7. Start it

```bash
cd /opt/postarix/docker/compose
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env pull
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env up -d --wait
```

The first start takes a few minutes. `caddy.yml` adds the bundled reverse
proxy (Caddy), which obtains the HTTPS certificate; the mail services get
their own Let's Encrypt certificate for `mail.example.com` too.

Optional extras, added to both commands:

- `--profile clamav` for virus scanning (about 1.5 GB more memory); also set
  `CLAMAV_SERVERS=clamav:3310` in `postarix.env`. See [Antivirus](./antivirus).
- `--profile crowdsec` to block attackers by IP. See [CrowdSec](./crowdsec).

To avoid typing the long command every time, add an alias:

```bash
echo "alias postarix='docker compose --project-directory /opt/postarix/docker/compose -f /opt/postarix/docker/compose/postarix.yml -f /opt/postarix/docker/compose/caddy.yml --env-file /opt/postarix/docker/compose/postarix.env'" >> ~/.bashrc
source ~/.bashrc
postarix ps        # every service should be "healthy"
```

## 8. Create your administrator account

```bash
postarix exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase' \
  api node dist/cli/create-admin.js
```

Open `https://mail.example.com/admin` and sign in. Set up two-step sign-in for
this account right away (Account → two-factor authentication, or a passkey).

Continue with [First steps](./first-steps): your organization, your domain's
DNS records and your first mailboxes.

## 9. Backups

Schedule a nightly backup, encrypted so that only you can read it. On **your
own computer** (not the server), create a key pair with
[age](https://age-encryption.org) and keep the private key safe:

```bash
age-keygen -o postarix-backup.key                    # on your computer
age-keygen -y postarix-backup.key                    # prints the public key: age1…
```

On the server:

```bash
apt install -y age
mkdir -p /etc/postarix /srv/backups
echo 'age1…your public key…' > /etc/postarix/backup-recipients.txt
crontab -e
```

and add:

```
30 2 * * * cd /opt/postarix && BACKUP_AGE_RECIPIENTS=/etc/postarix/backup-recipients.txt COMPOSE_FILE=docker/compose/postarix.yml:docker/compose/caddy.yml deploy/scripts/backup.sh /srv/backups/postarix-$(date +\%F) >>/var/log/postarix-backup.log 2>&1
```

Copy `/srv/backups` off the server (restic, rclone, rsync…) and delete old
copies from time to time. Restoring is explained in
[Backups and restore](./backup).

## 10. Check everything

- `postarix ps`: every service is `healthy`.
- Send a message from the webmail to a Gmail address and reply to it; in Gmail,
  "Show original" must say **PASS** for SPF, DKIM and DMARC.
- Send one to [mail-tester.com](https://www.mail-tester.com) and aim for 10/10.
- Test your domain at [internet.nl](https://internet.nl/test-mail/).

Something wrong? See [Troubleshooting](./troubleshooting). Updating later:
[Updating](./updating).
