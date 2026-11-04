# Troubleshooting

The commands below assume a Docker Compose install in `/opt/postarix` and the
`postarix` alias from [Install on Ubuntu](./install-ubuntu#_7-start-it)
(`docker compose -f postarix.yml -f caddy.yml --env-file postarix.env`, run in
`docker/compose`).

## First look

```bash
postarix ps                       # every service should be "healthy"
postarix logs --tail 100 api      # or postfix, cyrus, rspamd, certs, caddy…
postarix logs -f postfix | grep you@example.com
```

The admin panel's **Mail log** shows what the spam filter decided for each
message of the organization.

## A service is not healthy

| Service | Usual cause |
|---|---|
| `api` restarting | A missing or too short secret in `postarix.env` (the log names it), or PostgreSQL not ready yet (it retries). After an update: run `deploy/scripts/derive-secrets.sh docker/compose/postarix.env`. |
| `certs` | Let's Encrypt cannot reach `http://mail.example.com/.well-known/acme-challenge/`: DNS not pointing at the server yet, port 80 closed, or another proxy in front. Meanwhile a temporary self-signed certificate is used. |
| `postfix`, `cyrus` | Waiting for the certificate or the database; read their logs. |
| `clamav` | Downloading signatures (first start: several minutes) or out of memory. |

## The web works, mail apps complain about the certificate

The mail ports use the certificate the `certs` service obtains, not the web
one. Check `postarix logs certs`. With a proxy other than the bundled Caddy,
route `/.well-known/acme-challenge/` to `certs:80` or use the DNS challenge
([configuration](./configuration#certificates-for-the-mail-ports)).

## Receiving works, sending to other servers does not

```bash
postarix exec postfix postqueue -p         # what is waiting, and why
nc -vz -w 10 gmail-smtp-in.l.google.com 25  # from the host: is port 25 open?
```

- `Connection timed out` to every server: your provider blocks outbound
  port 25; see below.
- Refused by Gmail/Outlook with a policy message: check the reverse DNS (PTR)
  of your IP, the SPF/DKIM/DMARC records in the admin panel (all green), and
  blocklists ([MXToolbox](https://mxtoolbox.com/blacklists.aspx)).

Retry the queue once fixed: `postarix exec postfix postqueue -f` (or
**Server → Mail queue → Retry** in the admin panel). Messages wait in the
queue and are retried for 5 days, so nothing is lost meanwhile.

## Port 25 is blocked

Check from the host:

```bash
nc -vz -w 10 gmail-smtp-in.l.google.com 25
```

A timeout means the provider drops outgoing connections to port 25. Ask them
to lift the block (AWS, Google Cloud, Azure and Hetzner do on request). Where
they will not (DigitalOcean blocks 25, 465 and 587 on every Droplet), send
through a relay that accepts port **2525**: Brevo, SendGrid and Mailgun do.

1. Create an account with the relay, add your domain there and publish the
   records it gives (its DKIM key; usually an `include:` in your SPF record,
   e.g. `v=spf1 mx include:spf.brevo.com -all`).
2. Check that the port is open: `nc -vz -w 10 smtp-relay.brevo.com 2525`.
3. In the admin panel, **Server → Outgoing routing → Smart hosts**: add
   `[smtp-relay.brevo.com]:2525` with the relay's SMTP login.
4. Choose it in the settings of each domain (or of a single mailbox).
5. **Server → Mail queue → Retry** sends what was waiting.

## The webmail says "Could not send the message"

The API hands the message to Postfix over its internal submission port, and
checks Postfix' certificate first. Read the reason with
`postarix logs api | grep "Submission failed"`:

- `ESOCKET` with a Let's Encrypt certificate on releases before
  0.0.1-beta.5: the API did not trust public certificate authorities there.
  Update.
- `ESOCKET` or a certificate error otherwise: the `certs` service has no
  valid certificate for `MAIL_HOSTNAME` yet (`postarix logs certs`).
- `ECONNREFUSED`: Postfix is not running (`postarix ps`).

## Mail goes to the spam folder at Gmail or Outlook

Send a message to [mail-tester.com](https://www.mail-tester.com): it lists
what is wrong. Usual causes are a missing PTR record, DKIM not yet published,
or a new IP without reputation (it improves as you send normal mail; Outlook
also offers its [sender support](https://sender.office.com)).

## Nothing arrives

- The domain's **MX** record points at `mail.example.com` and the domain is
  **verified** and active in the admin panel.
- `postarix logs postfix | grep <recipient>` shows whether the message reached
  the server, and why it was refused.
- Greylisting delays the first message from an unknown server by a few
  minutes; that is normal.

## Cannot sign in

- **Too many attempts:** after 10 failed passwords an account is locked for
  15 minutes; from one address, sign-ins are also rate-limited.
- **Everyone is rate-limited at once:** `TRUSTED_PROXIES` does not match your
  reverse proxy, so all visitors share its address. The API log warns about
  it.
- **Mail app refuses the password:** with two-step sign-in or a passkey, mail
  apps need an **app password**.
- **Lost administrator password:** create another administrator with
  `postarix exec … api node dist/cli/create-admin.js` (see the install guide).

## Disk full

```bash
df -h; docker system df
```

Mail lives in Docker volumes under `/var/lib/docker/volumes`. Old images can
go: `docker image prune -a` (keeps the ones in use). Set quotas per mailbox
in the admin panel.

## Still stuck?

Search or open an issue on [GitHub](https://github.com/postarix/postarix/issues),
with the output of `postarix ps` and the relevant logs (remove addresses and
secrets first). Security problems: follow the
[security policy](https://github.com/postarix/postarix/blob/main/SECURITY.md)
instead.
