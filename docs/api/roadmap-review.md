# API roadmap review

Reviewed: 12 October 2026. Implementation baseline: `5130ddc`. This review establishes development status; it does not certify production readiness or implement Phase 4.

Subsequent implementation: Phase 4 now exposes draft creation, submission and one-invoice receipt recording. The findings below retain the baseline review; consult the [Phase 4 report](phase-4-report.md) and [current roadmap](../api-development-roadmap.md) for the updated stage status and verification.

## Findings

Phase 0 is closed with approved defaults. Phases 1–3 are implemented, with financial HTTP workflows still pending. The [roadmap status table](../api-development-roadmap.md#reviewed-stage-status) is the current stage tracker; the older expansion phases in the implementation plan are not the core-release stage numbering.

Evidence checked:

- `src/api/router.js` mounts authentication, identity, integration administration and reads only. It has no financial POST routes.
- `src/api/reads.js` provides eleven read/selector operations. `openapi.v1.json` contains 20 implemented operations in total; financial operations remain in `openapi.v1.draft.json`.
- `src/services/sales.js` supplies internal `invoice.create`, `invoice.submit` and `payment.record` operations, transaction-local authorization/validation and post-commit cache invalidation.
- `src/api/transactions.js` and API schema/migration coverage provide durable retries, atomic financial/audit results and permanent account/source/reference protection.
- Phase reports and real HTTP/read/transaction tests establish local implementation evidence. They explicitly leave staging/client acceptance and operational launch evidence open.

Phase 2's real-client staging walkthrough is not recorded as complete. Phase 4 must prove public JSON validation, serializers and end-to-end HTTP financial parity; direct service tests alone cannot close that gate. Phase 5 must still establish measured capacity, deployment TLS, monitoring/alerts, backup restoration, rollback and client acceptance. Existing limits, audit records, documentation and migration tests are useful partial launch work.

## Continuation scope

Proceed with the three Phase 4 endpoints in the order recorded in the roadmap: draft creation, separate submission, then one-invoice receipt recording. Reuse the existing services and posting logic. Require bounded strict JSON and idempotency keys, preserve server calculations, and document external-reference and retry behavior. Corrections continue through the website; editing/cancellation, multiple-invoice allocation, webhooks and offline synchronization remain deferred.

This review changes documentation only. It introduces no permission, payment-schema, pricing, allocation or accounting behavior change.

## Verification

- Current-source `npm run test:postgres`: **228 passed**, zero failures/skips.
- Separate `npm run test:accounting`: **14 passed** across six files, zero failures/skips.
- Documentation file links and `git diff --check` passed.

Both database runs used the disposable local Docker database ending in `_hr_test`, an internal network with no published ports and read-only current source with writable upload tmpfs. No application environment file or database credentials were passed. The temporary database container and network were removed after verification. These are local regression results, not staging capacity or real-client acceptance evidence.
