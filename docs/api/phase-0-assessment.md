# Phase 0: API contract and workflow audit

Prepared: 12 October 2026. Status: Phase 0 closed. Defaults approved by the product owner on 12 October 2026, with payment compatibility requirements below. No `/api/v1` endpoint is implemented by this change. See the [objective](../api-implementation-plan.md#development-objective), [roadmap](../api-development-roadmap.md), and [OpenAPI draft](openapi.v1.draft.json).

## Readiness and scope

The app is ready for incremental API development. Existing invoice/payment domain functions, PostgreSQL transactions, stock row locking, permissions, and actor stamping form a usable foundation. It is not ready for external financial writes until shared authorization/validation, transaction-aware services, credentials, and durable idempotency are implemented and tested.

Core release: online authentication, permitted master-data and stock reads, invoice/payment reads, draft creation, separate invoice submission, and payment recording. Editing, cancellation, combined cash-sale operations, purchasing, inventory writes, webhooks, offline sync, and HR are deferred unless explicitly added. Website correction/cancellation remains available subject to current permissions. Minimal credential administration is required for launch but its interface is pending review.

Readiness evidence: the current source passed `npm run test:postgres` in the README isolated Docker setup: 183 passed, zero failed, zero skipped. This proves the existing baseline, not new API concurrency or capacity. Local `/login` returned HTTP 200. The baseline was committed as `86d1f3a` before this documentation change.

## Proposed endpoint and permission matrix

All paths below are relative to `/api/v1`. Scopes are proposed credential restrictions and never grant account permissions. All reads apply record restrictions before pagination/counts; all linked resources inherit parent visibility. No blanket Admin integration token is planned.

| Method and path | Credential scope | Existing action policy / restriction |
| --- | --- | --- |
| POST `/auth/login` | Public authentication | Existing password verification; active account; throttling |
| POST `/auth/refresh` | Refresh credential | Rotation, expiry, active account and replay checks |
| POST `/auth/logout` | Mobile session | Revoke own session family |
| POST `/auth/password` | Mobile session | Own password; temporary-password session may access this operation only |
| GET `/me` | Authenticated | Own public identity and effective capabilities |
| GET `/customers` | `masters:read` | `masters.customers.view` OR `vouchers.sales.create`; customer category scope |
| GET `/suppliers` | `masters:read` | Preserve supplier lookup alternatives in `src/authorize.js`; supplier category scope |
| GET `/items` | `masters:read` | Preserve item lookup alternatives in `src/authorize.js`; public fields only |
| GET `/warehouses` | `masters:read` | Preserve warehouse lookup alternatives; named warehouse scope |
| GET `/price-lists` | `masters:read` | Preserve lookup alternatives and named-list actions; sales selector limited to active UGX selling/both lists |
| GET `/cost-centers` | `masters:read` | Preserve lookup alternatives/assigned records; named restrictions |
| GET `/sales-options` | `invoices:create` OR `payments:record` | Proposed narrow selector: only permitted enabled invoicers and/or receiving accounts for the corresponding action |
| GET `/stock-balances` | `stock:read` | Preserve stock-balance lookup alternatives; requested warehouse permitted |
| GET `/invoices`, `/invoices/{id}`, `/invoices/{id}/payments` | `invoices:read` | `vouchers.sales.view`; customer, warehouse, price-list and ownership visibility |
| POST `/invoices` | `invoices:create` | `vouchers.sales.create`; permitted customer, warehouse, price list, cost center and invoicer |
| POST `/invoices/{id}/submit` | `invoices:submit` | `vouchers.sales.submit`; parent visibility, draft state and current stock |
| POST `/invoices/{id}/payments` | `payments:record` | `payments.sales.record`; parent visibility, permitted receiving account, submitted state and balance |

The selector fills an actual workflow dependency: website invoice creation requires an invoicer, and payments require a permitted cash/bank account. Do not expose a general HR employee or unrestricted chart-of-accounts endpoint for this purpose. Exact selector permission composition is pending review. Reuse the existing lookup predicates rather than simplifying them into unconditional master Read permissions. `/api/v1` needs explicit method/path branches; existing website path-based scope checks do not automatically cover it.

Standard-role invoice visibility includes creator ownership OR the assigned employee/invoicer exception (`src/voucher-ownership.js`). Service-account role choice must preserve intended reconciliation visibility. Detail lookup via `findInvoice` is not authorization by itself.

## Transaction map and implementation implications

| Operation | Current source and boundary | Required API adaptation |
| --- | --- | --- |
| Draft creation | `src/web/routes/sales.js:buildInvoicePayload` validates references; `src/domain/sales.js:createPostgresInvoice` inserts invoice/items/payments in `withPostgresTransaction` | API requires no embedded payments, rejects unknown fields, resolves authoritative names, shares validation; save draft and retry result on the same client |
| Submission | `submitPostgresInvoice` locks invoice `FOR UPDATE`, checks draft state, posts item movements, cost/profit, status, totals and GL in one transaction | Extract a client-taking implementation; recheck access/references inside service; commit retry result with posting |
| Stock movement | `src/domain/posting.js:applyPostgresStockMovement` upserts and locks item/warehouse balance, rejects insufficient stock, calculates valuation | Preserve locked final availability check; use deterministic lock order and bounded deadlock retry where justified |
| Payment | `addPostgresInvoicePayment` locks invoice, checks submitted state, calculates existing payments plus qualifying journals, rejects overpayment, inserts payment, syncs totals and creates payment journal within one transaction | Add external-reference uniqueness, explicit payment serializer/result, shared account permission check and same-client idempotency |
| Website create-and-submit | Website calls draft creation then submission in separate transactions | Preserve website behavior. API provides two explicit requests; failed submission does not undo an earlier committed draft |
| Cache invalidation | Website routes call `clearInvoiceCaches()` after mutations | Shared post-commit invalidation; invalidate on replay when needed to recover a post-commit failure. Current cache is process-local; replicas require an invalidation/TTL decision |
| Audit | `src/audit.js` uses AsyncLocalStorage; `AuditPool` stamps actor settings on checkout and table triggers record creator/updater | Authenticate before checkout. Add request/session/credential linkage without secrets; creator stamps alone are not an immutable operation history |

`src/core.js:withPostgresTransaction` obtains a new pooled connection each time. Wrapping existing domain calls in an outer transaction would not make them atomic with the outer idempotency record. Extract transaction-client variants and retain wrappers for existing callers. Review master-data helpers that query the pool so final validation can run on the service transaction.

Website item normalization filters invalid/nonpositive lines and performs rounding. Public JSON should explicitly reject malformed, nonfinite, negative or overprecision values instead of silently dropping them. Existing totals use rounding helpers and JavaScript numbers; decimal-string serialization does not change their arithmetic. Rates currently enter the payload from the form; do not invent a rate-override permission without a product decision.

## Contract and idempotency rules proposed for review

- OpenAPI 3.0.3 draft uses string IDs, decimal strings, explicit public schemas, `data` envelopes, UTC timestamps, calendar dates, and paginated lists (50 default, 200 maximum). It is a contract skeleton; production examples and complete business validation must land with each endpoint.
- Require `Idempotency-Key` on draft creation, submission and payments. Bound to 128 characters; namespace by stable account ID, operation and normalized resource path, across credential rotation. Hash canonical validated payload; reject changed payload with 409.
- Unique database claim and business effect/result commit atomically. Concurrent identical requests wait within a bounded limit or receive a documented retryable conflict; no second mutation. Authenticate and reauthorize before replay. Do not durably cache pre-commit validation failures as successful operations.
- Suggested retry-key retention: seven days. Durable external payment reference namespace is the integration account plus provider/source; it survives retry-record expiry and credential rotation. Reference reuse with a different invoice/amount conflicts; cancellation must not silently free a reference for reuse.
- Proposed statuses: 400 malformed input, 401 credentials, 403 action, 404 hidden/missing record, 409 state/key/reference conflict, 422 business validation, 429 throttling, 503 temporary failure. Stale edit 412 is reserved for a later edit endpoint.
- Request ID, actor, credential/session identifier, operation, voucher/payment IDs and committed outcome must be linked in durable audit records within the financial transaction. Attempt logs are separate and redacted. No credentials or raw sensitive request bodies in generic audit storage.

## Approved decisions and dependencies

The product owner approved the proposed defaults, subject to preserving existing website permissions, pricing, accounting and payment behavior. Product owner refers to the user; implementation owner refers to the developer implementing the phase.

| Decision | Recommended starting point | Owner / gate |
| --- | --- | --- |
| Core lifecycle | Online drafts, separate submission and receipts; website handles corrections initially | Product owner; before write contract freeze |
| Mobile client | Native bearer client; browser cookie origin protection retained | Product owner; before auth implementation |
| Mobile sessions | 15-minute access, rotating refresh, 30-day maximum; password resets revoke families | Product owner; before auth implementation |
| Integration role | Dedicated non-admin account, narrow scopes, explicit ownership visibility | Product + implementation owner; before credential pilot |
| Price/rate policy | Preserve existing website pricing and validation; no new override policy | Approved; parity tests required |
| Payments | One invoice per payment; account derives method; integration provider/reference required | Product/accounting owner; before payment contract freeze |
| Retention/reference namespace | Seven-day keys; durable account/provider/reference uniqueness | Product + implementation owner; before migrations |
| Credentials administration | Minimal protected issuance/revocation with secret displayed once | Product owner; before credential lifecycle implementation |
| Traffic/deployment | Single app instance initially; bounded lists and configurable limits | Product/operations owner; before load targets and pilot |
| Performance targets | Measure website baseline and agreed API workload; set thresholds from evidence | Implementation/operations owner; before launch |

Approved defaults: native bearer clients; 15-minute access and rotating refresh tokens with a 30-day family maximum; dedicated non-admin integration accounts; protected one-time credential issuance/rotation/revocation; seven-day retry retention and durable API payment-reference checks. Traffic targets remain an operational decision before launch, not a Phase 1 blocker.

## Prioritized implementation backlog

| Item | Dependency | Verification |
| --- | --- | --- |
| P1: Resolve auth/role decisions and finalize credential schema | Decision log | Revocation, password restrictions, scope narrowing, rotation/replay tests |
| P2: Add versioned router, errors, schemas, request IDs and explicit policies | P1 actor model | Real HTTP tests; fail-closed unknown routes/methods; no HTML errors |
| P3: Scoped read queries and public serializers, including sales selectors | P2 | Guessed IDs, linked payments, restricted counts/pagination and ownership tests |
| P4: Extract shared client-taking sales services and final validation | Transaction map | Website regression and pricing/accounting parity; injected rollback failures |
| P5: Idempotency migration, coordination and audit linkage | P1 + P4; retention decision | Concurrent duplicates, payload conflicts, lost response, revoked replay, audit isolation |
| P6: Invoice creation and submission endpoints | P3–P5; rate decision | One stock/GL posting; scarce-stock concurrency; retained draft on failed submit |
| P7: Payment reference constraint and receipt endpoint | P5–P6; namespace decision | Same/different-key duplicates, overpayment concurrency, journal allocation parity |
| P8: Docs, migrations, monitoring and pilot | P1–P7 | Full isolated PostgreSQL regression; contract/security/load/recovery and client acceptance |

Phase 0 is closed and Phase 1 is authorized. The OpenAPI remains a draft until each endpoint is implemented and tested. Performance targets and pilot volumes will be set before launch.

## Payment compatibility requirements

The initial API supports one invoice per payment and delegates financial effects to existing business logic. Do not change website payment behavior, allocations, accounting entries or workflows. Future multiple-invoice allocation should use a separate payment operation plus allocation rows rather than changing the meaning of existing invoice payment rows. No allocation feature is implemented now.

Idempotency and durable source/reference protection belong in API-owned tables; do not add uniqueness constraints or change behavior on existing payment tables without identifying the change and obtaining explicit approval. Any shared-service extraction must preserve existing transaction wrappers and have regression coverage. Phase 1 establishes generic transaction/audit infrastructure; public financial endpoints remain a later phase.
