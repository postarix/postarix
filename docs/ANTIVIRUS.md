# Virus scanning (ClamAV)

Postarix can have Rspamd ask [ClamAV](https://www.clamav.net) about every
message, incoming and outgoing. A message with a virus is refused during the
SMTP conversation, so the sender learns at once that it was not delivered.

ClamAV is optional because it needs about **1.5 GB of memory** for its
signatures.

## Docker Compose

Add to `postarix.env`:

```bash
CLAMAV_SERVERS=clamav:3310
```

and start the stack with the `clamav` profile:

```bash
docker compose -f docker/compose/postarix.yml --env-file docker/compose/postarix.env --profile clamav up -d
```

The first start downloads the signatures (a few hundred MB, from
`database.clamav.net`); `freshclam` then keeps them current. Until ClamAV is
ready, or whenever it cannot be reached, mail is delivered unscanned rather
than held up (Rspamd logs `CLAM_VIRUS_FAIL`).

## Kubernetes

```yaml
clamav:
  enabled: true
```

The pod needs outbound HTTPS to `database.clamav.net`.

## Check it works

Send yourself the [EICAR test file](https://www.eicar.org/download-anti-malware-testfile/)
as an attachment: the server refuses it with "virus found".
