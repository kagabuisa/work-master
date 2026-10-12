# Phase 4 implementation report

Prepared: 12 October 2026. Baseline: `5130ddc`. The three required financial HTTP operations are implemented. Real-client staging acceptance and operational production launch remain open; local automated fixtures do not close those gates.

## Delivered

- `POST /api/v1/invoices`: strict draft-only input, 1–200 lines, one header warehouse, decimal-string precision/range checks, valid dates/time, bounded text and allowlisted fields. Customer, employee and item names come from the existing transaction-local reference checks. Saved server totals are returned with the invoice identity and draft state.
- `POST /api/v1/invoices/{id}/submit`: explicit `{}` input and required retry key, current parent access and draft-state checks, existing deterministic stock locks and stock/accounting posting. Success returns the committed invoice identity, state and totals. Failed submission leaves the previously committed draft intact.
- `POST /api/v1/invoices/{id}/payments`: one submitted invoice per receipt, required external source/reference, positive decimal amount, permitted active Cash/Bank account and derived method. Success identifies the original receipt and parent invoice, with current details available through authorized reads.
- All three reuse the Phase 3 shared service and retry/audit transaction. Identical concurrent keys return one committed result; changed key reuse conflicts. Permanent payment references protect receipts across new keys, expiry, rotation and website cancellation. Creation replay also checks current saved-invoice visibility after website edits.
- API-only state and expected receipt business failures use documented 409/422 errors. Domain functions and their website error behavior remain unchanged. Current request IDs, no-store headers and credential checks apply to financial routes.
- Implemented OpenAPI now covers 23 operations. Client examples, input/retry/error guidance, app guide, permission mappings, operational README and roadmap status are updated.

## Compatibility boundaries

No schema migration, existing payment-table change, website route change, allocation-rule change or accounting/pricing calculation change is included. Existing transaction wrappers and shared website validation are retained. Supplied rates follow existing website normalization rather than a new override policy or forced repricing. Qualifying journal allocations retain their existing effect on receipt balance checks. External identity stays in existing API-owned tables; ordinary website payment references remain generated journal numbers and website reference reuse remains permitted.

Invoice mutation responses are operation snapshots saved in API retry records; subsequent reads supply current state. Receipt responses deliberately identify the original record instead of reconstructing a success from a later cancelled state. Cancellation never reactivates a protected receipt. No public draft-edit, invoice/payment-cancel, cash-sale shortcut or multiple-invoice allocation endpoint is introduced.

## Verification

Automated verification ran against current source using the isolated local Docker PostgreSQL procedure in README:

- `npm run test:postgres`: **244 passed**, zero failures/skips, including 16 new financial input/HTTP checks.
- Separate `npm run test:accounting`: **14 passed** across six files, zero failures/skips.
- Changed JavaScript syntax checks, documentation file links, all OpenAPI internal references, 23 unique operation IDs and `git diff --check` passed.

Both database runs used a fresh disposable database ending in `_hr_test`, tmpfs database storage, an internal network with no published ports and current source mounted read-only with writable upload tmpfs. No application environment file or application database credentials were supplied. Temporary database/network resources were removed after verification.

`tests/api-financial.test.js` adds real HTTP coverage for:

- Invalid/unknown/oversized fields, decimal types/scales, malformed JSON, ambiguous retry headers, unsupported media and missing/mixed credentials.
- Authoritative labels and committed totals, creator identity, current saved-draft replay visibility and website invoice-list cache invalidation.
- Concurrent create/submit/payment retries, changed-payload conflicts, discarded-response recovery and lock-timeout rollback with same-key recovery.
- Stock contention across accounts, retained drafts, state/active-reference failures and concurrent different-key overpayment prevention.
- Mobile and scoped integration flows, credential revocation, account permission changes, Standard ownership/employee exception and concealed IDs.
- Injected audit/retry-storage failures rolling back invoices, lines, payments, journals, ledger, stock, retry records and permanent references.
- Website/API financial parity for totals, quantities/rates, stock and general ledger effects, bank-method derivation, qualifying journal allocations and existing website receipt POST behavior.
- Permanent reference protection after ordinary key expiry and website receipt cancellation.

Existing API, website, fresh-install/upgrade migration, accounting and HR regressions remain part of the full isolated suite. Response-contract checks validate the OpenAPI schema keywords used in this repository; a full external OpenAPI validator remains launch work.

## Next gate

Complete real restricted-mobile and integration-client staging walkthroughs, including read selectors and invoice-to-payment reconciliation. Then complete Phase 5 capacity/load measurements, deployed TLS verification, monitoring/alert ownership, credential drills, backup restoration and rollout/rollback procedures before expanding a limited pilot. User-row serialization and process-local website cache invalidation retain the Phase 3 capacity/topology limitations.
