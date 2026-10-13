# Phase 5 local hardening report

Prepared: 13 October 2026. Baseline: `c08f9da`. Local operational hardening is implemented. Staging and real-client work are deferred at the product owner's request; Phase 5 production launch is not complete.

Follow-up: the product owner authorized staging setup. An [isolated local HTTPS deployment](local-staging.md) now passes scripted restricted-mobile/integration sales flows, proxy/TLS checks and website reconciliation. The original checkpoint below remains local-hardening evidence; actual native/external clients, representative capacity/recovery and pilot gates remain open.

## Delivered locally

- Redacted per-request JSON and scheduled cumulative request/error/latency histograms, with fixed route/method/status/outcome labels and no actor/resource metric labels. Unknown paths are grouped; raw URLs, queries, bodies, headers, secrets and voucher IDs are excluded from request events. Completion/disconnection is counted once. API generic slow-path logging is replaced by the safe telemetry path.
- Distinct financial commit, same-key replay and permanent-reference replay outcomes. Existing public response bodies and posting/retry/reference behavior are unchanged. Telemetry sink failure cannot alter HTTP or financial behavior; durable audit remains authoritative.
- API-only containment through `API_V1_ENABLED=false`, returning 503 `api_disabled` before parsing/authentication and preserving website access and committed/credential state. Configuration validation and restart guidance are documented.
- A disposable local PostgreSQL dump/restore drill with synthetic data, all-public-table fingerprints, application initialization, original mobile/integration credential checks, preserved revocation, saved-key and new-key reference protection, no repeated financial posting and sequence continuity. Temporary data, network and fixture credentials are removed on exit.
- A TLS-by-default bearer read-load tool with environment-only tokens, allowlisted GET resources, bounded requests/concurrency/deadlines, per-worker pacing and redacted status/latency/throughput reports. Redirects, non-JSON/non-2xx and transport failures fail the run. It performs no financial mutations.
- An [operations runbook](operations.md) covering telemetry semantics, proposed alerts/ownership, uncertain operations, revocation, daily cleanup, backups, containment, compatible rollback and staged rollout. It includes the still-pending real-client/load/deployment acceptance matrix.

No database schema, payment table, financial allocation, pricing, website permission or accounting workflow changes are included. There is no new public metrics or audit-edit endpoint. No scheduler, external log collector, alert service, deployment or production pilot is claimed as configured by this work.

## Verification

- Current-source `npm run test:postgres`: **249 passed**, zero failures/skips.
- Separate `npm run test:accounting`: **14 passed** across six files, zero failures/skips.
- Disposable `bash scripts/api-recovery-drill.sh`: passed all restore checks below.
- Changed JavaScript syntax, Bash syntax, documentation file links, OpenAPI references/23 unique operations/503 containment responses and `git diff --check`: passed.

The full suite includes new telemetry/configuration/containment/read-load tests and real financial HTTP outcome checks, alongside existing authentication/permissions, website/accounting, concurrency/rollback, schema-upgrade and HR regressions. PostgreSQL and accounting runs used current read-only source, writable upload tmpfs and a fresh disposable `_hr_test` database on an internal Docker network, with no published database ports or application credentials. Temporary test database/network resources were removed after verification.

The local recovery drill restored **55 public tables** with matching fingerprints and passed initialization, original credential/revocation, retry/reference, no-reposting and sequence checks. Its source and target databases were distinct, fresh, synthetic `*_hr_test` databases in a tmpfs PostgreSQL 16 container on an internal Docker network with no published ports. No application environment file or application database credentials were used.

The load tool is verified against a local HTTP fixture for bearer headers, GET-only behavior, 429 accounting, bounds/TLS restrictions and report redaction. This is tool verification, not a representative capacity benchmark. The recovery drill covers PostgreSQL, not file volumes/deployment secrets or production RPO/RTO.

## Gates still open

| Gate | Status |
| --- | --- |
| Restricted mobile and actual integration-client staging acceptance | Deferred by product owner |
| Deployed TLS/proxy and credential drills | Pending staging/deployment |
| Representative load, financial concurrency workload and latency/error targets | Pending agreed volumes and staging data |
| External log collection, alert rules and named responders | Runbook proposals ready; deployment configuration/ownership pending |
| Representative database/file/config restoration and measured RPO/RTO | Synthetic local database drill passed; deployment verification pending |
| Compatible deployed rollback, limited pilot and launch sign-off | Runbook ready; deployment/client evidence pending |

Continue with these deployment gates when staging resumes. Do not mark Phase 5 complete or expand production access solely from local regression/drill evidence.
