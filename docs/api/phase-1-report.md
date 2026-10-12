# Phase 1 completion report

Prepared: 12 October 2026. Phase 0 decisions were committed as `6f19e15`. Phase 1 implements the foundation; Phase 2 business reads and later public financial endpoints are not enabled.

## Delivered

- Separate bearer-only `/api/v1` router with JSON validation/errors, generated request IDs, no-store responses and production HTTPS enforcement.
- Existing-password mobile login; 15-minute opaque access tokens; rotating refresh tokens with a 30-day maximum family lifetime, retained reuse detection and family revocation. Own logout/password change and temporary-password restrictions.
- Dedicated non-admin integration accounts; hashed 90-day credentials, explicit scope narrowing, overlapping replacement credentials, metadata listing and Admin-only revocation. Interactive login is disabled only for the newly designated service accounts.
- Current role/override resolution and shared action/record access checks. Revocation, expiry, deactivation and password-version changes are checked before protected access and financial replay.
- Client-taking invoice/payment domain functions and shared website validation helpers, with the original website transaction wrappers preserved. Financial HTTP routes remain deferred until their strict contracts and final reference validation are implemented.
- Atomic API retry executor, seven-day stored results, duplicate-request serialization, changed-payload conflicts and permission checks before replay.
- API-owned permanent account/source/reference protection, independent of retry expiry and credential rotation. One invoice per payment; no multiple-invoice allocations. No new constraint or behavior on existing payment tables.
- Durable request/actor/credential/session audit records; financial mutations commit effects, retry result and resource audit together. No passwords or token values in these records.
- Database-backed defensive limits and a tested cleanup command that preserves financial audit and permanent payment references.

## Compatibility and database changes

Migration 18 adds `wm_api_*` foundation tables and an `api_service_account` user flag, default false for existing users. It does not change existing invoice payment columns, allocations, journal generation or ledger rules. Existing payment posting still replaces its reference with a generated journal number; the API stores external references separately. API reference protection applies within one integration account and does not retroactively deduplicate website payments or other integration accounts.

The website reuses the extracted validation functions without rule changes. Existing creation/submission/payment entry points still own their transactions and keep their return values. The API adapters can enlist the same mutation bodies in a larger transaction for retry/audit atomicity. No rate-override policy or new pricing restriction was introduced.

## Verification

- `npm run test:postgres`: 199 tests passed, zero failed/skipped, using current workspace source and a disposable PostgreSQL database ending in `_hr_test`, an internal network and writable upload tmpfs.
- `npm run test:accounting`: 13 tests passed across six release-check files.
- Final targeted API run after adding cleanup coverage: 16 tests passed, zero failed/skipped.
- Coverage includes real HTTP credentials and legacy cookies, a real website payment POST, financial wrapper/service parity, ownership/warehouse restrictions, refresh races/reuse, expiry/revocation, duplicate payments under identical and different keys, permanent references beyond retry expiry, current permissions before replay, audit attribution and rollback on audit insertion failure.
- Schema-17 upgrade and rerun tests preserve existing payment, journal and ledger rows byte-for-byte as JSON snapshots and keep ordinary users interactive.
- JavaScript syntax, diff whitespace, OpenAPI internal references/unique operations and documentation links checked. These contract checks are structural; client acceptance and a full external OpenAPI validator are not launch evidence yet.

## Remaining risks and next gate

Production use still needs the supported HTTPS proxy, capacity measurements, monitoring/alerts, backup restoration and client pilot acceptance. Defensive limits are initial defaults, not performance commitments. Schedule cleanup daily and monitor audit/reference table growth; do not purge permanent reference records during ordinary retry cleanup. Scope changes and website/API cache coherence across multiple replicas require verification before expanding deployment topology.

Next phase: scoped master-data/stock/invoice reads, permitted sales selectors, pagination/filter isolation and public serializers. The user requested a review before proceeding beyond this phase. No existing payment schema/workflow change is needed or approved; any future such change requires explicit approval. Future multiple-invoice allocation remains a separate design extension.
