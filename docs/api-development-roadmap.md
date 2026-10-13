# API service development roadmap

Prepared: 12 October 2026. Status: Phase 0 closed with approved defaults; Phases 1–4 implemented. Current endpoints are documented in the [API guide](api/README.md); real-client acceptance and Phase 5 operational launch work remain open.

Updated: 13 October 2026. Phase 5 local operational hardening is implemented and verified; the product owner deferred staging/client work. See the [Phase 5 report](api/phase-5-report.md) and [operations runbook](api/operations.md). The production launch gate is not closed.

Follow-up: isolated [local HTTPS staging](api/local-staging.md) is now deployed and its scripted restricted-mobile/integration financial and website checks pass. Actual native mobile/external business clients and representative deployment/capacity/pilot evidence remain pending.

Phase 0 technical artifacts are available in the [workflow audit, permission matrix, decision log and backlog](api/phase-0-assessment.md) and [OpenAPI draft](api/openapi.v1.draft.json). The product owner accepted the defaults with explicit preservation of website pricing, payment allocations, accounting entries and workflows; future multiple-invoice payment allocation remains deferred.

## Reviewed stage status

Repository review: 12 October 2026. Phase 4 continues the implementation baseline `5130ddc`. Implementation completion is separate from client acceptance and production readiness. The current public contract contains **23 operations**: nine authentication/identity/credential operations, eleven business reads/selectors and three financial POST operations.

| Phase | Established status | Evidence and remaining gate |
| --- | --- | --- |
| 0: Scope and audit | Closed | Approved defaults and compatibility requirements in the [Phase 0 assessment](api/phase-0-assessment.md); traffic and performance targets remain launch decisions |
| 1: Foundation and authentication | Implemented and locally verified | [Phase 1 report](api/phase-1-report.md), bearer router, credential lifecycle, scopes, audit and migration 18; deployed TLS and operational acceptance remain open |
| 2: Authorized reads | Implemented and locally verified; client acceptance open | [Phase 2 report](api/phase-2-report.md), scoped reads and implemented OpenAPI; real mobile/integration staging walkthrough remains unrecorded |
| 3: Reliability and audit | Implemented and locally verified | [Phase 3 report](api/phase-3-report.md), transaction-aware services, atomic retry results, permanent payment references and migration 19; public HTTP financial parity belongs to Phase 4 |
| 4: Financial workflows | Implemented and locally verified; client acceptance open | [Phase 4 report](api/phase-4-report.md), strict draft/submission/one-invoice receipt routes and real HTTP financial parity/retry/rollback tests; both real-client staging walkthroughs remain open |
| 5: Launch and handover | Local hardening implemented; launch gate open | [Phase 5 report](api/phase-5-report.md): redacted request/latency metrics, API containment, local dump/restore drill, read-load tool and runbooks; deployed alerting/ownership, capacity targets, representative recovery, TLS, rollout and real-client acceptance remain pending |

Do not treat Phases 0–4 as a completed production release: Phase 2's client walkthrough and Phase 4–5 acceptance gates still need evidence. Prior report test totals describe their respective implementation checkpoints; the [roadmap review](api/roadmap-review.md) records the baseline review and the Phase 4 report records financial HTTP verification.

## Phase 4 delivered scope

The three required operations use `src/services/sales.js` and `src/api/transactions.js`:

1. `POST /api/v1/invoices`: strict allowlisted draft JSON, bounded line counts/strings, valid dates and decimal precision; no embedded receipts; authoritative server totals and public result fields.
2. `POST /api/v1/invoices/{id}/submit`: explicit empty-body contract, current authorization, required retry key, saved-draft state checks and a documented result.
3. `POST /api/v1/invoices/{id}/payments`: one-invoice receipt contract, permitted receiving account, derived method, required external source/reference and retry key; existing allocation and posting rules preserved.

Real HTTP fixtures cover mobile and integration actors, scoped denials, contract errors, concurrent retries, changed-payload conflicts, revoked replay, financial rollback, stock/balance contention, totals/ledger/allocation parity, creator attribution and website cache visibility. Failed submission retains the previously committed draft. Implemented OpenAPI, client examples, app guide, permissions and operations documentation describe the current endpoints. Both real-client invoice-to-payment staging walkthroughs are still needed to close the Phase 4 acceptance gate.

Draft editing, cancellation endpoints, multiple-invoice payment allocation, webhooks and offline synchronization remain outside this stage. Phase 4 introduces no migration or redesign of existing website payments or accounting.

## Next stage: acceptance and Phase 5 launch work

Local telemetry, containment, restore verification, read-load tooling and an isolated HTTPS staging deployment are ready. Scripted staging flows verify proxy/TLS, scoped reads, financial retries/reconciliation, secure website cookies and revocation. Complete the outstanding walkthroughs with actual native mobile/external integration clients, agree on pilot volumes and measure representative API load/concurrency alongside website traffic. Connect log collection/alerts and name responders, verify the chosen reachable deployment's TLS and representative backup/file/config recovery, and exercise compatible rollout/rollback before production expansion. Local staging scripts do not replace actual client or production pilot sign-off.

## Objective and release scope

Deliver the [saved API objective](api-implementation-plan.md#development-objective): secure, documented, versioned access for mobile users and integration accounts, with permitted master-data and invoice reads, invoice draft creation and submission, payment recording, shared durable idempotency, and end-to-end transaction auditability.

The first production release covers online use. Its required mutations are draft creation, invoice submission, and payment recording. Phase 0 deferred draft editing, invoice cancellation and payment cancellation API endpoints, with corrections handled through the website initially. Purchasing, inventory mutations, expanded reports, webhooks, offline synchronization, and HR are later releases. Warehouse stock-balance reads support the sales workflow.

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
