# API service development roadmap

Prepared: 12 October 2026. Status: planned; API implementation remains on hold until requested. This roadmap does not establish that any proposed `/api/v1` capability is available.

## Objective and release scope

Deliver the [saved API objective](api-implementation-plan.md#development-objective): secure, documented, versioned access for mobile users and integration accounts, with permitted master-data and invoice reads, invoice draft creation and submission, payment recording, shared durable idempotency, and end-to-end transaction auditability.

The first production release covers online use. Its required mutations are draft creation, invoice submission, and payment recording. Draft editing, invoice cancellation, and payment cancellation are conditional additions: Phase 0 must decide whether clients need them for launch. Purchasing, inventory mutations, expanded reports, webhooks, offline synchronization, and HR are later releases. Warehouse stock-balance reads support the sales workflow.

The existing `/api` browser lookups must continue working. Extend the current Express/PostgreSQL application and extract shared services incrementally rather than creating a second accounting implementation.

## Delivery sequence and effort

Estimates are provisional effort for one experienced backend developer with reviewer and client-team availability. They exclude mobile UI development, external adapters, and waiting for decisions. Re-estimate after Phase 0; calendar dates require a start date and confirmed staffing.

| Phase | Main deliverable | Dependencies | Working days |
| --- | --- | --- | --- |
| 0 | Reviewed scope, contract, and transaction audit | Product and accounting input | 3–5 |
| 1 | Versioned foundation and credential lifecycles | Phase 0 | 5–8 |
| 2 | Permitted master-data, stock, and invoice reads | Phase 1 | 3–5 |
| 3 | Shared transaction services, audit linkage, and idempotency | Phase 0 transaction audit and Phase 1 actor model | 5–8 |
| 4 | Invoice creation/submission and payment recording | Phases 2–3 | 5–8 |
| 5 | Operational hardening, pilot, and production handover | Phases 1–4 | 4–7 |

Core release estimate: **25–41 working days**, approximately **5–9 full-time working weeks**. Read capability is expected after 11–18 working days; financial workflows after 21–34 days. These revised ranges explicitly separate reliability infrastructure and launch work; they replace the earlier sales-MVP range for planning this scoped release. Conditional edit/cancellation work requires additional estimation.

## Phase 0: Scope, contract, and transaction audit

Deliverables:

- Endpoint backlog for authentication, `/me`, master data, stock balances, invoice list/detail, draft creation, submission, and payments.
- Proposed OpenAPI contract covering public fields, decimal strings, pagination, filters, errors, idempotency, and examples.
- Method/path permission matrix using existing action keys, record restrictions, ownership rules, and additional credential scopes.
- Transaction map for invoice creation, submission, payments, posting, cache invalidation, and actor attribution. Identify domain functions using independent pooled connections.
- Decision log for session lifetimes, integration account ownership, pricing overrides, payment allocation/reference rules, retry retention, deployment topology, expected volume, and conditional lifecycle endpoints.

Exit gate: reviewers agree on launch scope and client behavior; every required financial operation has a documented transaction boundary and permission policy. Unresolved choices have named owners and are marked as blockers for dependent work.

## Phase 1: API foundation and authentication

Deliverables:

- `/api/v1` router, explicit authorization classification, request IDs, JSON errors, schema validation, bounded inputs, and explicit serializers.
- Mobile login, access/refresh lifecycle, logout, password-change handling, and `/me`; hashed credentials, transactional refresh rotation, and revocation.
- Dedicated integration accounts and scoped credentials with issue, expiry, rotation, and revocation through a minimal supported administration flow.
- Deliberate bearer/cookie separation, mixed-credential rejection, secret redaction, HTTPS deployment policy, and authentication/request throttling.

Exit gate: real HTTP tests prove valid access, expired/revoked credential rejection, permission changes on subsequent requests, temporary-password restrictions, refresh replay policy, and fail-closed unknown routes. Integration scopes cannot broaden account access. Existing browser authentication remains functional.

## Phase 2: Authorized read service

Deliverables:

- Permitted customer, supplier, item, warehouse, price-list, and cost-center reads; stock balances; invoice list/detail and payment reads.
- Stable ordering, bounded pagination, allowlisted filters, scope filtering before counts, and deliberate missing/hidden-resource responses.
- Client examples and fixtures for both a mobile user and an integration account.

Exit gate: guessed identifiers, linked payments, restricted warehouses/price lists, and ownership boundaries cannot expose unauthorized data. Response fields match the contract and omit credential/audit internals. A mobile client and integration client complete a read-only staging walkthrough.

## Phase 3: Shared reliability and audit infrastructure

Deliverables:

- Shared application services accepting the authenticated actor and a transaction context. Preserve website validation and accounting behavior as workflows are extracted.
- PostgreSQL idempotency records with a unique account/operation/key constraint, canonical request hash, committed result, retention rules, and bounded key input.
- Atomic business mutation and idempotency-result commit on the same connection. Serialize concurrent duplicates; return the committed result for identical payloads and `409` for changed payloads. Authenticate and recheck access before replay.
- Audit linkage from request ID and account/credential or mobile-session identifier to voucher, payment, and accounting effects, without storing raw secrets.
- Transactional state/stock checks and durable external payment-reference uniqueness with a documented namespace. Define behavior when keys expire, failures occur before commit, or responses are lost after commit.
- If draft editing is in scope, resource versions and `If-Match` checks updated by website and API changes.

Exit gate: database tests prove one mutation for concurrent duplicates, full rollback on injected failures, safe retry after lost responses, conflicts on payload mismatch, and no unauthorized replay. New keys cannot duplicate payments with the same protected external reference. Website/API shared-service behavior remains equivalent.

## Phase 4: Financial workflows

Deliverables:

- Draft creation and separate submission endpoints, plus authorized payment recording. Require idempotency keys for these operations.
- Reuse current pricing, active-record validation, receipt-account restrictions, stock rules, and payment-allocation rules; server totals remain authoritative.
- Preserve creator attribution, website visibility, cache invalidation, and consistent error/retry responses.
- Implement conditional editing/cancellation only if included in Phase 0, using the same reliability infrastructure and explicit accounting reversal rules.

Exit gate: equivalent website/API scenarios produce matching totals, stock ledger and general ledger effects, payment allocations, and audit attribution. Concurrent submissions cannot double-post or oversell according to existing stock policy. Failed submission leaves the previously created draft in its documented state. Both pilot clients complete invoice-to-payment workflows.

## Phase 5: Launch verification and handover

Deliverables:

- Complete OpenAPI and client guidance, including credential rotation, errors, retry keys, retention, duplicate-payment protection, and version compatibility.
- Request/error/latency metrics and financial-operation/idempotency visibility, redacted logs, alert ownership, and operational runbooks.
- Fresh-install and upgrade migration checks, staged feature rollout, credential revocation drills, backup/restore verification, and a rollback procedure that preserves committed financial records.
- Staging load and concurrency tests at agreed volumes; set latency and error-rate targets from measurements.

Exit gate: required regression, security, contract, concurrency, and PostgreSQL integration checks pass; client acceptance passes for a restricted mobile user and integration account; no unresolved permission leak, duplicate posting, partial transaction, or missing financial attribution remains. Start a limited pilot and expand only after reviewing its evidence.

## Verification and documentation throughout

Each phase includes its own tests and documentation; testing is not deferred until launch. Use the local Docker runtime against current workspace source. Run database integration checks on a fresh isolated PostgreSQL database ending in `_hr_test`, following README's Local Docker integration tests procedure; never reset the application database.

For financial changes, run the relevant accounting and release checks plus new real-HTTP/API and transaction tests. Preserve browser lookup contracts and verify shared website workflows. After each completed repository change, rebuild `invoice-app` and verify its configured local port according to AGENTS.md.

Publish implemented API contracts and examples under `docs/api/` as endpoints land. Update `docs/app-guide.md` for implemented workflows/validation, `docs/permissions.md` for access rules, and `README.md` for setup, migrations, API configuration, and operations. Keep proposals visibly separate from available functionality.

## Later releases

| Extension | Prerequisite and release gate |
| --- | --- |
| Purchasing and inventory writes | Reuse shared idempotency; prove module-specific permission and posting parity |
| Expanded reports | Scoped queries, bounded workloads, and export/access tests |
| Webhooks | Transactional outbox, supervised delivery worker, signing, destination controls, retry/recovery tests |
| Offline synchronization | Defined conflict policy, ordered changes, deletion handling, cursor expiry and full resync |
| HR API | Separate privacy, permission, and approval-workflow review |

The detailed architecture and broader expansion estimates remain in the [API implementation plan](api-implementation-plan.md). Later releases are outside the core release estimate above.
