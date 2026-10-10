# Permissions and voucher visibility

## How access is decided

1. Each user has one role. Roles grant actions on voucher types, master lists, payments, accounts, and reports. The built-in roles are Standard, Privileged, Admin, Retail, Wholesale, Finance, Logistics, and Management. Retail, Wholesale, Finance, Logistics, and Management start with the same permission set as Standard; an admin can edit role permissions in **Settings → Roles**.
2. An admin can adjust a user's effective permissions in **Settings → Users**. User grants add to the role permissions, and user denials remove them. A denial wins when a permission appears in both places. Admin has full access.
3. A user's permitted records narrow which named records they can use or view. **Settings → Users** provides Warehouse, Cost Center, Employee name, Retail Price list, and Wholesale Price list assignments. Assigned values are stored in `app_users.record_access`; the related named Read permissions are added to the user. Customer group, supplier type, price list, warehouse, and account scopes can narrow access further.
4. The application checks both the action permission and the record scope on each request. A menu link or a report permission alone does not grant access to a voucher outside the user's scope.

The Roles and User Permissions pages offer every active, submitted price list as a permission type, including buying lists such as Standard Buying. The Read action allows use of the list where its buying or selling direction, currency, and the voucher workflow permit it. Listing a price list as a permission type does not make an inactive or incompatible list usable in a voucher.

Role permissions are defined in [`src/auth.js`](../src/auth.js). User record assignments are defined in [`src/user-record-access.js`](../src/user-record-access.js). Request checks are in [`src/authorize.js`](../src/authorize.js), and named record scopes are in [`src/access.js`](../src/access.js).

## Standard role voucher rule

Standard users can see a voucher when its `created_by_user_id` matches their login. For a **sales invoice**, they can also see it when `invoicer_id` matches the employee assigned to their user. These are alternative ways to qualify: a Standard user can see an invoice they created or one assigned to their permitted employee. Purchases, purchase orders, stock entries, stock reconciliations, and journals use the creator login because they have no employee assignee field.

The rule applies to voucher lists, voucher reports and CSV exports, direct detail/edit/action URLs, linked payment pages, stock entry cancellation lookups, stock ledger and movement details, gross profit, and journal reference suggestions. Other roles keep their existing role permissions and record scopes.

The Journals list, report, detail, and drawer require Account Read access to every line account, including for the journal creator. Standard users must also own the journal. A denied detail or drawer request explains whether Journal Read, ownership, or line account access is missing. The creator can see the restricted account codes in that error.

Voucher ownership comes from the record audit fields, which stamp `created_by_user_id` when the voucher is created. A historical voucher with no creator user ID is not treated as owned by a Standard user. A historical sales invoice can still be visible if its `invoicer_id` matches the user's assigned employee. Editing a voucher does not change its creator. The rule is implemented in [`src/voucher-ownership.js`](../src/voucher-ownership.js).

Daily Activity and Debtors reports remain unavailable to Standard users because those views do not reliably map every displayed voucher to an owner. A Standard user with General Ledger Read can open General Ledger, but sees entries only from their own vouchers (or sales invoices assigned to their employee) and permitted accounts. Payment entries follow the ownership of their parent invoice or purchase. Historical entries without a verifiable owner are excluded. If customer or supplier categories are selected for the user, the ledger also filters sales and purchase entries to those categories and omits journal and stock entries. The scoped sales, purchase, purchase order, journal, stock ledger, stock movement, and gross profit reports remain available when the user's action permissions allow them.

## Example

If Isa Kagabu is the permitted employee for a Standard user, that user can open a sales invoice they created, or an invoice whose invoicer is Isa Kagabu's employee ID. They cannot open a purchase order created by another login, even if they have the Purchase Order Read permission.

Assigning an employee also prefills that employee as the invoicer on a new sales invoice. The user can select another valid invoicer where their other permissions permit it, but that does not make the resulting invoice visible to a different Standard user unless the other user created it or is assigned as its invoicer.

## Stock balance downloads

Downloading Stock Balance CSV requires Stock Entry Read (`vouchers.stock.view`), the same permission used to open Stock Balance.

## Journal invoice allocations

Journal purchase invoice row references use the selected supplier and the same voucher ownership restrictions as the journal reference picker. An inaccessible invoice cannot be allocated by entering its number manually or by submitting an older draft.

## Stock reconciliation count sheets

Downloading an Excel count template requires Stock Entry Read, Create, or Edit. Uploading requires Create for a new reconciliation, or Edit for an existing draft. A saved voucher must satisfy the user's ownership rules and match the selected permitted warehouse. Both actions require an active permitted warehouse; supplier scope restrictions on reconciliations continue to apply. Uploads only populate the form and do not grant Save or Submit permission. Existing valuation-rate restrictions remain in force.

## Scanned reconciliation sheets

Listing and downloading scanned stock sheets requires Stock Entry Read or Edit; uploading or removing scans requires Stock Entry Edit. Every attachment request also checks ownership of the reconciliation voucher, permitted warehouses, and the existing supplier-scope restrictions. Attachments cannot be accessed through another voucher's URL. Attachment changes are permitted on saved reconciliations regardless of status and do not grant permission to edit submitted count rows or post stock.

General Ledger CSV, Excel, and PDF downloads require General Ledger Read permission and preserve the report’s ownership, account, and customer/supplier scope restrictions. Downloads include only the rows accessible to the current user.


## HR permissions and visibility

HR has independent permission types under the **HR** group in role and user permission tables. New non-admin built-in roles, including Privileged, receive no HR access by default. Existing roles retain their existing grants; Admin continues to have full access. Employee master Read and journal permissions do not imply access to HR payroll or employee-money records.

| Permission type | Available actions and meaning |
| --- | --- |
| HR Employees | Read opens profiles; Write updates employment dates, manager, branch, employment type, and cost center. Employee master creation/editing stays under its existing permissions. |
| Attendance | Read lists records; Create saves individual/bulk drafts; Submit confirms attendance; Cancel voids records. |
| Leave | Read shows requests/balances; Create saves requests; Write sets annual allocations; Submit approves; Cancel voids requests. |
| Employee Money | Read shows employee obligations and payment history; Create saves drafts; Submit approves and posts recoveries/reimbursements; Cancel voids transactions or reverses their payments. |
| Employee Money Payment | Create records advance/loan disbursements, reimbursements, and cash returns/repayments. It is separate from creating the underlying request. |
| Payroll | Read shows permitted pay plans, payroll runs, payslips, and CSV exports; Create prepares runs; Write saves dated employee pay plans and reviews draft slips; Submit approves/posts runs; Cancel reverses payments and runs. |
| Payroll Payment | Create records salary payments against posted payslips. |
| HR Settings | Read shows calendars, leave types, and mappings; Write configures them. |

Give users Read alongside the actions needed for a workspace. Pay-plan editing from an employee page also needs HR Employees Read and Payroll Read. Recovery selection needs Employee Money Read. Salary and account/payment permissions remain separate even when one user performs several roles.

HR applies existing employee and cost-center assignments/named grants and denials, and account scopes. It checks both current employee scope and stored voucher cost centers where applicable. A whole payroll run and its export require access to every employee and every component/payable account; an individual payslip requires only that slip's employee and accounts. Assign an employee in Settings → Users and grant Payroll Read for restricted payslip access. A user's employee assignment is configured by an administrator, not inferred from ERPNext names or logins.

Non-admin users cannot approve their own leave or employee-money requests. They cannot post payroll they created or last edited. Admin can approve directly. Submitted transactions are immutable, and cancellations enforce dependent payment/recovery rules. Unknown HR paths and unsupported methods are denied by the central route classifier.

General Ledger and its CSV/Excel/PDF exports additionally enforce Payroll Read for payroll accruals/payments and Employee Money Read for employee-money accruals/payments, plus HR employee/cost-center scope. Without that HR grant, the new HR rows are excluded from the detailed ledger and party suggestions. Financial statements continue to include the accounting totals. Generic journal reference copying excludes HR vouchers to keep settlement within the HR allocation workflows.
