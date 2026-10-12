# Phase 3 completion report

Prepared: 12 October 2026. Shared financial reliability is hardened and verified. Public API endpoints remain the 20 authentication/administration/read operations from Phases 1–2; financial HTTP endpoints are Phase 4 work.

## Delivered

- Financial permission checks and final reference checks use the same database connection as the posting, retry result and audit record. A single-connection pool test completes draft creation, submission and receipt recording without nested connection checkout.
- Current user/role and credential/session state is locked until commit. Refresh and logout follow consistent user-before-session order. User locks preserve update exclusion while allowing audit foreign-key reads; credential activity metadata skips pinned rows rather than blocking authentication. Real PostgreSQL wait observations verify that racing refresh and revocation serialize correctly; subsequent use/replay of old credentials is denied.
- Current actor identity sets both transaction-local record stamps and workflow fields such as submission identity. Cached caller metadata cannot supply a stale creator/submission name.
- New drafts resolve authoritative labels, enabled/permitted references and storage-safe values inside the transaction. Request hashes exclude server-derived names/defaults/snapshots, so a mutable reference does not change the identity of an identical request. Failed validation is not cached.
- Submission locks the invoice and lines, rechecks current item eligibility and stock, and prelocks item/warehouse stock keys in deterministic order. Original invoice line/posting order and existing financial calculation functions are preserved. Repeated lines share the same stock availability budget.
- Payment processing reuses existing one-invoice balance/allocation/journal logic, locks the eligible receiving account, and protects API source/reference identity permanently. Cancellation and ordinary key expiry do not free the reference or reactivate a cancelled receipt.
- Lock/deadlock contention produces a rolled-back retryable conflict; statements are capped at 15 seconds or the shorter configured database limit. Statement cancellation produces a rolled-back retryable 503. Financial operations are not automatically retried.
- Committed retry responses retain resource links for replay audit. Migration 19 adds/backfills only resource type/ID in `wm_api_idempotency`; response bodies/statuses and existing financial tables are preserved.

## Compatibility boundaries

No existing website route, payment table, posting function or allocation rule changed in this phase. Existing shared website validation is unchanged. Draft creation checks current master choices, while submission preserves the website's treatment of historical saved customer/employee/price-list references: inactive header references do not introduce a new submission/payment rejection. Current permissions, active items and stock constraints still apply. Cash/Bank eligibility matches the existing receiving-account rule.

Final active-record/state checks apply to new mutations. An authorized committed replay remains available after a reference is disabled; changed/revoked permissions still deny it. The same protected payment reference under a new key returns the original resource and never posts again. A changed amount/invoice under that reference conflicts. These guarantees apply within the existing API account/source/reference namespace and do not impose uniqueness on independent website payments.

## Verification

- Full isolated Docker PostgreSQL run: `npm run test:postgres`, **228 passed**, zero failures/skips.
- Separate accounting release run: `npm run test:accounting`, **14 passed** across six files.
- Final reliability cases include deadline, fresh-identity, repeated-line and nonblocking authentication/audit/logout assertions; see the full-suite count above.
- Coverage includes concurrent same-key and different-key retries, authoritative draft snapshots, corrected-reference retries, opposite-order submissions across actors, scarce-stock contention, existing cancellation, expired keys, inactive receiving accounts, injected audit/retry-storage failures, bounded lock timeout, real refresh/revocation waits, stale actor identity and a one-connection pool with a shorter statement deadline.
- Financial snapshots verify rollback of invoices/payments/journals/ledger/stock and permanent references on failure. Migration tests cover fresh installation, schema-17 upgrades and schema-18 retry metadata backfill, retaining original financial rows and saved response bodies.
- JavaScript syntax, diff whitespace and documentation links checked. Public read/authentication contracts remain unchanged and their regression tests pass.

## Remaining scope and next gate

Phase 4 must add strict financial JSON contracts and HTTP endpoints, then verify invoice-to-payment flows through those real HTTP routes. Internal service tests do not establish public financial endpoint readiness. Editing/cancellation endpoints and multiple-invoice API allocation remain deferred.

Phase 5 still requires capacity/load measurements, TLS deployment verification, monitoring, restore/recovery drills and real client acceptance. User-row locking serializes financial mutations for one account; measure throughput before promising integration capacity. Website operations retain their existing locking and may contend with API requests; rollback and same-key retry are the fallback rather than a rewrite of website behavior.

No changes to existing payment behavior/schema are required or approved. Any future such change needs explicit approval. Ordinary draft-create keys expire after seven days; clients must reconcile rather than blindly recreating after that boundary. Permanent receipt references remain protected beyond it.
