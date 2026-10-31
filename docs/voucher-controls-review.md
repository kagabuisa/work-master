# Voucher controls review and recommendations

**Application:** Work Master
**Review date:** 31 October 2026
**Status:** Implemented for Purchase Invoice, Journal, and Stock Entry backdate/cancellation approvals; proposal for the remaining vouchers. Recommendations are not live unless explicitly identified as existing or implemented controls.

Implemented now: Purchase Invoices, manual Journal Entries, and Stock Entries expose Backdate/Cancel requests, Admin-only approval, revision-bound invalidation, and immutable approval history. Purchase Orders reject future posting dates but do not yet have exception approvals. See [the app guide](app-guide.md#voucher-exception-approvals) for the live workflow.

## Purpose

Extend the sales invoice approach to other vouchers: clear request controls, restricted approval, server validation, and an audit trail. Use local application data and permissions; ERPNext is a design reference, not a runtime dependency.

The priorities are protecting closed history, preventing unauthorized reversals, and controlling exceptional dates, amounts, prices, and quantities. Limits should be configured per voucher type rather than copying sales invoice limits everywhere.

## Existing foundation

Sales invoices already have local Backdate/Cancel requests, approval permissions, reasons, revision checks, date limits, and minimum selling prices. Matching checkboxes open date/reason popups; selecting either disables the other. Requests and relevant date changes clear approval, and duplicates do not inherit approval.

With controlled inventory active, the app also protects warehouse freezes, permanent reconciliation cut-offs, historical stock availability, and later stock balances. Physical movements receive server timestamps. These protections must remain binding when new approval controls are added.

The findings below are based on the current code and app guide, not a test of every production configuration.

## Recommendations by voucher

| Voucher | Existing protections to retain | Proposed additions |
| --- | --- | --- |
| Purchase Invoice | Draft-only editing; case-insensitive duplicate supplier reference checks for the same supplier; stock/reconciliation checks; cancellation checks for linked supplier journals. | Role-based backdating windows, cancellation request and approval, and approval when purchase-order price or quantity tolerances are exceeded. Show the stock, payable, and payment effects before cancellation. |
| Stock Entry / Transfer | Draft-only quantity/value editing; controlled warehouse freezes and cut-offs; historical availability checks; cancellation reversals and recorded cancellation reasons. | Backdate/cancellation approval, restricted opening-stock creation, and approval thresholds for exceptional quantities or values. Transfers must satisfy both warehouses' restrictions. |
| Journal Entry | Balanced debit/credit checks; account-side and allocation checks; payment/parent dependencies; submitted-state restrictions. | Backdating and cancellation approval, mandatory correction reasons, and independent approval for large amounts or designated sensitive accounts. Balanced entries still need authorization. |
| Customer receipt / Supplier payment | Receiving-account access, invoice balance checks, and reversal history; integration payments have retry/reference protection. | Consistent date limits, cancellation request/reason/approval, payment amount limits, and duplicate-reference policy across browser and API entry points. Preview the balances that cancellation will reopen. |
| Purchase Order | Draft-only editing; cancellation blocked while submitted linked purchases exist. | Spending thresholds, price/quantity change approval, and cancellation reasons. Add an order-date policy only where needed; future expected delivery dates remain valid. |
| Payroll / Employee Money | Independent approval rules with existing Admin exceptions; dependent payment/recovery checks; payroll cancellation reason/date rules; immutable submitted records. | Amount-based authority, consistent cancellation requests, evidence for exceptions, and approval invalidation after material changes. Extend the existing HR workflow rather than adding a competing approval process. |
| Stock Reconciliation | Dedicated count, review, approval, and submission workflow; warehouse freeze; permanent closure; current-period corrections. | Preserve this workflow. Consider additional independent approval for large discrepancies. Do not introduce ordinary Backdate/Cancel overrides for submitted controlled counts. |

**Verified correction to the initial recommendations:** duplicate supplier invoice references are already rejected during purchase creation/editing. This should be retained, not treated as an entirely new feature.

## Accounting-period closure (implemented)

A local company-level accounting close is now implemented at **Accounts → Accounting Periods**, with Finance preparation and Admin approval/reopening. See [the app guide](app-guide.md#accounting-period-closure) for the implemented workflow. The remaining items below describe the original policy goals. Warehouse reconciliation protects stock history; an accounting-period close would protect reviewed financial periods across invoices, receipts, payments, journals, and payroll.

Proposed behavior:

- Store the closed period or cut-off, approving user, timestamp, and reason locally.
- Reject postings into a closed accounting period across every affected entry point, including generated journals.
- Define cancellation protection for original vouchers in closed periods, even when a user supplies a current reversal date.
- Route historical errors through reviewed corrections in an open period.
- Keep period-closing authority separate from routine posting and backdating authority.
- Do not let ordinary voucher approval override an accounting close or permanent warehouse cut-off.

An accounting close is distinct from freezing a single account and from transferring period profit. ERPNext's [Accounting Period](https://docs.frappe.io/erpnext/accounting-period) and [Freeze Accounting Entries](https://docs.frappe.io/erpnext/freeze-accounting-entries) describe these separate patterns. Their exception rules are references; Work Master's policy must be decided explicitly.

## Shared approval design

Use one local implementation for request history, permissions, revision checks, and approval status, with voucher-specific validation.

1. **Separate authority:** Request, Approve, and Execute are different permissions. An approval must not grant access to an otherwise hidden voucher or account.
2. **Require a reason:** Capture the requested action, selected date where applicable, and supporting explanation before accepting an exception.
3. **Prevent conflicting approvals:** Keep Backdate and Cancel mutually exclusive where that matches the voucher workflow. Monetary or purchase-order exceptions may need their own approval category.
4. **Bind approval to reviewed values:** Changes to relevant dates, amounts, accounts, parties, warehouses, quantities, or prices invalidate the corresponding approval. Reject stale approval revisions.
5. **Preserve independence:** Apply independent approval to designated high-risk actions. Decide and document any Admin exception separately; never infer one from the role name.
6. **Preserve history:** Record requester, approver, executor, timestamps, reasons, and reviewed values. Retain originals and reversal links. Copies start without inherited approval.
7. **Use the appropriate date rules:** Apply posting-date controls to actual accounting or stock postings. Allow legitimate future planning dates, including delivery dates and scheduled leave.

The existing compact checkbox/popup interface can be reused, but only expose actions that make sense for the voucher's state and the user's permissions.

## Performance and enforcement

The browser should provide immediate feedback and collect complete requests. The server must repeat authoritative checks on save, approval where relevant, and execution, including mobile/API operations.

Batch reference lookups and validation; avoid a separate network request per line or keystroke. Recheck approval revision, permission, voucher state, stock, and closure boundaries within the transaction that performs the action. A failed action must leave no partial stock, payment, or accounting effects.

## Suggested rollout

| Order | Work package | Intended outcome |
| --- | --- | --- |
| 1 | Accounting-period closure | Protect reviewed financial history across vouchers. |
| 2 | Purchase Invoice and Stock Entry controls | Restrict exceptional dates, reversals, and stock/value changes. |
| 3 | Journal and payment controls | Restrict sensitive postings and cash/bank reversals. |
| 4 | Purchase Order spending approval | Control commitments before purchasing. |
| 5 | HR and reconciliation refinements | Add thresholds without weakening existing workflows. |

Before each release, agree the role grants, limits, protected fields, and exception policy. Validate date boundaries, self-approval restrictions, stale requests, concurrent actions, duplicates/retries, dependencies, and closed-period behavior in an isolated local database. Update the user guides with implemented behavior and rebuild/restart the local app after checks pass.

## Implementation references

- [Current app workflows](app-guide.md)
- [Permissions and record visibility](permissions.md)
- [Sales controls](../src/sales-controls.js)
- [Purchase invoices](../src/purchases.js)
- [Purchase orders](../src/purchase-orders.js)
- [Stock entries](../src/domain/inventory.js)
- [Journals](../src/domain/ledger.js)
- [HR workflows](../src/hr.js)
- [Controlled inventory](../src/sql/inventory-control.sql)
