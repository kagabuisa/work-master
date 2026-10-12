# Permissions and voucher visibility

## How access is decided

1. Each user has one role. Roles grant actions on voucher types, master lists, payments, accounts, and reports. The built-in roles are Standard, Privileged, Admin, Retail, Wholesale, Finance, Logistics, and Management. Retail, Wholesale, Finance, Logistics, and Management start with the same permission set as Standard; an admin can edit role permissions in **Settings → Roles**.
2. An admin can adjust a user's effective permissions in **Settings → Users**. User grants add to the role permissions, and user denials remove them. A denial wins when a permission appears in both places. Admin has full access.
3. A user's permitted records narrow which named records they can use or view. **Settings → Users** provides Warehouse, Cost Center, Employee name, Retail Price list, and Wholesale Price list assignments. Assigned values are stored in `app_users.record_access`; the related named Read permissions are added to the user. Customer group, supplier type, price list, warehouse, and account scopes can narrow access further.
4. The application checks both the action permission and the record scope on each request. A menu link or a report permission alone does not grant access to a voucher outside the user's scope.

The Roles and User Permissions pages offer every active, submitted price list as a permission type, including buying lists such as Standard Buying. The Read action allows use of the list where its buying or selling direction, currency, and the voucher workflow permit it. Listing a price list as a permission type does not make an inactive or incompatible list usable in a voucher.

Role permissions are defined in [`src/auth.js`](../src/auth.js). User record assignments are defined in [`src/user-record-access.js`](../src/user-record-access.js). Request checks are in [`src/authorize.js`](../src/authorize.js), and named record scopes are in [`src/access.js`](../src/access.js).

## Standard role voucher rule

Standard users can see a voucher when its `created_by_user_id` matches their login. For a **sales invoice**, they can also see it when `invoicer_id` matches the employee assigned to their user. These are alternative ways to qualify: a Standard user can see an invoice they created or one assigned to their permitted employee. Purchases, purchase orders, stock entries, stock reconciliations, and journals use the creator login because they have no employee assignee field. The Purchase Invoice purchase-order selector applies ownership, supplier-category, and warehouse restrictions before selecting its newest 100 receivable orders. Every nonempty line warehouse must be permitted, including lines already received; access is checked again when an order is used.

The rule applies to voucher lists, voucher reports and CSV exports, direct detail/edit/action URLs, linked payment pages, stock entry cancellation lookups, stock ledger and movement details, gross profit, and journal reference suggestions. Other roles keep their existing role permissions and record scopes.

The Journals list, report, detail, and drawer require Account Read access to every line account, including for the journal creator. Standard users must also own the journal. A denied detail or drawer request explains whether Journal Read, ownership, or line account access is missing. The creator can see the restricted account codes in that error.

Voucher ownership comes from the record audit fields, which stamp `created_by_user_id` when the voucher is created. A historical voucher with no creator user ID is not treated as owned by a Standard user. A historical sales invoice can still be visible if its `invoicer_id` matches the user's assigned employee. Editing a voucher does not change its creator. The rule is implemented in [`src/voucher-ownership.js`](../src/voucher-ownership.js).

Daily Activity retains its existing restriction for Standard users, including its ERPNext reference view. Debtors remains unavailable to Standard users because it does not reliably map every displayed voucher to an owner. A Standard user with General Ledger Read can open General Ledger, but sees entries only from their own vouchers (or sales invoices assigned to their employee) and permitted accounts. Payment entries follow the ownership of their parent invoice or purchase. Historical entries without a verifiable owner are excluded. If customer or supplier categories are selected for the user, the ledger also filters sales and purchase entries to those categories and omits journal and stock entries. The scoped sales, purchase, purchase order, journal, stock ledger, stock movement, and gross profit reports remain available when the user's action permissions allow them.

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

HR applies existing employee and cost-center assignments/named grants and denials, and account scopes. It checks both current employee scope and stored voucher cost centers where applicable. A whole payroll run and its export require access to every employee and every component/payable account; an individual payslip requires only that slip's employee and accounts. Assign an employee in Settings → Users and grant Payroll Read for restricted payslip access. A user's employee assignment is configured by an administrator, not inferred from ERPNext names or logins.

Non-admin users cannot approve their own leave or employee-money requests. They cannot post payroll they created or last edited. Admin can approve directly. Submitted transactions are immutable, and cancellations enforce dependent payment/recovery rules. Unknown HR paths and unsupported methods are denied by the central route classifier.

General Ledger and its CSV/Excel/PDF exports additionally enforce Payroll Read for payroll accruals/payments and Employee Money Read for employee-money accruals/payments, plus HR employee/cost-center scope. Without that HR grant, the new HR rows are excluded from the detailed ledger and party suggestions. Financial statements continue to include the accounting totals. Generic journal reference copying excludes HR vouchers to keep settlement within the HR allocation workflows.

Employee suggestions for new user defaults and employee permission rows offer only Active, enabled employees. Existing defaults and employee permissions remain effective when an employee leaves; status filtering in suggestions does not revoke access to historical records.

## Daily Activity creation

Daily Activity has separate Read (`reports.daily-activity.view`) and Create (`reports.daily-activity.create`) actions in the Reports permission table. Opening the New form or saving a local draft requires both. Read alone does not permit creation. Admin has both automatically; grant Create explicitly to other existing roles or users. Standard users retain the existing Daily Activity restriction, including the reference view. The local form, save route, list, totals, and details apply assigned cost-center and warehouse restrictions. Drafts are saved in PostgreSQL and audited under the app user who created them. No ERPNext credentials or permissions are needed to create local drafts. The separate ERPNext reference view uses the configured API user's Read access. This flow does not grant edit, submit, cancel, or delete access.
