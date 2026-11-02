# Helm chart

Kubernetes deployment of Postarix: `deploy/helm/postarix`.

```bash
helm install postarix deploy/helm/postarix -n mail --create-namespace \
  --set mailHostname=mail.example.com,publicUrl=https://mail.example.com \
  --set tls.certManager.enabled=true \
  -f my-secrets.yaml   # the secrets listed in values.yaml
```

What it runs:

| Workload | Notes |
|---|---|
| `api`, `admin`, `webmail` | Stateless; scale with `replicas`. Migrations run on start, serialized by a database lock. |
| `mail` (StatefulSet) | Cyrus and Postfix in one pod (they share Unix sockets). One replica; mail ports are exposed by a `LoadBalancer` service, never through the ingress. |
| `rspamd`, `unbound` | Spam filter and its DNSSEC-validating resolver. |
| `postgres`, `valkey` | Built-in single instances; disable them and point `postgresql.host` / `valkey.host` at managed services for production. |

Differences from the Docker Compose install:

- TLS for the mail services comes from a `kubernetes.io/tls` secret
  (`tls.secretName`), e.g. issued by cert-manager (`tls.certManager.enabled`).
- DANE for outgoing mail works as with Compose: the mail pod resolves through
  an Unbound container of its own (DNSSEC-validating) that forwards the
  cluster's names to the cluster DNS (`mail.dane`). It needs outbound DNS to the
  Internet; private zones (e.g. a managed database's) go in `mail.dane.forwardZones`.
- Network policies keep the mail pod's internal ports (admin IMAP, JMAP and
  webmail submission) reachable from the API only. Your CNI must enforce them.
- CrowdSec is not included: run it on the nodes that receive mail traffic.
- The autoconfig/MTA-STS hosts of each hosted domain (`autoconfig.<domain>`,
  `mta-sts.<domain>`) are routed when the domain is listed in
  `ingress.discoveryDomains`; the ingress certificate must cover those names.
- The ingress routes only the API's public paths: `/api/internal/*` is never
  exposed.

Backups: see [`docs/BACKUP.md`](../../docs/BACKUP.md).
