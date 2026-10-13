# API operations and launch runbook

Updated: 13 October 2026. Applies to the current single-instance `/api/v1` service. Local telemetry, containment, restore verification and read-load tooling are implemented. Staging/client acceptance, deployed TLS, capacity targets, production alert ownership and limited-pilot evidence remain pending by product-owner decision.

## Telemetry and access

Every API request produces one JSON `api_request` event at response completion or disconnection. It includes generated request ID, timestamp, process ID, bounded route template, method, status, duration, abort flag, authenticated actor/credential/session IDs when available, error code and financial outcome. Headers, cookies, tokens, passwords, request bodies, query values, resource IDs, names and raw URLs are excluded. Unknown paths use `unmatched`. Request metadata and durable audit still require restricted operational log/database access.

`api_metrics` JSON snapshots contain cumulative per-process counts, duration sums and cumulative latency buckets at 10, 50, 100, 250, 500, 1000, 3000 and 15000 ms plus `+Inf`. Labels are bounded route, method, status class and outcome; account, credential, request and resource IDs are not metric labels. Snapshots include process ID and startup timestamp: use counter deltas within the same process lifetime, and treat restart as a reset. Do not add successive cumulative snapshots together. Approximate percentiles can be derived from histogram deltas; the load tool reports measured request percentiles separately. Aborted requests have status 0 and their own status class.

Financial outcomes:

| Outcome | Meaning |
| --- | --- |
| `committed` | A new successful financial operation/result committed |
| `replayed` | Same-key committed result returned; no repeated posting |
| `reference_replayed` | A new key returned a permanently protected existing receipt; no repeated posting |
| `failed` | HTTP failure/disconnection without a recorded successful mutation result |
| `none` | Successful nonfinancial request |

Logs are observational, not the accounting source of truth. A connection can fail after a database commit; resolve uncertainty through saved retry results and durable `wm_api_audit` records. Telemetry failures do not roll back a financial commit. Request events are emitted before they leave the process; external log collection/delivery is an operations responsibility. Metrics are in memory, not persisted or publicly exposed by a new endpoint.

| Environment variable | Default | Behavior |
| --- | --- | --- |
| `API_REQUEST_LOGS` | `true` | Emit per-request JSON events; accepts only `true`/`false` |
| `API_METRICS_INTERVAL_MS` | `60000` | Emit cumulative snapshots; integer 0 disables scheduled snapshots, maximum 2147483647 |
| `API_V1_ENABLED` | `true` | `false` rejects new API requests with JSON 503 `api_disabled` before body parsing/authentication |

Apply configuration through the deployment environment and recreate the app. Invalid values are rejected. Website routes retain their existing logging and access. The API's generic slow-path logger is suppressed in favor of safe route templates. Use existing `POSTGRES_POOL_METRICS_MS` when investigating pool pressure; collect database lock/CPU/storage evidence alongside latency.

## Alert setup and ownership

The following alert rules are proposals ready for the staging/operations owner to configure; no alert service or external notifications are connected by this change. Name an on-call responder and escalation owner before pilot. Store confirmed targets and contacts in the deployment's restricted operations records rather than inventing them here.

| Signal | Investigation / owner to assign |
| --- | --- |
| Any financial 5xx, `api_audit_failure`, repeated 503 or missing resource attribution | Application/accounting responder: correlate request ID with durable audit, check database/pool and reconcile saved result |
| Rising 401/403 or refresh-replay denials | Account/security responder: credential expiry/revocation, scope changes and coordinated mobile refresh |
| Repeated 409 `operation_in_progress` / timeouts | Application/database responder: locks, account serialization and contention; preserve original retry keys |
| 409 key/reference conflicts | Integration owner: distinguish client payload changes from duplicate imports; never release permanent reference rows |
| Sustained 429 | Integration/operations owner: rate windows, client pacing and shared proxy IP; do not raise limits without measurements |
| Elevated p95/p99 or aborted requests | Operations/database owner: agreed workload baseline, query/pool pressure and network interruption |
| Missing metric heartbeat | Operations owner: process/container and log collector liveness; interval 0 intentionally disables heartbeat |
| Expired retries/windows or growing audit/reference tables | Database owner: daily cleanup job completion, backups, retention/capacity |

Latency/error-rate thresholds require staging measurements. Check counts over a defined rolling window and apply minimum-volume rules; a percentage from one request is not a capacity target. Financial integrity failures require investigation even at low volume.

## Uncertain financial operation or outage

1. Retain the original account, operation, resource path, validated JSON and retry key securely in the client. Capture the response request ID; do not place tokens or payloads in incident logs.
2. On contention, statement timeout or a lost response, retry identical JSON with the same key after a bounded delay. Do not automatically generate another draft or receipt key to recover an uncertain operation.
3. Use permitted invoice/payment reads and durable audit to reconcile the original resource. Saved operation results are snapshots; current website edits/cancellations may differ.
4. Treat changed-key payload conflicts as client defects or intentional changes requiring a new business decision. An external payment reference conflict does not authorize deleting its protection row.
5. After seven-day draft-key expiry, reconcile the original voucher before attempting another creation. Permanent receipt references still protect identical account/source/reference imports; cancellation never frees them.

## Credential compromise and revocation

Use a mobile Admin session with the documented credential administration endpoints to list metadata, revoke the compromised credential ID and issue a replacement for the same integration account. Update the client securely. Revoke first for compromise; planned rotation can overlap credentials before revoking the old ID. Verify subsequent API use and saved-result replay return 401 using a disposable account in the staging drill. Deactivation blocks the account's credentials; dedicated integration accounts must remain non-admin.

For mobile credentials, logout revokes that family. Supported password reset/change invalidates sessions through the existing lifecycle. Do not reset service-account passwords for routine integration rotation. Revocation racing an already authorized transaction waits for that operation, then denies subsequent requests. Reconcile any operation that may have committed before revocation.

## Cleanup and retention

Schedule `docker compose exec invoice-app node scripts/api-cleanup.js` daily through the deployment's scheduler. Capture exit status and the redacted completion/failure message; investigate failures rather than blindly deleting tables. It removes expired retry records, rate windows and expired mobile families/history. It preserves durable financial audit, credential metadata and permanent payment references. Refresh history is retained for its family lifetime. Cleanup scheduling is not installed by this repository change.

## Backup and restore

Include the complete PostgreSQL database in backups: financial vouchers/lines/allocations, journals/GL, stock, master records and permissions, schema/migration metadata, credentials/sessions/history, API retry/audit/reference tables and uploaded-file records. Protect database backups as credential-bearing business data. Back up deployment secrets and persistent `invoice-data` separately under the deployment's existing storage policy. This local database drill does not certify file-volume or deployment-secret recovery.

Run the implemented disposable drill on the local Docker host:

```sh
bash scripts/api-recovery-drill.sh
```

It creates a new internal Docker network and PostgreSQL 16 container with tmpfs data and no published ports. It seeds only synthetic data in `work_master_source_hr_test`, takes a custom-format `pg_dump`, and restores to a separate empty `work_master_restore_hr_test` database. Both fixture runners mount current source read-only and use no application environment file. A protected temporary file holds synthetic credentials and table fingerprints; exit cleanup removes containers, network, dump and fixture state, including on failure. No application database is dumped, modified or reset.

Verification compares every public table fingerprint, initializes the restored application schema, resolves original mobile/integration credentials, retains revoked-credential rejection, replays saved financial results and protects receipts under new keys without additional postings. It checks sequence continuity by creating a new synthetic draft. This is local recovery evidence, not a measured production RPO/RTO. Run a separate staging restore using representative backups and verify uploaded files, deployment configuration and measured recovery time before launch.

Restoring an older backup can discard financial records, revocations, retries or reference protection committed after that backup. Never overwrite a live database with an older dump merely to roll back API code. Define recovery points and reconcile post-backup effects before serving clients again; avoid two writable copies importing the same external receipts independently.

## Containment, rollout and rollback

For API containment, set `API_V1_ENABLED=false` in the deployment environment, recreate the app and verify `/api/v1` returns 503 `api_disabled` while the website responds normally. This does not revoke credentials or remove data, and it does not undo operations authorized before containment. Reconcile uncertain/in-flight operations using saved results and durable audit. Keep backups, monitoring and cleanup active; ordinary retry keys can expire during an outage.

For rollout, record the reviewed commit/image and current schema version, take verified backups, and run isolated PostgreSQL/accounting/recovery checks. First enable one restricted mobile client and integration account with scoped records and known synthetic invoices. Review real-client and measured-load evidence before expanding credentials or traffic. The initial supported topology is one app instance; shared-cache behavior and account throughput require review before adding replicas.

For application rollback, prefer disabling the API, preserving the current schema and committed financial records, and deploying a reviewed compatible application image. No down migration or financial reversal is provided by Phase 5. Startup rejects older code that does not support the current schema, so do not blindly select a pre-migration image. Retain `wm_api_payment_references`, retries, revocations and audit across rollback; do not restore an older credential state. Capture an immutable image digest in the deployment's release record before replacing it.

## Staging load and client acceptance preparation

The implemented load tool issues GET requests only, uses opaque tokens exclusively from its process environment, rejects embedded URL credentials/query/fragment and follows no redirects. It allowlists master, invoice, stock and `/me` reads. It drains response bodies without printing them. Reports contain route names, status/error counts, bytes, p50/p95/p99 and throughput; credentials, warehouse values and business data are excluded.

```sh
npm run perf:api -- --url=https://staging.example/api/v1 --resource=invoices --requests=30 --concurrency=1 --interval_ms=1000
```

Supply `API_BENCHMARK_TOKEN` through secure environment injection, or `API_BENCHMARK_TOKENS` as a JSON array for multiple credentials. Do not place tokens in command arguments, source files or shell history. Defaults are 30 requests, concurrency 1, 1000 ms pacing per worker and a 15-second deadline. Maximums are 10000 requests, concurrency 100 and deadline 360000 ms. Stock reads additionally require `--resource=stock-balances --warehouse=<permitted-warehouse>`. Explicit `--allow_local_http=true` permits loopback HTTP only for local testing; never bypass staging TLS verification.

Measure scoped datasets, cold/warm reads and agreed concurrency alongside website traffic. Limits remain 120 requests/account/minute and 300/IP/minute, counting attempts; every worker is paced independently, so increased concurrency increases aggregate rate. A 429, redirect, non-JSON response, timeout or other non-2xx response fails the load run. Coordinate mobile refresh outside the tool; it does not log in, rotate credentials or refresh tokens. Record workload, dataset size, commit/image, permissions, token kind, proxy topology and rate-limit assumptions with results. No default latency SLO or production capacity is claimed.

Financial concurrency and uncertain-response scenarios are automated in `tests/api-financial.test.js` and `tests/api-transactions.test.js`. Staging financial load must use a dedicated staging database with synthetic stock, known balances and stable operation keys/references; never use live company vouchers to generate load. The read tool does not generate financial load.

| Acceptance evidence still required | Record when staging resumes |
| --- | --- |
| Restricted native mobile client | Device/app build, secure token handling, login/refresh/logout, permitted selectors and invoice-to-payment walkthrough |
| Actual integration client | Client/version, least-privilege account, creation/submission/receipt import, rotation/revocation and retry reconciliation |
| Permission isolation | Guessed/hidden IDs, mixed warehouses, account restrictions, immediate policy changes and denied replay |
| Financial reconciliation | Website visibility, totals, stock/GL, existing allocations, duplicate/ref-conflict and retained-draft failures |
| Deployment and capacity | TLS/proxy verification, agreed volumes, latency/error targets, alert owners and replica/cache decision |
| Recovery and pilot | Representative backup/restore timing, file/config recovery, compatible rollback, limited-pilot review and sign-off |

Capture request IDs and redacted outcomes with each scenario. Keep actual credential values outside acceptance reports. All rows remain pending until exercised against the real staging deployment and clients.
