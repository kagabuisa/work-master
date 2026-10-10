# HR module review and recommended additions

Reviewed: 9 October 2026. The evidence below describes the baseline at review time. The subsequent HR implementation now includes employee employment profiles, dated pay plans, attendance, leave, employee-money transactions, payroll, payslips, payments, and reversals. See [the current application guide](app-guide.md#human-resources) for implemented behavior and remaining manual calculations. The original audit itself was read-only.

## Recommendation

Design HR around the tasks people need to complete in Work Master: manage an employee, record time away, calculate pay, settle employee balances, and pay staff. Use the ERPNext review to identify capabilities and historical data that matter. Choose the app's own screens, records, and workflow; source document types and custom fields are migration inputs, not a required interface.

The strongest evidence of recurring use is employee administration, monthly payroll, advances, loans, and recovery transactions. Attendance and leave have substantial historical use but are not recent in the reviewed source. Retain them as core HR capabilities with fresh policies and calendars. Commission is a supported compensation capability; its legacy formula and its frequency of current use still need confirmation. Expense reimbursement is a useful supporting capability, even though the reviewed Expense Claim list is empty.

The proposed minimum complete module combines employee profiles, configurable earnings and deductions, payroll periods, payslips, payment allocation, advances/loans/recoveries, and essential reports. Attendance and leave can be delivered alongside this foundation. Payroll can initially accept approved manual paid-day and unpaid-leave inputs, with a recorded reason, before automatic attendance integration is ready. The first production payroll release must include settlement and cancellation handling, not just calculation.

## Proposed product design for Work Master

### A small HR menu

| Workspace | What the user does | What stays behind the screen |
| --- | --- | --- |
| Employees | Find an employee; view employment, assignments, compensation history, documents, and permitted balances. | Stable employee identity, effective-dated assignments, restricted compensation data. |
| Attendance & Leave | Mark a team's day, upload attendance, request/approve leave, and see balances. | Attendance records, holiday rules, leave entitlements and reversal entries. |
| Payroll | Open a month, review employees and exceptions, calculate, approve, post, and see payment progress. | Pay plans, component lines, approved input snapshots, accounting links. |
| Employee Money | Request/pay an advance, record an approved recovery or simple loan, submit a reimbursement, and allocate repayments. | Employee receivables/payables, payment allocations, outstanding amounts. |
| Reports | View payroll register, payslips, attendance summary, leave balances, employee statements, and cost-center totals. | Scoped queries and exports using the same source transactions. |

Put HR policies, pay components, calendars, and account mappings in an HR Settings area. Reuse existing cost centers for shop/unit allocation; introduce a separate branch list only if branches represent a different business concept. Keep departments and job titles separate because they answer different questions. Reuse the app's saved vouchers, drawers, attachments, and permission patterns where appropriate.

### Essential capabilities to retain

| Capability | Recommended design | ERPNext detail to simplify |
| --- | --- | --- |
| Employee lifecycle | Joining/leaving dates, employment status, manager, organizational assignment history, and linked login. Former employees remain available in history. | One profile instead of reproducing every personal-data field and HR form. |
| Compensation | A dated pay plan on the employee: fixed earnings, allowances, optional commission, deductions, and payment method. Allow reusable templates for common plans. | Users should not need separate structure and assignment screens for a simple pay change. |
| Payroll calculation | One payroll run per company/period, with an employee breakdown, editable draft inputs, exception checks, and frozen approved results. | Derive month/year from period dates; a separate editable month, fiscal year, and pay-date combination is unnecessary. |
| Payslip | A readable output of the posted employee pay calculation, including earnings, deductions, net pay, and payment progress. | Avoid separate Salary Slip and custom Payslip engines. |
| Attendance and leave | Bulk daily entry, half days, approved leave, current holidays, allocation and balance tracking. Explain missing records and unpaid-day overrides. | Start with simple working-day calendars; add shifts and devices when required. |
| Commission and variable pay | Approved variable earnings linked to their calculation basis and period; support fixed amounts and configured formulas. | Keep the capability without automatically adopting the old hard-coded formula or duplicate commission fields. |
| Advances and simple employee loans | Approved amount, actual disbursement, outstanding balance, repayment schedule or payroll recovery, and cash-return handling. | One Employee Money workspace can support both, distinguished by type and accounting policy. Defer a complex lending engine. |
| Salary recoveries | Approved charge case with evidence and reason; repayments reduce a tracked employee balance. Show opening, new charges, recovered, and closing amounts. | Replace manually selected previous-slip links and copied balances with a transaction-derived statement. |
| Reimbursements | Receipt-backed request, approval, payable, and payment, with optional advance settlement. Deliver after payroll essentials if capacity is limited. | Avoid a large travel-management subsystem initially. |
| Approvals and corrections | Draft → approved/posted → cancelled, with explicit authority, audit history, and linked reversals. Payment remains a separate settlement state. | Use one approval by default; add a second level by policy, rather than copying the inactive legacy workflow. |
| Accounting and reporting | Employee-level allocations, cost-center expense allocation, one posting per source event, reconciliation, and scoped exports. | Finance can inspect the linked journal; HR users should not have to construct journal entries manually. |

This coverage preserves the recurring business capabilities and the expected foundations of HR. It does not claim that every capability above is currently used in ERPNext or already exists in this app.

### Make the normal monthly task short

The payroll page should guide a user through four steps:

1. **Prepare:** choose the period; load eligible employees and pay plans; bring in approved variable pay and recoveries; highlight missing or conflicting inputs.
2. **Review:** show earnings, deductions, net pay, and outstanding balances per employee, with differences from the previous period and links to supporting records.
3. **Approve and post:** an authorized reviewer approves the calculation; posting freezes it and creates the accounting obligation once.
4. **Pay:** finance selects employees and amounts, records bank/cash payments, and allocates them. The same page shows Unpaid, Partly paid, or Paid without changing the approval status.

For example, a fixed-pay employee with an allowance and an advance should have one pay breakdown. An approved advance-recovery deduction reduces both net salary and the advance balance. A partial bank payment reduces salary outstanding but does not change the calculated salary. Cancellation reverses the relevant allocations and postings through the app's voucher rules.

## Delivery priorities

**First, foundation:** complete employee records and dated pay plans; configure components, accounts, and access. Historical payroll viewing is helpful for migration and validation, but should not become a large prerequisite project.

**Then, a complete payroll cycle:** calculate, review, approve, post, issue payslips, allocate payments, and report balances. Include basic advance/loan/recovery accounting and approved manual variable-pay inputs. These capabilities have the strongest recurring-use evidence and must work together.

**Alongside or next, attendance and leave:** establish current calendars and entitlements, deliver daily/bulk entry and approval, then integrate approved period inputs into payroll. Missing attendance is an exception, not an automatic absence or deduction.

**Afterward, supporting HR:** reimbursements, contract reminders, onboarding/exit checklists, richer commission automation, and bank-file exports. Add recruitment, appraisals, training, and biometric integrations only when operating needs justify their complexity.

## What was reviewed

The review used read-only access to the configured ERPNext site, `https://zenjji.com`, and the app's PostgreSQL database, plus the current source code. It covered 46 relevant ERPNext document types: HR parent documents, child-table metadata, HR settings metadata, and matching employee/payroll documents. All parent-document lists in the initial audit were fully paginated. Singleton setting values were not collected.

The review also inspected eight salary slips: the two available drafts and three recently modified submitted and cancelled slips each. This is a targeted sample, not a complete recalculation of historical payroll. Employee names, individual salaries, banking details, and personal contact data were not retained in the audit artifacts.

Evidence: [module metadata and aggregate counts](../audits/hr-module-review-2026-10-09.json), [employee comparison and transaction samples](../audits/hr-module-review-supplement-2026-10-09.json), and [selected HR general-ledger aggregates](../audits/hr-module-review-ledger-2026-10-09.json). Current Frappe HR documentation is used for design comparisons; its newer document types must not be assumed to exist in this legacy ERPNext site.

## Existing ERPNext HR usage

| Area | Observed records | What this means for the app |
| --- | ---: | --- |
| Employees | 180: 83 Active, 97 Left | Preserve former employees and their historical transactions. |
| Salary slips | 4,793: 4,528 submitted, 263 cancelled, 2 drafts | Payroll is the strongest existing HR process; cancellations and amendments are material. |
| Salary structures | 217 | Import effective dates and employee assignments; record count does not establish how many are currently active. |
| Attendance | 24,166: 24,145 submitted, 21 cancelled | A substantial historical process, but observed dates stop on 2 February 2022. |
| Leave allocations | 410: 388 submitted, 22 drafts | Rebuild current entitlements rather than treating old allocations as today's balances. |
| Leave applications | 120: 114 approved/submitted, 6 rejected/draft | Observed application leave dates stop in December 2019. |
| Holiday lists | 1 | Its coverage runs from December 2016 to December 2017; a current calendar is needed. |
| Earning / deduction types | 10 / 21 | Map existing components rather than replacing them with one basic-pay field. |
| Departments / designations / branches | 14 / 31 / 28 | Use reference lists for organizational assignments. |
| Employment types / leave types | 9 / 8 | Retain meaningful classifications and policies. |
| Custom Charges on Salary | 645: 556 submitted, 89 cancelled | Salary slips link this document through a table field; these are charge rows, not necessarily 645 independent employee debts. |
| Custom Payslip / Penalty | 1 / 2 | Low observed usage; do not create duplicate payroll engines around these documents. |
| Expense claims / appraisals / applicants / offer letters | 0 | Lower initial priority; zero visible records does not prove these processes never occur outside ERPNext. |
| Job openings | 2, both Open | Minimal evidence for a full recruitment subsystem. |

Attendance statuses across all visible records are 24,111 Present, 38 Absent, and 17 Half Day. The earliest attendance date is 28 July 2016. Salary-slip custom dates, where populated, range from 31 October 2018 to 30 September 2026. These dates establish recent payroll activity; they do not establish continuous or complete payroll coverage.

## Transactions and business rules worth preserving

### Employee records and assignments

Every ERPNext employee has the custom `assigned_to` link to a cost center. Only 37 of the 180 employees have a source user link. The app contains 178 employees, of whom 81 are enabled; comparison by employee ID identifies two ERPNext Active employees missing locally and no local-only employee IDs. This does not establish that all remaining employee fields match.

The app's employee schema stores ID, name, employment status, company, department, designation, phone, email, and enabled state. Its current employee import does not bring across joining/leaving dates, the source user link, reporting manager, branch, employment type, or the required source cost-center assignment. These gaps matter for payroll eligibility, shop allocation, approvals, and self-service.

### Salary slips, commission, and recoveries

Salary slips hold basic earnings and deductions, working/payment days, leave without pay, and custom sales, margin, commission, approval, and recovery fields. Sampled submitted slips include Debt recovery, Salary Advance, and Other charges deduction components. Two of the three submitted samples have carried recovery balances.

The live Salary Slip client script calculates:

```text
commission = sales × margin × 12500 ÷ 20 ÷ 1000000
recovery closing balance = opening balance + new charges − amount recovered
```

These are observed legacy rules, not approved rules for the new app. Confirm the units of margin, which sales qualify, returns/cancellations, shared-shop attribution, component inclusion, rounding, and whether commission replaces or supplements fixed pay. The custom commission field and a Commission earnings line can coexist; do not add both automatically. The script skips commission calculation when an input is zero, so a new implementation should explicitly recalculate zero values on the server.

Recovery categories include stock shrinkage, underpricing, cash recovery, missing reports, fixed-asset recovery, training-fee recovery, operational losses, and other charges. Keep a traceable transaction for each approved obligation and repayment. A stock shortage or late arrival should not automatically become a salary deduction; require an approved case and applicable policy.

All eight sampled slips satisfy gross pay minus deductions equals net pay and opening recovery balance plus new charges minus recovery equals closing balance within 0.01. This is limited sample evidence, not a certification of historical payroll. One draft's custom date is in October while its month is November; another draft already has Approved = Yes. Some cancelled samples also retain Approved = Yes. Therefore date, payroll period, approval, submission, and payment must be separate, validated concepts.

### Leave and attendance

The source has late-arrival and early-departure fields alongside attendance status. It also has a leave workflow, but the live workflow is inactive. Do not document its historical supervisor/HR stages as active enforcement.

Attendance and leave need current operating policies before they feed payroll. Missing attendance must remain distinguishable from confirmed absence. Do not calculate 2026 unpaid days from records that end in 2022, or use the expired holiday list as a current working-day calendar.

### Accounting transactions behind HR

The review fully paginated 10,509 GL entries across eight selected salary, commission, employee advance/loan/recovery, and PAYE accounts. The company default currency is UGX.

| Account | Ledger entries | Latest observed posting | Aggregate debit less credit, UGX |
| --- | ---: | --- | ---: |
| Salary | 5,252 | 7 October 2026 | Not presented as an outstanding liability; includes period closing. |
| Salary Payable | 538 | 9 October 2019 | 0 |
| Commission Expense | 123 | 30 September 2019 | Expense account, not an employee balance. |
| Commission Payable | 244 | 9 October 2019 | 0 |
| Employee Cash Advance | 3,781 | 7 October 2026 | 30,519,122 |
| Employee Loan | 149 | 8 October 2026 | 2,361,226 |
| Employee Loss Recoverable | 306 | 7 October 2026 | 52,946,088 |
| PAYE Expense | 116 | 15 September 2026 | Expense account, not a tax-payable balance. |

Every reviewed entry uses Journal Entry as its source voucher, apart from four Period Closing Voucher rows across Salary and PAYE Expense. None has `party_type = Employee`. Employee attribution could exist in other journal fields, accounts, remarks, or linked documents; it was not established by this GL review. Do not automatically distribute these account-level net amounts among employees or assume that a Salary Slip has already accrued or paid its net salary.

The selected Salary Payable and Commission Payable accounts have no observed postings after 2019 despite recent salary slips. This indicates a mapping/reconciliation task, not proof that recent salaries were unpaid or unrecorded: they may have been posted directly or through other accounts. The advance, loan, and recovery net figures are totals of visible ledger debits less credits, not verified individual amounts collectible or approved for payroll deduction. Review journals, employee attribution, and opening balances before cutover.

## App baseline at the time of review

The app already provides employee master screens, employee record permissions, user employee assignments, cost centers, accounts, journals, general-ledger posting, and voucher lifecycle/audit infrastructure. Employee parties can be selected in journals. Their referenced ledger rows can be copied into a journal, but the current workflow does not allocate payments to salary slips or settle employee advances and recoveries as tracked obligations.

At review time, the database contained three submitted employee-party journals. Those established employee accounting activity but there was no dedicated HR transaction module. The subsequent implementation adds attendance, leave, dated pay plans, payroll, payslips, employee balances, approvals, payments, and reversals; the original database counts remain baseline audit evidence.

Source references: `src/domain/schema.js`, `src/web/master-lists.js`, `scripts/import-mysql-employees-to-app.js`, `src/web/routes/ledger.js`, `src/web/routes/api.js`, `src/domain/posting.js`, `src/auth.js`, and `src/voucher-ownership.js`.

## Design references

Use [Frappe HR's leave approval model](https://docs.frappe.io/hr/leave-application) and [salary component setup](https://docs.frappe.io/hr/payroll-setup) to check capability coverage. Their screens and document boundaries are reference designs, not implementation requirements for Work Master. Approval and settlement controls should fit this app's existing voucher and finance workflows.

## Suggested workflows

**Attendance:** supervisor records or uploads daily attendance → validates employee/date/status → submits the day → HR reviews exceptions → an approved snapshot supplies the payroll period. Changes after payroll approval require an adjustment or reopening under a controlled process.

**Leave:** employee requests leave → supervisor approves coverage → HR validates entitlement where required → submission creates a leave-ledger debit → cancellation reverses it. Allocate and adjust balances through ledger entries rather than editing a balance number. Approval stages should be configurable, with no self-approval by the requester.

**Advance:** employee requests an amount → approver authorizes → finance pays → the payment creates an employee receivable → payroll recovery or cash return reduces that receivable. An approved request is not evidence that money was paid. Frappe HR similarly separates an [employee advance from its payment, claims, and return](https://docs.frappe.io/hr/employee-advance).

**Payroll:** open the period → select eligible employees and effective salary assignments → snapshot attendance, approved commission, and recovery inputs → calculate draft slips → review exceptions → approve and submit → post accrual once → allocate payments → issue payslips and close the period. Do not mark all employees paid when the payroll run is submitted. Frappe HR's [Payroll Entry](https://docs.frappe.io/hr/payroll-entry) is a useful reference for bulk processing and the separation of salary accrual from payment.

## Accounting design

Map salary components and HR obligations to explicit active, non-group accounts. The newly imported chart includes Salary, Salary Payable, Commission Expense, Commission Payable, Employee Cash Advance, Employee Loan, and Employee Loss Recoverable accounts. Their presence does not mean payroll posting defaults have been configured.

| Event | Proposed accounting behavior |
| --- | --- |
| Salary accrual | Debit salary/commission expense; credit employee net salary payable, statutory liabilities, and relevant employee receivables for approved recoveries. |
| Employer contribution | Debit employer contribution expense; credit the statutory payable. Keep it separate from employee deductions. |
| Salary payment | Debit salary payable; credit bank/cash; allocate the amount to the employee's salary obligation. |
| Advance payment | Debit employee advance receivable; credit bank/cash. |
| Advance recovery from salary | Credit advance receivable within the payroll accrual; reduce net salary payable. Do not expense the advance again. |
| Approved reimbursable expense | Debit the expense; credit employee reimbursement payable; payment settles that payable. |
| Cancellation or correction | Reverse the linked postings and allocations; enforce downstream dependencies and retain the amendment trail. |

These are proposed patterns, subject to confirmation of the company's accounting policy. Source accounts named PAYE Expense and income accounts for absence/late-arrival deductions need review before reuse. A deduction's name is not sufficient to decide whether it reduces wages, settles a receivable, creates a liability, or represents income.

Use employee identifiers on the relevant payable/receivable lines and cost centers on expense lines. Add dedicated payroll and advance allocation logic rather than reusing purchase-invoice allocations. Define links among run, slip, source GL voucher, payment allocation, and reversal so retrying a request cannot duplicate posting.

For Ugandan payroll, add effective-dated statutory rules, employee tax/contribution identifiers, and reconciliation/export schedules. Confirm the rules applicable to each payroll period against [URA employment-income guidance](https://ura.go.ug/en/employment-income/) and [NSSF employer membership guidance](https://www.nssfug.org/about-us/membership/). Do not copy rates from historical slips or treat all deduction components alike. This report does not prescribe tax rates or establish historical statutory compliance.

## Implementation structure and access

Keep `app_master_employees` as the stable employee identity and extend it through a migration. Keep confidential compensation data separately from the general employee master. Design the internal records around effective employment/pay plans, attendance and leave movements, payroll runs and employee breakdowns, employee obligations, and payment allocations. Users can work through unified screens even when accounting and audit needs require separate internal records. Reusable pay templates are optional; they do not require a separate assignment workflow for every employee.

Use dedicated HR domain services and routes, while reusing transaction handling, audit events, cost centers, account validation, and posting infrastructure. The broader design includes future automation and richer reports. The current implementation uses unified HR screens and dedicated HR records; consult the application guide for the delivered workflows and manual inputs.

Add explicit HR action and scope permissions:

- Employee self-service: own profile, leave requests, advances, payslips, and statement only.
- Supervisor: assigned team's attendance and leave approval; no default salary or bank-detail access.
- HR officer/manager: employee lifecycle, leave policies, and approved organizational scope.
- Payroll preparer: calculate and review payroll; separate approval/posting authority where staffing permits.
- Finance: approved obligations, payments, statutory remittances, and reconciliation.
- Management: permitted aggregate reports; employee-level pay visibility must be explicit.

Existing general Employee Read permissions must not automatically expose salaries, tax IDs, bank details, private attachments, or payslip downloads. Enforce scopes on server endpoints, searches, reports, exports, and downloads. Link self-service to a verified local employee/user association; the source's 37 user links cannot automatically grant all 180 employees access. Apply the existing Admin model deliberately and audit sensitive changes and exports.

## Migration and validation plan

1. Reconcile the two missing active employees and map departments, branches, cost centers, managers, and user identities. Preserve source IDs, former employees, and source status.
2. Import payroll and HR history as a labelled read-only archive first. Preserve drafts/cancellations and source links. Map legacy `att_date`, `month`, `fiscal_year`, custom `date`, earnings/deduction child rows, and previous-slip recovery links explicitly.
3. Define the authoritative system and cutover period for each process. Stop editing that process in both systems after cutover. Keep historical archived payroll distinct from local posted payroll.
4. Agree opening leave entitlements, unpaid salaries, employee advances, loans, and recoverable charges as of cutover. Reconcile subledgers to GL. If corresponding GL balances already exist locally, link openings rather than posting them twice.
5. Run a full payroll period in parallel. Compare employee eligibility, component amounts, commission, approved recoveries, carry-forward, rounding, net pay, employer contributions, payment allocations, and GL totals.
6. Require checks for duplicate employee-period slips, cancelled records, date/month mismatch, zero commission inputs, partial payments, over-recovery, departed employees, cross-company assignments, unauthorized payslip access, transaction retry, and cancellation reversals.
7. At implementation time update `docs/app-guide.md` for delivered screens/workflows, `docs/permissions.md` for actual access rules, and `README.md` for operational commands. Do not describe this roadmap as current behavior.

## Decisions needed before implementation

Confirm the payroll owner and approval chain; the meaning and eligibility rules of commission; deduction/recovery authorization policy; current leave and holiday rules; partial-month pay for joining/leaving employees; payment modes and bank-file format; statutory rule ownership; and the proposed cutover month. Choose whether ERPNext remains the payroll authority during the initial archive/HR stages.

The recommended first usable release is an employee profile and pay plan connected to a complete monthly payroll and payment cycle, with basic advances and recoveries. Attendance and leave remain part of the target module, with automatic payroll integration added once current records and policies are ready. Measure success by whether the app can reliably manage staff, explain pay, track employee balances, and settle payroll—not by the number of ERPNext forms reproduced.
