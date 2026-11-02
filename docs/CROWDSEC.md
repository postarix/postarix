# Blocking attackers with CrowdSec

Mail servers attract password guessing (SMTP AUTH, IMAP, POP3) and spam abuse
from all over the Internet. Postarix already limits failed logins per account;
[CrowdSec](https://www.crowdsec.net) adds blocking by **address**, at the host
firewall, before connections reach the containers.

It comes in two parts:

| Part | Where | What it does |
|---|---|---|
| CrowdSec engine | the optional `crowdsec` container | Reads the Postfix and Cyrus logs (shared `mail-logs` volume), detects password guessing and abuse, and decides which addresses to ban. |
| Firewall bouncer | **the host** (a system package) | Asks the engine for its decisions and drops traffic from banned addresses with nftables or iptables. |

The bouncer runs on the host on purpose: containers never get to change the
host's firewall, and no container has access to the Docker socket.

## 1. Start the engine

Pick a key for the bouncer and add it to `postarix.env`:

```bash
echo "CROWDSEC_BOUNCER_KEY=$(openssl rand -hex 32)" >> docker/compose/postarix.env
docker compose -f docker/compose/postarix.yml --env-file docker/compose/postarix.env --profile crowdsec up -d
```

What it watches:

- **Postfix:** failed SASL logins on 465/587 and abusive clients (the
  `crowdsecurity/postfix` collection).
- **Cyrus:** failed IMAP, POP3 and ManageSieve logins (Postarix' own parser and
  scenario: more than 5 failures from one address within a short time).

Private, loopback and link-local addresses (your LAN, the Docker networks, the
reverse proxy) are never banned: the image ships its own whitelist
(`postarix/whitelist`), so a misbehaving app on the LAN cannot lock everyone out.
Check it is loaded with `cscli parsers list`.

The engine's local API listens on `127.0.0.1:8081` of the host only
(`CROWDSEC_LAPI_PORT`).

## 2. Install the firewall bouncer on the host

On Debian or Ubuntu:

```bash
sudo apt install crowdsec-firewall-bouncer   # or crowdsec-firewall-bouncer-nftables
```

Then edit `/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml`:

```yaml
api_url: http://127.0.0.1:8081/
api_key: <the CROWDSEC_BOUNCER_KEY value>
mode: nftables          # or iptables
# Published container ports are forwarded, so filter the forwarding path too.
iptables_chains: [INPUT, DOCKER-USER]
nftables:
  ipv4:
    enabled: true
    set-only: false
    table: crowdsec
    chain: crowdsec-chain
    priority: -10        # before Docker's own rules
```

```bash
sudo systemctl restart crowdsec-firewall-bouncer
```

## 3. Check it works

```bash
# Decisions currently in force
docker compose … exec crowdsec cscli decisions list
# Ban an address by hand (for one hour), then remove the ban
docker compose … exec crowdsec cscli decisions add --ip 203.0.113.7 --duration 1h
docker compose … exec crowdsec cscli decisions delete --ip 203.0.113.7
# What the engine sees
docker compose … exec crowdsec cscli metrics
```

## Notes

- Client addresses must reach the containers unchanged. With Docker's default
  networking (iptables NAT) they do; if you run a TCP proxy in front of the mail
  ports, use the PROXY protocol or run CrowdSec where the real addresses are.
- On Kubernetes, run CrowdSec on the nodes that receive the mail traffic (the
  official CrowdSec Helm chart), reading the mail pod's logs.
