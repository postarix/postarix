# Monitoring Postarix

Postarix exposes Prometheus metrics, ships alert rules, and writes its logs to
standard output so any log collector can pick them up.

## Metrics

The API serves metrics on its own port, **9464**, never on its public port:
the reverse proxy and the Kubernetes ingress do not route it.

| Path | Content |
| --- | --- |
| `/metrics` | The API's own metrics (below) and the Node.js process (`postarix_api_*`: CPU, memory, event loop lag, garbage collection). |
| `/metrics/rspamd` | Rspamd's metrics (messages scanned, actions taken, Bayes, fuzzy), relayed by the API with its read-only controller password so Prometheus needs no Rspamd credentials. Answers 502 when Rspamd is down. |

| Metric | Labels | What it tells you |
| --- | --- | --- |
| `postarix_http_requests_total` | `method`, `route`, `status` | API traffic and errors. `route` is the route pattern (`/api/orgs/:orgId/mailboxes`), never a raw path. |
| `postarix_http_request_duration_seconds` | `method`, `route` | API latency (histogram). The webmail's JMAP routes (`/api/jmap/*`) include long-lived event streams. |
| `postarix_mail_logins_total` | `service`, `result` | Mail-app logins (IMAP, POP3, SMTP, ManageSieve, CalDAV/CardDAV) checked by the API: `success` or `failure`. A sustained failure rate is password guessing. |
| `postarix_web_sign_ins_total` | `result` | Password sign-ins to the admin panel and webmail: `success`, `failure`, or `blocked` (the account is locked for 15 minutes after 10 failures). |

## Docker Compose

`docker/compose/monitoring.yml` adds a Prometheus with the scrape configuration
and alert rules from `deploy/monitoring/`:

```bash
cd /opt/postarix/docker/compose
sudo docker compose -f postarix.yml -f caddy.yml -f monitoring.yml --env-file postarix.env up -d
```

Prometheus listens on `127.0.0.1:9090` only. Reach it through an SSH tunnel
(`ssh -L 9090:127.0.0.1:9090 your-server`) or put your own authenticated proxy
in front of it. Data is kept for 30 days (`PROMETHEUS_RETENTION` in
`postarix.env` changes that).

To receive alerts, uncomment the `alerting` section of
`deploy/monitoring/prometheus.yml` and point it at your Alertmanager.

If you already run Prometheus elsewhere, scrape `api:9464` (`/metrics` and
`/metrics/rspamd`) from a container on Postarix' internal network, and load
`deploy/monitoring/alerts.yml`.

## Kubernetes

The chart enables metrics by default (`metrics.enabled`):

- API pods carry `prometheus.io/scrape`, `prometheus.io/port` and
  `prometheus.io/path` annotations (`metrics.podAnnotations`).
- With the Prometheus Operator, set `metrics.serviceMonitor.enabled=true`
  (scrapes both paths) and `metrics.prometheusRule.enabled=true` (installs the
  alert rules). Add `labels` to either if your Prometheus selects by label.
- The network policy lets any pod in the cluster reach port 9464; the ingress
  never routes it.

## Alerts

`deploy/monitoring/alerts.yml`:

| Alert | When |
| --- | --- |
| `PostarixApiDown` | The API cannot be scraped for 5 minutes. |
| `PostarixSpamFilterDown` | Rspamd does not answer for 5 minutes (Postfix defers mail meanwhile). |
| `PostarixApiErrors` | More than 5% of API requests fail with a 5xx for 10 minutes. |
| `PostarixApiSlow` | The 95th percentile of API requests (JMAP excluded) is above 2 s for 15 minutes. |
| `PostarixMailLoginFailures` | More than one failed mail-app login a second for 10 minutes. |
| `PostarixWebSignInFailures` | Many failed or blocked web sign-ins. |
| `PostarixApiMemory` | The API uses more than 1.5 GB for 30 minutes. |

Container health is reported by Docker (`docker compose ps`) and by
Kubernetes probes; PostgreSQL, Valkey, Postfix and Cyrus have no exporter of
their own here. Add the community exporters (postgres_exporter,
redis_exporter, a Postfix exporter reading the `mail-logs` volume) if you need
their internals.

## Logs

Every container logs to standard output: `docker compose logs -f api`,
`kubectl logs`. Postfix and Cyrus also write to the `mail-logs` volume, which
CrowdSec reads to ban addresses that guess passwords.

The API writes one JSON object per line with `LOG_FORMAT=json` (Compose:
`postarix.env`; Helm: `api.logFormat`), ready for Loki, Elasticsearch or any
collector that parses JSON:

```json
{"level":"log","pid":1,"timestamp":1767225600000,"message":"Listening on port 3000, metrics on 9464","context":"Bootstrap"}
```

Useful places to look:

- **A message did not arrive:** the admin panel's filtering history (Rspamd's
  verdict per message), then `docker compose logs postfix | grep <address>`.
- **Mail is stuck:** `docker compose exec postfix postqueue -p` lists the queue,
  `postqueue -f` retries it.
- **Banned addresses:** `docker compose exec crowdsec cscli decisions list`.
- **Administrative changes:** the audit log in the admin panel (every
  organization) records who did what and when.
