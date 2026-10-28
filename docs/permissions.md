# Permissions and voucher visibility

Order, Taff Kla Order, DDR Shortage, and DDR Excess use the existing Stock Entry permissions and source/target warehouse restrictions. All four are transfers; the DDR labels do not grant stock gain/loss posting rights.

Submitting a saved stock entry from its preview or drawer requires Stock Entry Submit and the existing source ownership/warehouse scope checks. Edit permission is not required to submit saved values; the submit endpoint ignores editable fields supplied in its request. Cancellation entries additionally require Stock Entry Cancel. Only draft entries can be submitted.

Stock entry **Duplicate** requires both Stock Entry Read and Create. Existing source-voucher ownership, warehouse, and supplier scope restrictions apply. It opens an unsaved copy and does not require Edit on the original. Saving and submitting the copy enforce the usual Create and Submit permissions and stock validation. Cancellation entries and stock reconciliations cannot be duplicated through this action.

The browser invoice stock-preview batch (`POST /api/invoice-stock-balances`) uses the same action permissions as the existing single-stock lookup: Warehouse Read, Sales Create, Purchase Create, Purchase Order Create/Edit, or Stock Entry Create/Edit. Every requested warehouse must be permitted; a forbidden warehouse rejects the whole batch before any balances are read. This read-only endpoint accepts up to 200 item/warehouse entries per request and grants no posting rights. Existing browser session and cross-origin request protections apply; it is separate from the versioned integration API.

## Transaction maintenance

**Settings → Maintenance is Admin-only.** Backup creation/download and reset routes cannot be granted through custom role permissions. The backend checks that the administrator is active, is not an API service account, and is not awaiting a password change. Backups belong to their creating administrator and selected scope. Reset requires the current administrator password, a session-bound confirmation token, the exact phrase `RESET TRANSACTIONS`, and a fresh verified backup. Password attempts are limited to five per 15 minutes. Resetting ends website/mobile sessions and revokes integration tokens while retaining users, roles, permissions, and existing API audit history.

## Browser sign-in protection

Browser sign-in is independently throttled using PostgreSQL-backed, hashed IP and
username counters. The fixed 15-minute limits are 20 attempts per IP and 5 per
normalized username; rotating one does not reset the other's budget. Attempts
reserve a slot atomically before password verification, including across app
instances. Successful sign-in clears only that username's counter. Blocked logins
return HTTP 429 with `Retry-After` and issue no session. Limits survive app restarts;
expired rows are eligible for the existing rate-window cleanup. Browser and API
login counters use separate namespaces and grant no additional record permissions.

## Versioned API access

Mobile API requests resolve the user's current role, overrides and restrictions independently of browser sessions. Temporary-password sessions can only change their own password or log out. Integration credentials belong to dedicated non-admin accounts, expire after 90 days, and narrow account permissions through allowlisted scopes. Deactivated accounts, revoked/expired tokens and service accounts promoted to Admin are denied. Dedicated service accounts cannot use website/mobile password login, including after a password reset.

Credential creation, metadata listing, replacement issuance and revocation require a mobile Admin session; integration tokens cannot administer credentials. Standard ownership and employee exceptions remain unchanged. Shared sales policies check action permissions, credential scopes, customer/warehouse/price-list visibility and receiving-account access, including before saved retry responses are replayed. Financial policy checks use their posting connection and lock current user/role and credential/session state until commit; revocation and role changes take effect after any preceding authorized transaction finishes. Current creator/employee, customer, warehouse and price-list visibility is checked again on stored invoice rows, including creation replay after a website edit.

| Financial API operation | Account permission | Additional integration scope and record checks |
| --- | --- | --- |
| Create draft | `vouchers.sales.create` | `invoices:create`; permitted customer category, warehouse, price list, invoicer and optional cost center |
| Submit invoice | `vouchers.sales.submit` | `invoices:submit`; current parent ownership/employee and customer/warehouse/price-list access |
| Record one-invoice receipt | `payments.sales.record` | `payments:record`; current parent access plus permitted receiving account |

Mobile users need the account permission and record checks without integration scopes. Mutation permissions do not implicitly grant invoice Read, general employee Read or account Read. Hidden/missing parents return 404; forbidden actions or reference assignments return 403. Active-record and business-state checks apply to new effects; committed replay rechecks current access without requiring historical references to remain active. Temporary-password, revoked and expired credentials cannot perform or replay these operations.

See [API authentication and credential administration](api/README.md). No new payment allocation permissions, rate override policy or existing payment-table constraints were introduced.

Operational telemetry and recovery tools add no public metrics or audit-edit endpoint and grant no new account permissions. Operators need restricted deployment/log/database access. `API_V1_ENABLED=false` makes the API unavailable to every credential with JSON 503; it does not grant/bypass permissions, revoke credentials or affect website access. Re-enable only after reconciling any preceding operations. Existing permission and replay checks remain in force.

Local staging seeds an Admin and a restricted sales role/user in its separate database only. Retail customer, warehouse, price-list, Cash-account and employee/cost-center assignments narrow its access; staging integration credentials add scope restrictions. Hidden synthetic records/accounts are used for denial checks. These test accounts/role definitions do not modify working-app permissions. See the [local staging guide](api/local-staging.md) for credential handling and access evidence.

## How access is decided

1. Each user has one role. Roles grant actions on voucher types, master lists, payments, accounts, and reports. The built-in roles are Standard, Privileged, Admin, Retail, Wholesale, Finance, Logistics, and Management. Retail, Wholesale, Finance, Logistics, and Management start with the same permission set as Standard; an admin can edit role permissions in **Settings → Roles**.
2. An admin can adjust a user's effective permissions in **Settings → Users**. User grants add to the role permissions, and user denials remove them. A denial wins when a permission appears in both places. Admin has full access to all voucher types, regardless of creator, selected scopes, assigned records, or saved permission denials. This includes voucher lists, reports, exports, payments, and HR vouchers. Voucher status, stock, accounting, and dependent-transaction validation rules still apply.
3. A user's permitted records narrow which named records they can use or view. **Settings → Users** provides Warehouse, Cost Center, Employee name, Retail Price list, and Wholesale Price list assignments. Assigned values are stored in `app_users.record_access`; the related named Read permissions are added to the user. Customer group, supplier type, price list, warehouse, and account scopes can narrow access further.
4. The application checks both the action permission and the record scope on each request. A menu link or a report permission alone does not grant access to a voucher outside the user's scope.

The Roles and User Permissions pages offer every active, submitted price list as a permission type, including buying lists such as Standard Buying. The Read action allows use of the list where its buying or selling direction, currency, and the voucher workflow permit it. Listing a price list as a permission type does not make an inactive or incompatible list usable in a voucher.

Role permissions are defined in [`src/auth.js`](../src/auth.js). User record assignments are defined in [`src/user-record-access.js`](../src/user-record-access.js). Request checks are in [`src/authorize.js`](../src/authorize.js), and named record scopes are in [`src/access.js`](../src/access.js).

## Standard role voucher rule

Standard users can see a voucher when its `created_by_user_id` matches their login. For a **sales invoice**, they can also see it when `invoicer_id` matches the employee assigned to their user. These are alternative ways to qualify: a Standard user can see an invoice they created or one assigned to their permitted employee. Purchases, purchase orders, stock entries, stock reconciliations, and journals use the creator login because they have no employee assignee field. The Purchase Invoice purchase-order selector applies ownership, supplier-category, and warehouse restrictions before selecting its newest 100 receivable orders. Every nonempty line warehouse must be permitted, including lines already received; access is checked again when an order is used.

The rule applies to voucher lists, voucher reports and CSV exports, direct detail/edit/action URLs, linked payment pages, stock entry cancellation lookups, stock ledger and movement details, gross profit, and journal reference suggestions. Other roles keep their existing role permissions and record scopes.

The Sales Invoices browser list applies warehouse assignments, selected warehouse scopes, and named warehouse denials before pagination and counts. Every nonempty line warehouse must be permitted; a mixed-warehouse invoice is hidden if any line is restricted. Payment links and drawers resolve their parent invoice and enforce its creator/assigned-employee ownership, customer-category scope, and warehouse restrictions for every non-admin role. Knowing a payment ID does not grant access to a hidden parent invoice. Admin retains full record access.

The Journals list, report, detail, and drawer require Account Read access to every line account, including for the journal creator. Standard users must also own the journal. A denied detail or drawer request explains whether Journal Read, ownership, or line account access is missing. The creator can see the restricted account codes in that error.

Voucher ownership comes from the record audit fields, which stamp `created_by_user_id` when the voucher is created. A historical voucher with no creator user ID is not treated as owned by a Standard user. A historical sales invoice can still be visible if its `invoicer_id` matches the user's assigned employee. Editing a voucher does not change its creator. The rule is implemented in [`src/voucher-ownership.js`](../src/voucher-ownership.js).

Daily Activity retains its existing restriction for Standard users, including its ERPNext reference view. Debtors remains unavailable to Standard users because it does not reliably map every displayed voucher to an owner. A Standard user with General Ledger Read can open General Ledger, but sees entries only from their own vouchers (or sales invoices assigned to their employee) and permitted accounts. Payment entries follow the ownership of their parent invoice or purchase. Historical entries without a verifiable owner are excluded. If customer or supplier categories are selected for the user, the ledger also filters sales and purchase entries to those categories and omits journal and stock entries. The scoped sales, purchase, purchase order, journal, stock ledger, stock movement, and gross profit reports remain available when the user's action permissions allow them.

## Example

If Isa Kagabu is the permitted employee for a Standard user, that user can open a sales invoice they created, or an invoice whose invoicer is Isa Kagabu's employee ID. They cannot open a purchase order created by another login, even if they have the Purchase Order Read permission.

Assigning an employee also prefills that employee as the invoicer on a new sales invoice. The user can select another valid invoicer where their other permissions permit it, but that does not make the resulting invoice visible to a different Standard user unless the other user created it or is assigned as its invoicer.

## Stock balance downloads

Downloading Stock Balance CSV requires Stock Entry Read (`vouchers.stock.view`), the same permission used to open Stock Balance.

The ERPNext Stock Balance tab (`GET /stock/erpnext`) and its Excel/PDF downloads (`GET /stock/erpnext/export`) also require Stock Entry Read. Downloads require at least one selected warehouse and apply the same warehouse checks and item filter to all exported rows. Warehouse assignments, named grants, scopes, and denials filter the ERPNext warehouse selector. Every selected warehouse is checked before reading balances; an unpermitted warehouse returns HTTP 403. This read-only tab uses the configured ERPNext service user's Read access to Warehouse, Bin, and Item, and does not grant stock posting or editing rights. Sharing an individual stock entry does not grant access to this tab.

## Journal invoice allocations

Journal purchase invoice row references use the selected supplier and the same voucher ownership restrictions as the journal reference picker. An inaccessible invoice cannot be allocated by entering its number manually or by submitting an older draft.

## Stock reconciliation count sheets

Downloading an Excel count template requires Stock Entry Read, Create, or Edit. Uploading requires Create for a new reconciliation, or Edit for an existing draft. A saved voucher must satisfy the user's ownership rules and match the selected permitted warehouse. Both actions require an active permitted warehouse; supplier scope restrictions on reconciliations continue to apply. Uploads only populate the form and do not grant Save or Submit permission. Existing valuation-rate restrictions remain in force.

## Scanned reconciliation sheets

Listing and downloading scanned stock sheets requires Stock Entry Read or Edit; uploading or removing scans requires Stock Entry Edit. Every attachment request also checks ownership of the reconciliation voucher, permitted warehouses, and the existing supplier-scope restrictions. Attachments cannot be accessed through another voucher's URL. Attachment changes are permitted on saved reconciliations regardless of status and do not grant permission to edit submitted count rows or post stock.

General Ledger CSV, Excel, and PDF downloads require General Ledger Read permission and preserve the report’s ownership, account, and customer/supplier scope restrictions. Downloads include only the rows accessible to the current user.

When both HR payroll and employee-money ledger access are denied, HR entries remain excluded. Assigned HR employee or cost center restrictions do not block the user's permitted non-HR General Ledger rows; the existing ownership, assigned-invoicer, account, and party-category restrictions still apply.

Ordinary owner-scoped General Ledger pages can use transactionally maintained
ownership records and daily balances. These do not add grants: source ownership
and assigned invoicer membership retain their existing meaning, overlapping
membership does not duplicate entries, and cancellation entries retain source
ownership. Category/account access lists and HR grants retain detailed permission
matching. User access changes are evaluated on the next request. The controlled
database runtime can read the new derived tables; their maintenance runs through
schema-owner trigger routines rather than runtime table writes.


## HR permissions and visibility

HR has independent permission types under the **HR** group in role and user permission tables. New non-admin built-in roles, including Privileged, receive no HR access by default. Existing roles retain their existing grants; Admin continues to have full access. Employee master Read and journal permissions do not imply access to HR payroll or employee-money records.

| Permission type | Available actions and meaning |
| --- | --- |
| HR Employees | Read opens profiles and downloads employee details PDFs including personal details, family contacts, education, work history, and references; Write updates these details along with employment dates, manager, branch, employment type, and cost center. Status, Department, Position, Telephone, and Email additionally require Employee master Write and access to that employee master record. These master fields are disabled without Employee master Write. The shared employee directory also accepts HR Employees Read, applying employee and cost-center restrictions. New employee creation requires Employee master Create; adding HR details also requires HR Employees Write. Core profile fields, including name and company, require both HR Employees Write and Employee master Write. Existing master edit links open the comprehensive profile for HR readers; users without HR Read retain core-only master editing. The quick Active/Left switch requires Employee master Write; Submit/Cancel no longer controls employee employment status. |
| Attendance | Read lists records; Create saves individual/bulk drafts; Submit confirms attendance; Cancel voids records. |
| Leave | Read shows requests/balances; Create saves requests; Write sets annual allocations; Submit approves; Cancel voids requests. |
| Employee Money | Read shows employee obligations and payment history; Create saves drafts; Submit approves and posts recoveries/reimbursements; Cancel voids transactions or reverses their payments. |
| Employee Money Payment | Create records advance/loan disbursements, reimbursements, and cash returns/repayments. It is separate from creating the underlying request. |
| Payroll | Read shows permitted pay plans, payroll runs, payslips, and CSV exports; Create prepares runs; Write saves dated employee pay plans and reviews draft slips; Submit approves/posts runs; Cancel reverses payments and runs. |
| Payroll Payment | Create records salary payments against posted payslips. |
| HR Settings | Read shows calendars, leave types, and mappings; Write configures them. |

Employee details PDFs require HR Employees Read and access to the employee. Pay-plan history is included only with Payroll Read and uses the same account visibility restrictions as the profile.

Give users Read alongside the actions needed for a workspace. Pay-plan editing from an employee page also needs HR Employees Read and Payroll Read. Recovery selection needs Employee Money Read. Salary and account/payment permissions remain separate even when one user performs several roles.

Payslip **Employee Money summaries**, including browser print/PDF output, require Employee Money Read in addition to access to the payslip. Payroll Read alone does not expose extra employee balances. Each loan, advance, charge, or reimbursement row must pass employee, balance-account, offset-account, and cost-center checks against both its captured scopes and the current transaction scopes. Totals include only visible rows. Raw saved summaries are excluded from payroll registers, lists, and payslip data; only the permitted summary is supplied to the payslip screen. Posting saves all eligible balances for the employee independently of the submitter's Employee Money Read permission, without granting that submitter read access to them.

HR applies existing employee and cost-center assignments/named grants and denials, and account scopes. It checks both current employee scope and stored voucher cost centers where applicable. A whole payroll run and its export require access to every employee and every component/payable account; an individual payslip requires only that slip's employee and accounts. Assign an employee in Settings → Users and grant Payroll Read for restricted payslip access. A user's employee assignment is configured by an administrator, not inferred from ERPNext names or logins.

Non-admin users cannot approve their own leave or employee-money requests. They cannot post payroll they created or last edited. Admin can approve directly. Submitted transactions are immutable, and cancellations enforce dependent payment/recovery rules. Unknown HR paths and unsupported methods are denied by the central route classifier.

General Ledger and its CSV/Excel/PDF exports additionally enforce Payroll Read for payroll accruals/payments and Employee Money Read for employee-money accruals/payments, plus HR employee/cost-center scope. Without that HR grant, the new HR rows are excluded from the detailed ledger and party suggestions. Financial statements continue to include the accounting totals. Generic journal reference copying excludes HR vouchers to keep settlement within the HR allocation workflows.

Employee suggestions for new user defaults and employee permission rows offer only Active, enabled employees. Existing defaults and employee permissions remain effective when an employee leaves; status filtering in suggestions does not revoke access to historical records.

## Daily Activity creation

Daily Activity has separate Read (`reports.daily-activity.view`) and Create (`reports.daily-activity.create`) actions in the Reports permission table. Opening the New form or saving a local draft requires both. Read alone does not permit creation. Admin has both automatically; grant Create explicitly to other existing roles or users. Standard users retain the existing Daily Activity restriction, including the reference view. The local form, save route, list, totals, and details apply assigned cost-center and warehouse restrictions. Drafts are saved in PostgreSQL and audited under the app user who created them. No ERPNext credentials or permissions are needed to create local drafts. The separate ERPNext reference view uses the configured API user's Read access. This flow does not grant edit, submit, cancel, or delete access.

### API invoice display metadata

The existing invoice read permission and parent visibility checks also gate company display information, customer snapshot phone and record/item tracking display names/timestamps. Payment account visibility checks run before account names, notes and tracking data are serialized. No additional role, endpoint or permission is introduced. Internal actor IDs and company audit metadata are not returned.

Mobile transaction buttons follow existing `vouchers.sales.create`, `vouchers.sales.edit`, `vouchers.sales.submit` and `payments.sales.record` permissions. The API repeats current permission, ownership and reference checks inside each transaction. Draft-edit requests use the `invoices:create` integration scope plus sales Edit; existing grants are not expanded. Mobile master selections and receiving accounts retain existing lookup and record restrictions.

Mobile invoice Add items now uses a persistent search window with item name/code, positive warehouse balance, selected price-list rate, Qty and Add. Adding keeps the window open; Close returns to the invoice. `/api/v1/items?warehouse=...&price_list=...` filters positive balances before counting/pagination and returns only balance/warehouse plus the existing public item fields. Warehouse access and stock lookup permission apply; integration credentials also require stock:read. Cost and valuation fields are not added.

The stock reconciliation **Photo Count Rpt** sub-tab and its photo downloads use Stock Entry Read or Edit, with existing voucher ownership and warehouse restrictions. Saving auditor/verified quantities and uploading photos requires Stock Entry Edit, including on submitted and cancelled reconciliations.

General Ledger related-voucher scope and View posting retain all existing account, ownership, customer/supplier category, and HR restrictions. Related-voucher discovery requires an accessible party-bearing line; displayed related lines are independently access-filtered. Posting drill-down clears report filters, not permissions. Customer receivable and supplier payable summaries use the same access restrictions.

Supplier payment journals generated from purchase invoices retain the purchase invoice ownership and supplier-type scope in ledger reports. Recording and cancelling these payments uses the purchase payment permissions; opening their linked journals requires journal view permission.

Purchase invoice payments use the same permitted active Cash and Bank asset accounts as sales invoice payments. The Account dropdown applies the user’s account restrictions, and recording a payment rejects an account outside those permissions.

### Warehouse count and correction permissions

Controlled inventory adds explicit `inventory.count.view`, `.start`, `.save`, `.review`, `.approve`, `.reject`, `.submit`, and `.abandon` capabilities, plus `inventory.correction.view`, `.create`, `.approve`, `.submit`, and `.abandon`. Assign these through role extra permissions; existing Stock Entry permissions do not implicitly authorize count approval. Warehouse access still applies. Count views cover permitted warehouse sessions, including sessions prepared by other users. Supplier-scoped roles retain the stock-screen restriction. Count-session supporting sheets/photos use count View/Save permissions and warehouse access, so independent reviewers can inspect another preparer’s evidence. Legacy reconciliation attachment screens retain their existing Stock Entry view/edit and ownership rules.

A non-administrator approving a count must be a different person from its preparer and must not have entered counts or changed evidence. Administrators may approve their own count. Corrections always require a different approver. Material evidence changes invalidate approval and advance the count revision. Final submission revalidates the active account, current permissions, warehouse access and approved revision inside the transaction. Correction accounts and receivable/payable parties are checked at preparation, approval and submission.

Administrators can perform all count actions, including self-approval of reconciliations, but cannot bypass a warehouse freeze, backdate inventory timestamps, reopen closures, cancel closed originals, or reset controlled inventory. The provisioned database runtime login is a non-owner with read-only access to stock/control records and narrowly granted posting routines. Schema owners, database superusers and infrastructure recovery operators remain a separate trust boundary; never give their credentials to application users.

Reconciliation workspace sub-tabs at `/stock/reconciliations/counts` and `/stock/reconciliations/corrections` use the same explicit `inventory.count.*` and `inventory.correction.*` permissions as the compatible older routes. Stock voucher permissions do not grant count approval or correction rights. Independent reviewers open REC references through the Counts sub-tab, subject to warehouse access.

The count-scoped item autocomplete (`/stock/reconciliations/counts/:id/items`) requires Count View and access to the count's warehouse. It returns active submitted item codes/names and the warehouse valuation rate (or item unit cost fallback).

**Add found item** requires Count Save, uses the count's current revision and warehouse access, and cannot replace an existing count line.

Count Save permits importing a completed Excel template into any unfinished count, including one awaiting review or approved. Import clears approval and returns it to Counting atomically; Count Reject is not required for this import. Approval is required again before submission; non-administrators still need an independent approver.

Administrators may prepare, save, review, approve and submit the same reconciliation. The self-approval restriction applies to non-administrators. Administrator edits during review or approval clear approval and return the count to Counting; a current approved revision is still required for submission. This exception applies to reconciliation counts, not correction self-approval or closed-history immutability.

## Stock entry delivery and sharing

Only the original creator (`created_by_user_id`) or Admin can grant, change or revoke sharing. Choose **Read-only** (`read`) or **Read & write** (`write`). Sharing management requires Stock Entry Read and the normal owner/warehouse/supplier access checks. Custom roles with broad access to other users' vouchers cannot manage sharing unless they own the entry. Historical entries with no creator can be shared only by Admin. The service checks ownership in a transaction while locking the entry.

Both share levels grant record-specific access to detail, drawer, and the signed-in recipient's Shared stock entries list, overriding ordinary Stock Entry Read, creator, warehouse and supplier restrictions only for the shared entry. The shared list filters by the current recipient before search and pagination and shows their access level. Reconciliations cannot be shared. Shares do not grant general stock balances, master lookups, reports, integration API access, duplication, submission, cancellation, deletion, posting-time edits or onward sharing. Existing independent role access remains valid.

Read & write additionally grants the draft edit screen and saving that draft (`action=save_draft`), including delivery status. Existing warehouses and cost center may be retained; newly selected warehouses and cost center must be permitted for the recipient. Reconciliation/cancellation conversion and posting through a shared draft-save request are rejected. Saving checks the current write grant inside the transaction and locks it until commit; invalid input, downgrade or revocation rolls back voucher changes. Submitted quantities and rates remain immutable.

The owner, Admin or a Read & write recipient can update delivery status through its main field on draft and submitted previews, including after inventory closure. The dedicated delivery action needs no Stock Entry Edit or Submit permission; ordinary owner/Admin access requires Stock Entry Read, while an explicit write share authorizes only that entry. Cancelled entries reject delivery/item changes but permit sharing changes. New and draft forms also save delivery atomically with the entry under the relevant Create/Edit/Submit permissions, or shared draft-write permission. Unauthorized editors see a disabled delivery field.

All shared entry, drawer and edit responses use private, no-store caching. Each subsequent request checks the current share level; downgrading to Read-only removes shared write access and revoking removes shared access, without removing independently granted role access. Inactive and API-only accounts cannot receive new shares; inactive users cannot sign in. Owners and admins already have access and are omitted from the recipient picker.

Delivery metadata is separate from inventory documents so changing it never rewrites posted document, stock or accounting history. Duplicates inherit neither delivery nor shares. Deletion cascades these records; authorized transaction resets include them. Migration 40 preserves existing shares as Read-only.
