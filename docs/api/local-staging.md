# Isolated local API staging

Prepared: 13 October 2026. Local staging is running at **https://localhost:3443**. It uses the actual application in production mode and a trusted-by-explicit-CA HTTPS proxy. Scripted HTTPS acceptance checks pass; actual native mobile and external business-client sign-off remains pending.

## Start, check and stop

```sh
bash scripts/api-staging.sh up
bash scripts/api-staging.sh check
bash scripts/api-staging.sh status
bash scripts/api-staging.sh down
```

`up` builds a separate `work_master-api-staging-app` image, starts the dedicated database, seeds an empty staging database once and starts the app/TLS proxy with health checks. Subsequent starts retain the existing seed and data. `check` runs the scripted acceptance client against the live HTTPS proxy and writes a redacted result. `down` stops only the staging Compose project and retains its volumes and credentials. No reset command or application database migration/change is added by these tools.

Requirements: local Docker Compose, OpenSSL, `flock` and a free loopback port 3443. For first setup, `STAGING_HTTPS_PORT=3444 bash scripts/api-staging.sh up` chooses another port. Later port/configuration values are retained in the private staging environment file; restart after deliberately editing them. The helper always selects its separate Compose file/project and environment file, never the application's `.env`. A local file lock prevents overlapping setup/check/stop operations.

## Isolation and TLS

| Component | Isolation |
| --- | --- |
| Compose project | `wm-api-staging`; separate from the working app |
| Database | `work_master_api_staging`, PostgreSQL 16, its own persistent volume and random password; no published port |
| Application | Production `NODE_ENV`, trusted-proxy policy, private internal network; no published app port |
| File storage | Separate staging file volume |
| TLS proxy | Fixed private app upstream, read-only filesystem, dropped capabilities, overwritten forwarding headers; only published port is `127.0.0.1:3443` |
| Networks | App/database/tools on an internal staging network; only the proxy also joins a separate bridge for localhost port access |
| Synthetic records | New staging-only customers, warehouses, price list, employee, cost center, item, opening stock and hidden draft |

The app and database are not attached to the working app's Docker network. No ERPNext credentials or company-data copy is used. Database tools check both an explicit staging flag and the actual dedicated database name; seeding refuses a pre-existing database without its matching credential file. Routine schema-resetting regression tests still use a separate disposable `_hr_test` database, never this staging database.

The helper generates a local CA (365 days) and a 30-day server certificate for localhost, 127.0.0.1 and the internal proxy hostname. It renews the server certificate when fewer than 24 hours remain; `up` recreates the TLS proxy to load the current certificate. The CA is not installed into system/browser trust automatically. Use explicit trust:

```sh
curl --cacert data/api-staging/tls/ca.crt https://localhost:3443/login
```

For browser login, trust the public `ca.crt` in your test browser/profile before visiting the URL. Keep CA/server private keys private. The proxy receives only the leaf key/certificate and public CA certificate; it does not receive the CA private key. The acceptance runner and Node read-load tool verify the chain and hostname; no TLS verification bypass is used. This local proxy/certificate setup is not a public production-edge deployment.

Use a separate browser profile for staging. Browser cookies are scoped by hostname, not port, so the existing `wm_session` website cookie can overlap a working app also visited at localhost. The databases remain separate, but sharing a browser profile can interrupt login sessions. Native/integration API clients use bearer credentials without website cookies.

## Credentials and artifacts

Generated artifacts live in **`data/api-staging/`**, excluded from Git and Docker build context. The directory is mode 0700 and credential/key files are private to its owner. Nothing is printed into command arguments, logs or user-facing documentation.

| Artifact | Purpose |
| --- | --- |
| `staging.env` | Random staging database password, local UID/GID and chosen HTTPS port |
| `credentials.json` | Random Admin/mobile passwords, synthetic selector IDs and currently retained integration credential |
| `tls/ca.crt` | Public certificate for explicit client trust |
| `tls/ca.key`, `tls/server.key` | Private local TLS keys |
| `acceptance.json` | Redacted latest HTTPS check results, request IDs, synthetic resources and bounded read timings |

Use `staging-admin` for website/API administration and `staging-mobile` for restricted sales access; retrieve their generated passwords from the private credentials file on this machine. The restricted role allows sales creation/submission/read/receipts within Retail customers, `Staging Main`, `Staging Retail` and the selected Cash receiving account. The mobile user is assigned the staging employee/cost center. A hidden Wholesale customer/warehouse/draft and a forbidden Bank account provide negative cases. The integration account is created through the real Admin API during the first check and has explicit credential scopes in addition to the same restricted role. It cannot sign in interactively.

Each check rotates the stored integration credential, revokes replaced/narrow test credentials and retains a valid replacement securely in the credential file. It logs out its mobile/Admin API families and website session after a successful run. New mobile login is required for manual use. Inspect the private file locally; never paste tokens/passwords into reports, issue bodies or command arguments.

Preserve the staging environment/credential/CA files along with retained staging volumes. Removing them while retaining the database loses its password and matching seed identity; the helper intentionally does not reset the database to recover that mismatch. Partial initial seeding also requires review rather than an automatic schema wipe. To restart after stopping, run `up`; it retains synthetic vouchers and existing records.

## What the HTTPS check verifies

- Verified local CA/hostname, production direct-HTTP rejection, proxy metadata overwrite and API error contracts.
- Mobile login, refresh rotation, old-token rejection and logout.
- Restricted mobile and integration customer/warehouse/selector reads, hidden invoice/payment concealment and forbidden warehouse/account denial.
- Permitted item/pricing, price-list, cost-center, stock and invoicer selectors; supplier reads denied to the sales-only role. Financial checks use the current Kampala posting date so they remain valid after a clock/day boundary.
- For each account type, concurrent draft creation/submission/receipt retries return matching results; a new key with the same permanent receipt reference returns the same payment and a changed payload conflicts.
- Saved totals, receipt balance, single stock posting, balanced payment GL, creator/audit/request attribution and existing website data-reader reconciliation.
- Real HTTPS website login with Secure/HttpOnly cookies and both API-created invoices visible through website detail pages.
- Saving a draft with insufficient stock is rejected without creating an invoice.
  A valid future-dated draft saves successfully, but its submission is rejected
  until that date arrives; the rejected submission retains the saved draft.
- Integration scope narrowing, overlapping replacement credentials, revocation and denial of stored-result replay under revoked credentials.
- A small 10-request, two-worker read-load smoke check through HTTPS with verified CA and zero failed requests.

Each successful check adds **two submitted synthetic invoices/receipts and one deliberately unsubmitted draft**. It does not erase previous checks or refill stock silently. Runs use unique operation keys/references, consume 2.5 units of permitted stock, and retain failed drafts for inspection. API limits remain active: avoid repeated rapid runs and allow rate windows to expire after a 429. This is repeatable deployment/workflow verification, not a production-capacity benchmark or actual-client sign-off.

The latest redacted result is `data/api-staging/acceptance.json`. Its `real_client_acceptance` field deliberately remains false. Use the live app plus these results to prepare actual mobile/integration client acceptance. Alerts are not wired to an external service; request/metric JSON remains available in staging app logs.

## Recorded local verification

The final scripted run on 13 October 2026 passed **11 grouped checks and 72 HTTPS requests**, plus a 10-request/two-worker read smoke with zero failures. Its small synthetic dataset timings were p50 63 ms and p95/p99 193 ms; these are observations from one local run, not capacity/SLO commitments. Staging app/database/proxy health checks pass. Host HTTPS responds 200 with explicit CA trust, app/database ports are unpublished, and only proxy port 3443 is bound to 127.0.0.1. Live financial commit/key-replay/reference-replay events and scheduled metric snapshots were observed.

Current-source regression verification used a different fresh isolated Docker `_hr_test` database: `npm run test:postgres` **251 passed**, and separate `npm run test:accounting` **14 passed**, with zero failures/skips. New staging tests cover hop-header handling and rejection of application/routine-test databases by staging tools. JavaScript/Bash syntax, Compose validation, documentation links, whitespace and ignored secret paths were checked. The disposable regression database/network were removed; the persistent staging deployment remains running.

## Remaining acceptance

Loopback staging is reachable only from this machine. A physical phone or external integration needs an explicitly chosen reachable staging host, HTTPS hostname and suitable certificate trust. No public server/domain deployment has been performed. Actual mobile secure-storage/refresh behavior, business-client import/reconciliation, representative load/data, external alert ownership, representative file/config/database restoration, rollout/rollback timing and pilot sign-off remain open. See the [operations runbook](operations.md) and [roadmap](../api-development-roadmap.md).
