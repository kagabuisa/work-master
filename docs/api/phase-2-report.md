# Phase 2 completion report

Prepared: 12 October 2026. Phase 2 adds authorized reads to the Phase 1 foundation. Public financial mutations remain planned; website payments, allocations, pricing, accounting entries and workflows are unchanged.

## Delivered

- Eleven GET operations: customers, suppliers, items, warehouses, sales price lists, cost centers, stock balances, invoice summaries, invoice detail, linked receipts and narrow sales selectors.
- Reused website lookup permission alternatives, current actor policy and token scope narrowing. Customer/supplier categories, named master restrictions, all invoice line warehouses, price lists and Standard creator/employee rules apply.
- SQL scope restrictions before invoice/master counts and page selection. Stable resource ordering, bounded pagination, allowlisted scalar filters and deliberate 404 concealment for hidden/missing invoices.
- Explicit public serializers with string IDs and decimal values. No raw audit identities, item costs/profits, employee contacts or unrestricted account metadata. Optional item prices reuse existing UGX selling-list/default-rate fallback.
- Receiving-account filtering for linked receipts and selectors. Existing journal allocations are read as distinct sources; legacy balance-only history has a stable representation. Individual receipt visibility does not alter authorized invoice totals.
- Read audit attribution, implemented OpenAPI covering 20 total operations, client examples, app-guide/permission/operational documentation and contract regression coverage.

## Compatibility and verification

There is no schema migration or change to existing payment tables. Existing master-data, stock and invoice domain readers gained optional API filters; website callers omit those options and retain current behavior. API-only public-field search prevents inference of internal item costs and employee contacts; website search remains unchanged. All posting and allocation functions remain unchanged in this phase.

- `npm run test:postgres`: 210 tests passed, zero failures/skips, against current source on a fresh isolated Docker PostgreSQL database ending in `_hr_test`, with an internal network and writable upload tmpfs.
- `npm run test:accounting`: 13 release checks passed across six files.
- Targeted read/response-contract verification after finalizing OpenAPI: 10 tests passed, zero failures/skips.
- Contract checks validate documented response shapes, required/allowed fields, types, enums, decimal patterns and paginated metadata for actual HTTP successes/errors. These cover the schema keywords used here; an external full OpenAPI validator remains a separate launch check.
- Real HTTP mobile/integration fixtures verify scoped list counts/pages, mixed-warehouse concealment, guessed IDs, parent/payment visibility, immediate permission changes, Standard ownership/employee exceptions, selector privacy, price fallback and strict query errors.
- Financial row snapshots verify that reads do not change invoices, payments, journals or ledger entries. Existing website and accounting regression suites remain passing.

## Remaining scope and review gate

Capacity measurements, real client/staging acceptance, TLS deployment verification, monitoring and recovery drills remain launch work. Invoice detail and linked-payment reads currently reuse full single-voucher hydration; receipt and receiving-account results are filtered before in-memory page slicing. Response size is bounded for lists, but query/hydration work should be measured at realistic voucher/account volumes before promising latency. Cross-request pagination is a live view rather than a synchronization snapshot.

The next roadmap phase completes reliability/service verification before public financial workflows. Phase 1 already supplies core idempotency and permanent-reference primitives; review final transaction-local reference validation, lock ordering and rollback/concurrency coverage before exposing financial HTTP routes. Any change to existing payment database behavior, workflows or allocations still requires explicit approval. Multiple-invoice API payment allocation remains deferred.
