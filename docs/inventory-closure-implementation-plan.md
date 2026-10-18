# Warehouse stock count and inventory closure implementation plan

Status: implemented in schema 33 and locally activated on 17 October 2026. The original design below is retained as the implementation/review record; current user behavior and operating instructions are documented in docs/app-guide.md, docs/permissions.md, README.md and the API specification. Full isolated PostgreSQL verification passed 333 tests without skips, followed by focused enabled-policy and restricted-runtime checks. No physical count or warehouse closure was started during deployment.

Delivery notes: source/control mutations are guarded centrally and by restricted database routines; ordinary inventory timestamps are server-generated. Corrections support reviewed signed net-discrepancy absorption or actual current physical movements. Unposted corrections can be abandoned with an audit reason to release reservations. Inventory-account journals without a controlled posting event and inventory-mapping changes are prohibited. Schema-owner credentials remain an infrastructure trust boundary and should be isolated to a migration environment in production.

## 1. Business-rule review and recommended interpretation

Adopt the user's twelve-point business rule, with these explicit interpretations:

1. Scope is the entire warehouse, including items omitted from a reconciliation, zero-difference items, and items created later. An item-specific reconciliation cannot close the entire warehouse without a complete warehouse count.
2. A closed historical period includes the cut-off instant: movement timestamps must be strictly greater than the latest warehouse cut-off. Warehouse scope does not replace company-wide financial-period controls.
3. Draft documents may be created and edited because they create no inventory movements. Their entered dates cannot determine inventory posting timestamps. Pending drafts are reviewed before counting; confirmation that physical movements are fully recorded is an accountable operator attestation, not something software can establish from drafts alone.
4. The count's effective cut-off, approval time, and actual reconciliation posting time are distinct audit facts. Only the reconciliation associated with the active count may post its adjustment at that count's cut-off. Ordinary users cannot invoke this exception.
5. Approval applies to an exact revision of the complete counts, discrepancies, rates, value effects, and supporting evidence. Any change to that material invalidates approval. Approval by a different person from the preparer is recommended and is a release requirement in this plan.
6. Closed original vouchers and their stock-affecting fields/status remain unchanged. A current-period correction is a new linked document, not cancellation or amendment of the closed original.
7. A failed reconciliation submission commits neither stock changes nor a closing boundary. Its count remains frozen for retry. Explicit, authorized abandonment releases the freeze without advancing the boundary; an abandoned count cannot later be submitted or reused.
8. No application administrator can override these controls. Database superusers, host administrators, and backup operators remain infrastructure trust boundaries; PostgreSQL cannot prevent its own superuser from removing protections. Separate runtime and migration credentials are therefore required.

## 2. Count lifecycle and operating procedure

Recommended lifecycle:

`counting -> awaiting_review -> approved -> submitted`

`awaiting_review -> counting` on rejection, and `approved -> counting` when approved material changes. Any unsubmitted state may become `abandoned` through an authorized, reasoned action. Submitted and abandoned states are terminal. The warehouse remains frozen throughout every active state, including after a submission error.

Before Start count, staff stop physical movements, submit all preceding transactions, resolve receipts/dispatches in progress, and confirm readiness. The app displays pending drafts and relevant incomplete documents for review. Do not automatically submit or delete them.

Start count is one short database transaction:

- Check warehouse access and count-start permission.
- Lock its persistent inventory-control row, waiting for already-running postings to finish.
- Refuse a second active count, invalid warehouse, or unsupported future-dated inventory history.
- Generate the cut-off from the database clock after locks are acquired. It must be later than the warehouse's last inventory timestamp and previous closing boundary; refuse an inconsistent clock rather than inventing a future timestamp.
- Capture the complete book quantity/value/rate snapshot and ledger high-water mark, record the readiness attestation and actor, and activate the count freeze.
- Commit before physical counting begins. Never hold an open database transaction during the physical count.

During counting, permit count entry, evidence upload, and review, but reject ordinary stock movements affecting the warehouse. Physical movement control remains an operating responsibility. If goods move, invalidate and abandon the count before restarting the controlled process.

Require explicit counts for every snapshot item requiring counting, including an explicit zero for missing stock. Permit found items with zero book quantity after validating item identity. Never silently treat an omitted row as zero or assume the remaining stock is correct. Preserve the snapshot even if a master item later becomes inactive.

At final submission, recheck permissions, active-session identity, revision, completeness, approval, and snapshot consistency under lock. Calculate differences from the frozen snapshot, post quantity/value/GL effects, record the immutable closing event, advance the boundary, mark the count submitted, and release the freeze in one transaction. Zero-difference reconciliation must still create a closure. Any error rolls everything back.

## 3. Data model and migrations

Add versioned PostgreSQL migrations through `src/migrate.js` and matching clean-install schema definitions in `src/domain/schema.js`.

| Record | Required data and constraints |
| --- | --- |
| Warehouse inventory control | Stable warehouse identity, active count ID, latest closed-through timestamp, last inventory timestamp. One row per warehouse; warehouse rename/disable/recreation cannot remove or reset its history. |
| Count session | Warehouse, server cut-off (`timestamptz`), lifecycle state, revision, readiness attestation, preparer, reviewer, approval revision/digest, approval/abandonment/submission timestamps and reasons, unique final reconciliation link. |
| Count snapshot and lines | Item identity, frozen book quantity/value/rate, ledger high-water evidence, entered physical count, discrepancy, proposed valuation effects, counted/recounted actors, and count revision. |
| Closure events | Append-only warehouse/cut-off/count/reconciliation/approval linkage and actors. Boundaries advance monotonically and cannot be deleted or reduced. |
| Inventory posting events | Voucher identity, canonical server posting timestamp, operation type, affected warehouses, correction/count linkage, and stable operation identity. One event per controlled posting/reversal; all its movements share the event timestamp. |
| Correction references | Original document/count reference, reason, evidence, financial treatment, inventory treatment and quantity allocations, reviewer, and stable source identity preventing duplicate application. |
| Count audit events | Append-only lifecycle, line revisions, review/rejection, approval invalidation, abandonment, and final submission events. |

Add a canonical `movement_at timestamptz` and posting-event reference to stock ledger rows. Preserve legacy date/time fields and historical records. Distinguish `movement_at` (effective stock instant) from actual recorded/submitted timestamps.

Use database-clock precision, store UTC, and display Africa/Kampala with sufficient precision to identify the boundary. The current `src/posting-time.js` normalizes to minutes and is unsuitable as the authority for this rule. Do not globally change unrelated payment, HR, or journal timestamps.

## 4. Central posting transaction and concurrency

Create a shared inventory posting service, for example `src/services/inventory-posting.js`, used by every inventory writer. Refactor entry points to acquire warehouse controls before stock balances or other competing inventory locks; inserting a check only after existing locks risks deadlocks.

For an ordinary posting:

1. Resolve the complete affected warehouse set from the actual voucher lines, including both sides of transfers and multiwarehouse invoices.
2. Lock all warehouse-control rows in a stable global order. No stock balance is changed before these locks are held.
3. Reject any active count. Revalidate saved voucher lines/references after locking so the warehouse set cannot change unnoticed.
4. Create one server-timestamped posting event using `clock_timestamp()` after lock acquisition, rather than PostgreSQL `now()`, which reflects transaction start and may precede a lock wait.
5. Require its timestamp to exceed every affected warehouse's closing boundary and last posting timestamp. Fail safely and retry on clock regression/equality; clients cannot provide a replacement timestamp.
6. Run existing quantity, valuation, dependency, permission, and accounting checks. Keep historical stock protection for legacy data and special effective-dated count adjustments.
7. Post all movements, balance updates, voucher effects, financial effects, audit, and API retry records atomically; update each warehouse's last posting timestamp in the same transaction.

Both positive and negative movements are covered. Multiwarehouse vouchers are all-or-nothing. Count start, approval/submission, abandonment, corrections, and ordinary posting use the same warehouse locks. One active count per warehouse is enforced by database constraints as well as application checks.

Completed count adjustments use their recorded cut-off as effective `movement_at`, with a later server-recorded submission time. This special operation is restricted to the matching approved active session, posts before the boundary is advanced, and cannot accept an arbitrary requested effective timestamp.

A committed retry returns the original result without reapplying stock or timestamps. An uncommitted failed attempt does not reserve a historical timestamp for a later retry. Count actions need stable operation identities and uniqueness constraints as well as ordinary financial API idempotency.

## 5. Database enforcement and runtime privileges

Application guards provide understandable errors; PostgreSQL is the backstop.

- Inventory mutation must use controlled database routines that obtain warehouse locks, validate session/closure state, create authorized posting events, and write the ledger and balances together.
- Revoke ordinary runtime access to direct stock ledger/balance insert/update/delete/truncate, closure/control mutation, and submitted inventory source-record mutation. Route permitted writes through narrowly granted routines. Protect stock-affecting source fields, line replacement/deletion, status changes, and cascading foreign-key operations as well as ledger rows.
- Submitted ledger history, count snapshots, closure events, and closed voucher stock effects are immutable. Add constraints/triggers to reject prohibited amendments/deletions and invalid event linkage. Direct SQL through the runtime role must fail too.
- A caller-set session variable, `is_admin` flag, client timestamp, or reusable privileged switch is not proof of a valid count operation. Validate against locked durable state and revision-linked approval. Harden any `SECURITY DEFINER` routines with controlled ownership, fixed search path, restricted execute grants, and no unsafe dynamic SQL.
- Use a non-owner application runtime role that cannot disable triggers, change protected routines, truncate protected tables, or grant itself additional rights. Use separate migration/bootstrap credentials; current startup schema/backfill responsibilities must be split before claiming this boundary is enforced.
- Audit imports, repairs, scheduled work, maintenance, and CLI tools for direct SQL paths. Legacy load/repair fixtures must remain test-only and cannot be a production bypass.
- Block application transaction resets when any active count or permanent closure exists. Reset cannot erase or lower inventory closure history, including a zero-difference reconciliation. Update maintenance UI and database grants accordingly.
- Backup/restore requires privileged recovery procedures that verify closure history and known recovery point; do not describe restoration of an older backup as an ordinary way to reopen inventory.

An insert trigger alone cannot guarantee balanced postings or stop privileged history deletion. Treat the complete privilege and routine design as part of the feature, not optional hardening.

## 6. Corrections and prevention of double-counting

Provide a dedicated reviewed current-period correction workflow. Do not merely permit users to redate and resubmit a closed original or select an unrestricted “no stock effect” checkbox.

Example: book stock was 10, a dispatch of 2 was omitted, and the physical count of 8 was reconciled. That reconciliation has already removed the 2 units. Posting the forgotten sale with another stock issue would incorrectly leave 6.

The correction must link the forgotten document to the relevant reconciliation and record whether the physical movement was already absorbed in that count. If absorbed, it must not move stock again. Its financial treatment must account for inventory/expense effects already posted by reconciliation, with explicit reclassification where required. Existing ordinary invoice submission cannot be reused unchanged for this case.

Distinguish:

- A historical omitted event already absorbed in an approved count: reviewed documentary/financial correction with no duplicate inventory movement, bounded quantity allocations and duplicate-source prevention.
- An actual new receipt, dispatch, or return: a new current-period physical inventory movement, linked to the original where relevant.
- A wrong count: a later controlled reconciliation, preserving the earlier count and closure.

Original closed vouchers remain intact. Their normal Cancel/Edit actions must reject the operation and direct users to corrections. Corrections have their own status and audit trail. Financial reclassification and allocation invariants must be specified and tested before this workflow is enabled; do not auto-infer absorption from a matching item/date alone.

## 7. Permissions, UI, APIs, and reports

Add explicit warehouse-scoped actions for start count, enter/recount, request review, approve/reject, submit approved reconciliation, abandon, and prepare/approve corrections. Require a separate reviewer and transaction-local permission revalidation. Existing `vouchers.stock.*` access must not silently authorize the entire new lifecycle. Administrators may receive these capabilities but still cannot bypass lifecycle or history rules.

Update the reconciliation screen in `src/web/routes/stock.js` and associated views to expose lifecycle, fixed cut-off, frozen snapshot, completeness, discrepancies, approval evidence, and abandonment reasons. Reuse `docs/design-guide.md`, shared styles, and heading/helper partials.

Sales, purchase, stock-entry and transfer screens show whether a warehouse is counting and its latest closure. Ordinary posting timestamps become read-only and are finalized by the server on submission. Draft document dates remain separately labelled; the inventory preview says that final stock time is assigned on submission. Both transfer warehouses must be visible in blocking messages.

Provide consistent symbolic errors such as `warehouse_count_in_progress`, `inventory_period_closed`, `count_revision_not_approved`, `closed_voucher_immutable`, and `inventory_clock_conflict`. Include the permitted warehouse, count/reconciliation reference and cut-off where access allows. Return errors without partial voucher/stock/GL/idempotency effects. Retry replay must remain stable across a subsequent count closure.

Change website and API contracts together: inventory timestamps are server-generated, not silently accepted client posting instructions. Version or explicitly deprecate incompatible API fields and update mobile/integration consumers before enforcement. Document/reference dates remain separate. Existing timestamp filters and ledger exports use canonical movement timestamps for new records and clearly defined legacy fallback.

Review stock GL posting dates alongside inventory dates so inventory/GL reports remain consistent. Do not let a documentary-date change silently backdate stock-related inventory GL effects. Financial-only corrections follow the separately defined accounting policy.

## 8. Main code areas

| Area | Existing files / planned change |
| --- | --- |
| Schema, migrations, canonical time | `src/migrate.js`, `src/domain/schema.js`, `src/posting-time.js`; new count/control/posting-event schema and timestamp handling. |
| Shared movements and valuation | `src/domain/posting.js`; integrate centralized posting transactions and protected DB routines for every incoming/outgoing movement. |
| Count and reconciliation lifecycle | `src/domain/inventory.js`, new count service, `src/web/routes/stock.js`, reconciliation/count-sheet/photo/evidence modules and views. |
| Sales and cash sales | `src/domain/sales.js`, `src/services/sales.js`, financial validation/API contracts, sales routes and invoice UI; server inventory timestamps and closed-original restrictions. |
| Purchases and reversals | `src/purchases.js`; server movement timestamps, count guards, corrected reversal paths and financial consistency. |
| Stock entry/transfer/reversal | `src/domain/inventory.js`, `src/domain/posting.js`, `public/stock-entry.js`; both warehouses, all legacy entry types, no date bypass. |
| Stock availability and reports | `src/stock-transfer-availability.js`, `src/domain/master-data.js`, stock balance APIs, stock ledger/movement/valuation reports; canonical timestamps and freeze indicators. |
| Permissions and audit | `src/auth.js`, `src/authorize.js`, `src/access.js`, `src/audit.js`; count/reviewer actions and immutable lifecycle evidence. |
| Operations and maintenance | Startup/bootstrap, import/repair scripts, `src/transaction-reset.js`, maintenance routes; least-privilege runtime and no history-reset bypass. |

## 9. Delivery sequence and acceptance gates

Implement in dependency order. The complete posting enforcement must ship as one coherent release; do not activate warehouse freezes while some voucher paths can bypass them.

1. **Contract and migration design:** confirm the interpretations above, independently reviewed discrepancy approval, timestamp/document-date separation, correction accounting, and database privilege split. Produce migration and API compatibility specifications plus recovery/upgrade checks.
2. **Database foundation:** canonical timestamps, warehouse controls, count/snapshot/closure/event records, permissions, immutable routines and runtime-role grants. Backfill legacy canonical times deterministically from saved voucher date/time; preserve originals and document uncertain legacy precision.
3. **Central posting integration:** route every stock-affecting voucher, cancellation, transfer, API, import and automated task through the same warehouse locking and posting-event flow. Protect legacy direct-write paths, source records, and reset tools.
4. **Count lifecycle and UI:** start/freeze/snapshot, complete count entry, review/revision approval, atomic reconciliation/closure/reopen, abandonment, count sheets and evidence handling.
5. **Current-period corrections:** implement reviewed absorption/allocation and financial reclassification with unique source references and immutable originals. Until ready, reject closed-original cancellation/amendment rather than offering a stock-duplicating workaround.
6. **Client/report migration:** server-generated stock timestamps, explicit document dates, website/API/mobile compatibility, canonical inventory/GL reports and operational messages.
7. **Verification and rollout:** clean-install and upgrade tests, full local isolated PostgreSQL suite, concurrency/role tests, documentation, production-like rehearsal, backup, migration and startup verification. Rebuild with `docker compose up -d --build invoice-app` and verify the configured local HTTP endpoint before reporting an implemented release complete.

Existing submitted reconciliations must not automatically become closures: they lack controlled cut-off sessions, full-warehouse completeness and approval evidence. Preserve them as legacy records. Enable enforcement consistently for all warehouse inventory postings; establish the first permanent boundary through a new controlled physical count for each warehouse. Review existing future-dated or inconsistent history before activation instead of silently rewriting it.

Deployment requires preventing older app instances/workers from writing through obsolete paths during migration. Use a controlled local/production deployment sequence with migration credentials separated from the runtime account. A failed rollout must preserve active count freezes and all committed closures; do not roll back by dropping protections or lowering boundaries.

## 10. Required verification

- Every stock-affecting voucher and reversal, positive/negative/zero-difference, website/API/background/direct runtime SQL, obeys the same controls; administrators cannot override them.
- Count start racing with an invoice, receipt or transfer either includes the fully committed earlier posting in the snapshot or blocks that posting after freeze. Test with multiple app processes/database connections.
- Both warehouse locks are acquired in consistent order for opposing and multi-line transfers; no half transfer, partial GL, leaked freeze or deadlock loop.
- A transaction begun before the cut-off but acquiring posting locks afterward cannot use its transaction-start timestamp or saved draft timestamp to backdate.
- A closed original cannot be amended, cancelled, deleted, cascade-deleted, or have its lines/status/timestamps rewritten through runtime SQL or app routes.
- A full-warehouse closure protects unlisted/new/zero-balance items; incomplete counts fail, explicit zero counts work, and found items have approved handling.
- A changed approved count, value/rate, or material evidence invalidates approval; self-approval, stale permissions and stale revision submissions fail.
- Zero-difference reconciliation closes the warehouse exactly once. Repeated submit/retry/lost responses replay without duplicate adjustments or closure events.
- Failed reconciliation rolls back all financial/stock/closure changes and retains the freeze. Abandonment is audited, releases the freeze, advances no boundary, and permanently invalidates the count.
- Ordinary timestamps come from the database after locks, remain strictly after closures, preserve timezone/precision, and fail safely on clock regression or future-dated legacy conflicts.
- A forgotten dispatch already reflected in a count does not reduce stock twice; allocations/references cannot be reused or exceed absorbed quantities; accounting and inventory reconcile after corrections.
- Maintenance reset and ordinary imports cannot erase closures; runtime role cannot disable triggers or call unapproved mutation routines. Migration role capabilities are tested separately.
- Clean installation, legacy upgrade, API compatibility, stock/GL report totals, attachments/count-sheet revisions, and permitted desktop/mobile UI behavior remain correct.

Run JavaScript/template checks and meaningful unit tests in the local Docker image when host Node.js is unavailable. Run `npm run test:postgres` using the fresh ephemeral PostgreSQL database/internal-network/read-only-workspace/tmpfs-upload procedure in README.md. Never run schema-resetting tests against the app database.

Update `docs/app-guide.md`, `docs/permissions.md`, `README.md`, API specifications and relevant operations instructions in the implementing changes. Describe only delivered behavior in user guides; retain this plan's proposed status until all release gates are met.

### Subsequent implemented workflow changes

Excel templates can be imported into any unfinished reconciliation, including one under review or approved; import returns it to Counting and clears approval. Administrators may save, review, approve their own count and submit the approved revision. Non-administrators retain independent approval requirements. Submitted/abandoned records and historical warehouse closing boundaries remain immutable. These extensions use owner migrations 34 and 35.
