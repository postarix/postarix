# Try it on your computer (Windows, macOS, Linux)

To look around before renting a server — the admin panel, the webmail,
calendars, contacts — run Postarix on your own computer. It cannot send or
receive mail from the Internet this way (no domain, no port 25): for real
mail, [install it on a server](./install-ubuntu).

## Windows 10 and 11

1. **Install WSL with Ubuntu.** In PowerShell as administrator:

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

   Restart, open **Ubuntu** from the Start menu and create your user.

2. **Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)**.
   In its **Settings → Resources → WSL integration**, turn on the integration
   with your Ubuntu, then **Apply & restart**, and open Ubuntu again.
   `docker version` must work in Ubuntu.

   If Ubuntu is not listed, `wsl -l -v` in PowerShell must show VERSION **2**
   (`wsl --set-version Ubuntu-24.04 2` converts it).

3. Continue with **All systems** below, in the Ubuntu window.

::: warning Keep the files inside Ubuntu
Clone into your Ubuntu home (`~`), not into `C:\` or `/mnt/c/…`: Git on
Windows changes line endings, and the scripts stop working.
:::

## macOS

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and
use a Linux shell to generate the configuration (the script uses GNU `sed`):
the simplest is to run step 2 below inside a container,
`docker run --rm -it -v "$PWD":/w -w /w debian:trixie bash -c 'apt-get update -qq && apt-get install -y -qq openssl >/dev/null && bash'`.

## All systems

**1. Get Postarix**

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/postarix/postarix ~/postarix
cd ~/postarix
```

**2. Create the configuration** with the name `mail.localhost` (browsers send
every `*.localhost` name to your own computer):

```bash
deploy/scripts/generate-env.sh mail.localhost you@example.com 1.0.0
```

Then edit `docker/compose/postarix.env` for a local trial: change or add

```dotenv
CERTS_MODE=selfsigned
NODE_ENV=development
DOMAIN_VERIFICATION=skip
AUTH_URL=http://mail.localhost
TRUSTED_ORIGINS=https://mail.localhost
```

- `selfsigned`: Let's Encrypt cannot issue certificates for `localhost`.
- `DOMAIN_VERIFICATION=skip` activates test domains without DNS. It is only
  allowed in development mode, which is why `NODE_ENV` and `AUTH_URL` change
  too. **Never use these settings on a real server.**

**3. Start it**

```bash
cd ~/postarix/docker/compose
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env up -d --wait
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env ps
```

The first start downloads the images and takes a few minutes.

**4. Create your administrator account**

```bash
docker compose -f postarix.yml -f caddy.yml --env-file postarix.env exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long passphrase' \
  api node dist/cli/create-admin.js
```

**5. Look around**

- Open **https://mail.localhost/admin** and accept the certificate warning
  (the certificate is self-signed). Create an organization, add a domain such
  as `test.local` (it activates at once), and create two or three mailboxes —
  one of type *Room* to try booking.
- Open **https://mail.localhost** and sign in as one of the mailboxes: send
  mail to the other one, plan an event and invite a colleague and the room,
  add contacts, set an automatic reply.

Stop it with `docker compose -f postarix.yml -f caddy.yml --env-file postarix.env stop`,
and start it again with `… up -d`. To remove everything, data included:
`… down -v`.
