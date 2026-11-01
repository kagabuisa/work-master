# Work Master monitoring and alert ownership

Updated: 1 November 2026.

## Ownership

| Area | Primary owner | Escalation |
| --- | --- | --- |
| Application, accounting and stock | Kagabu Isa (`@kagabuisa`) | Repository owner until another operator is assigned |
| PostgreSQL, host capacity and backup | Kagabu Isa (`@kagabuisa`) | Repository owner until another operator is assigned |
| Integration credentials and security | Kagabu Isa (`@kagabuisa`) | Repository owner until another operator is assigned |

GitHub issues assigned to `@kagabuisa` are the alert record. GitHub notifications
must remain enabled for that account. Add a second responder before relying on
this as a 24-hour service.

## External availability monitor

`.github/workflows/production-monitor.yml` runs at least every 15 minutes and
checks the public `/healthz` and `/readyz` endpoints plus HTTPS certificate
expiry. A failed check opens one GitHub issue assigned to the configured owner;
recovery closes the issue.

Set repository variable `PRODUCTION_HEALTH_URL` to the deployed origin. The
workflow defaults to `https://wmaster.zenjji.com`. Set repository variable
`MONITORING_OWNER` only when ownership moves away from `kagabuisa`.

GitHub scheduled workflows can be delayed and are not a replacement for an
internal monitoring system. Monitor the monitor through GitHub workflow
notifications.

## Health and metrics access

- `/healthz` is a public liveness response containing only `{"status":"ok"}`.
- `/readyz` is public and returns only ready/not-ready state. It performs a
  database query when initialized.
- `/metrics` is Prometheus text format. Requests through the public proxy
  require `Authorization: Bearer <monitoring token>` or `X-Monitoring-Token`.
  Direct loopback requests are allowed for local collection.

The monitoring token is generated into `.runtime/monitoring_token` and mounted
as `/run/secrets/monitoring_token`. Never commit or print it. Rotate it by
replacing the file, recreating the app and updating external collectors.

## Metrics

The endpoint exposes:

- Application up/readiness and Node process memory.
- Bounded request counts and duration totals by route group.
- PostgreSQL pool total, idle and waiting counts.
- Browsing, report and connection admission state.
- Versioned API request counts and cumulative latency buckets by bounded route,
  method, status class and financial outcome.

Metric labels never include actor IDs, session IDs, resource IDs, query values,
cookies, request bodies or tokens.

## Alert rules

| Alert | Condition | First response |
| --- | --- | --- |
| Application unavailable | `/readyz` non-2xx for two checks | Check `invoice-app`, Docker health, logs, PostgreSQL health and recent deployment |
| Database unavailable | `work_master_ready` is 0 for 2 minutes | Check PostgreSQL, disk space, connections and migrations |
| HTTP 5xx increase | More than 1% 5xx over 5 minutes with at least 20 requests | Inspect bounded route groups and redacted request errors |
| Pool saturation | Pool waiting exceeds 2 for 5 minutes | Check long reports, locks and pool metrics |
| Report queue saturation | Admissions queued or rejected increases for 10 minutes | Reduce report load and investigate heavy queries |
| Financial write failure | API 5xx or failed financial mutation | Correlate request ID and durable audit; reconcile before retry |
| Backup age | Latest verified backup older than the agreed RPO | Stop relying on the current backup and run verified recovery |
| Disk capacity | Less than 20% free or projected exhaustion within 7 days | Expand storage or remove only approved disposable data |
| Certificate expiry | Fewer than 14 days remaining | Verify Certbot renewal and reload Nginx |

Alert thresholds should be reviewed against the production baseline. Financial
integrity failures require investigation even when traffic volume is low.
