# Work Master app guide

This guide describes the current app behavior. Update the relevant section whenever a user-facing workflow, validation rule, permission, or report changes. The implementation and tests remain the source of truth when older documentation disagrees.

## Sign-in and access

- A compact account panel at the right of the page header, matching the landing page's logo row, shows the signed-in username and the current date and time in Kampala, using the app's configured display formats. The clock updates while the page is open. On module pages, **Change password** is also available in this panel. Select **Log out** to end your session and return to the login screen.
- Users sign in with a PostgreSQL-backed account. Sessions have a seven-day maximum lifetime and end after five minutes without activity. An idle open page returns to the login screen. Activity in an open form keeps its session alive.
- Login and other forms must be submitted from the app's own origin. If a page was open before an update fixing “Request origin is not allowed,” reload it before submitting again.
- Roles grant actions on vouchers, master lists, payments, accounts, and reports. An admin can adjust a user's permissions and assign permitted records in **Settings → Users**. See [Permissions and voucher visibility](permissions.md) for ownership and scope rules.
- In **Settings → Roles → Role permissions** and **User permissions**, use the compact selection panel to search for a role or user, choose it, and select **Open role** or **Open user**, then tick actions in the permission table. The panel places its short guidance beside the heading and keeps the management link above the labeled controls; a subtle help link sits beside the Open button and expands detailed permission guidance beneath the controls. The selection controls stay on one row, with horizontal scrolling on narrow screens. Checkbox changes save automatically. The compact **Add Permission** panel displays its title and autosave status together in the top border and keeps both search fields, action checkboxes, and **Save permission row** aligned in one row. On narrow screens, scroll the panel horizontally to reach all controls. Unticking Read clears the row's actions and removes the row after saving. To add a row, choose a voucher, master list, or other permission type below the table. The **Voucher or master list** and **Specific record (optional)** fields provide autocomplete: type to search without regard to case, then select a suggestion with the mouse or Arrow keys and Enter. Use `%` to match any sequence of characters, for example `chart%accounts`, `cash%kyenjojo`, or `52%`. Account suggestions include the account code and name. Suggestions open in a scrollable overlay above or below the field without expanding the form; Arrow keys scroll only the suggestions. Typed search text must be selected from the suggestions before saving; it does not grant access to every matching record. Clearing Specific record selects the broad type. The second field offers specific records when available: for example, choose **Warehouse** first, then choose a warehouse in **Specific record**. Choosing **Accounts** or **Chart of Accounts** offers the saved accounts. Leave the second field at **No specific record** to save the broad type. Price lists also offer specific records; User permissions additionally offers cost centers and employees. If the chosen permission already has a row, edit that row's checkboxes instead. A user's assigned default record is changed through **Edit default** on the Edit user page; its Read box stays selected until that default changes.
- Available navigation and actions depend on the signed-in user's permissions. The server also checks those permissions on requests.
- The landing page arranges the available module cards in compact, flexible rows. Cards expand to fill each row, including the last row, and their links use as many columns as the card width allows. On small screens, cards stack vertically.
- In **Settings → Users**, the **Cost Center** field displays the cost center name only; the selected cost center's ID is retained internally.
- A Standard user with General Ledger Read sees a General Ledger link under Reports. The report shows entries from their own vouchers or assigned sales invoices, limited to their permitted accounts and customer or supplier categories.

## Vouchers

| Voucher | Where to find it | Main workflow |
| --- | --- | --- |
| Sales Invoice and Cash Sales Invoice | **Sales → Sales Invoices** | Create or edit a draft, then submit. Cash sale submission records a payment with the invoice. Submitted invoices post stock cost and accounting entries. Payments and cancellations have their own actions. |
| Purchase Order | **Purchases → Purchase Orders** | Save, edit, submit, or cancel an order. An order can lead to a Purchase Invoice for the quantity received. Submitting the order alone does not receive stock or create a payable. |
| Purchase Invoice | **Purchases → Purchase Invoices** | Save a draft, then submit to receive stock and create the payable. Each purchase order can have only one draft purchase invoice at a time. If another draft is saved, the error identifies the existing draft by its purchase invoice number. Edit or submit the existing draft, or delete it before saving another. When saving or submitting a linked invoice, quantities for each order line cannot exceed the ordered quantity minus quantities already received through submitted invoices; repeated invoice rows for the same order line are added together. Quantity errors identify the purchase order number and show the invoice, ordered, already received, and remaining quantities. **Submit and Receive Stock** validates the saved purchase order link automatically; you do not need to select the order again. Record and cancel supplier payments from the submitted voucher. Cancelling a purchase reverses its stock and ledger entries. |
| Stock Entry | **Stocks → Stock Entries** | Record opening stock, purchase receipts, transfers, adjustments, or a cancellation entry. The entry type determines its stock movement. |
| Stock Reconciliation | **Stocks → Stock Reconciliation** | Load warehouse stock, enter physical counts, save a draft, then submit the differences. A submitted reconciliation can be cancelled with a reversal. |
| Journal Entry | **Accounts → Journals** | Enter two or more account lines, save a draft or post it, and cancel eligible manual journals. Posting creates general ledger entries. Automatically generated journals are managed from their source voucher. |

Voucher lists, reports, and full detail, new, and edit pages provide a **New** control for users permitted to create that voucher type, including when viewing submitted or cancelled vouchers. Purchase pages offer Purchase Invoice and Purchase Order when both are permitted; stock detail and form pages offer Stock Entry and Stock Reconciliation. Customer or supplier scope restrictions also apply to these controls.

On a voucher form, press **Ctrl+S** (or **Command+S** on Mac) to use its Save action. The shortcut does not submit or post the voucher.
On purchase-order forms, pressing **Enter** in an input field does not save the order. Use **Ctrl+S** (or **Command+S**) or the **Create Draft Order**/**Save Draft** button. Enter still inserts a newline in Remarks and activates a focused button.
Editable voucher forms prefill the user's assigned default **Cost Center** when it is permitted, enabled, and not a group. The default is present when the page loads; a saved cost center takes precedence. Users can change the selection to another permitted cost center.
Voucher drawers show the reason for an access denial and distinguish a missing voucher from a server error. For a journal created by the signed-in user, an account permission denial names the restricted line accounts.
The Journals list and report include a journal only when every line account is permitted, including journals created by the signed-in user.
The Journals list's **Date** column shows the posting date only, using the app's configured date format.
The Journals report column picker includes **User**, which shows the login that created each journal. Creator login can be matched through the User filter or the main Search field; both apply to CSV downloads.

### Sales invoice details

- **Save** creates or updates a draft; review and submit the saved invoice to post it.
- Customer and item suggestions support **Up/Down** to focus results, **Enter** to select, and **Escape** to close. Item quantities remain editable before adding. Screen readers receive result counts and loading/error messages.
- At the first or last list page, unavailable Previous/Next controls are disabled and skipped by keyboard navigation.

- New invoices start with the current Kampala **Posting Date** and **Posting Time**; both can be changed. The stored `invoice_date` field is the posting date used by the invoice and ledger workflows. **Due Date** is separate.
- New invoices select the user's assigned warehouse and retail price list when those choices are permitted and available. Without an assigned retail list, the form selects **Retail Pricelist** when it is active and permitted. The user can change either field before saving. **Ext Invoice** holds an optional outside invoice reference.
- The full view and print view show the invoice number directly below the **Sales Invoice** or **Cash Sales Invoice** title. The drawer also shows the number.
- Sales invoice lists and reports label the date as a posting date. The sales invoice report supports filters, selectable columns, and CSV download.
- Price lists and item prices supply suggested rates. Existing invoice lines retain their saved rates.
- Duplicating an invoice fills each copied line's Stock column with the current balance in the selected warehouse when the duplicate form opens. The balance is checked again when the invoice is saved or submitted.

### Stock reconciliation count sheets

Submitting a reconciliation keeps every counted item on the voucher, including items that match the book balance. Only items with a quantity or stock-value difference are posted to the stock ledger. Matching items show zero differences on the submitted voucher. A count with no differences can be submitted and cancelled without stock-ledger or accounting entries. Differences are checked against the current warehouse balance at submission; existing historical ledger rows remain unchanged.

Choose a warehouse on a new reconciliation or open **Edit count** on a draft. Select **Download Excel template** to download an `.xlsx` workbook with that warehouse's stocked items, book quantities, and blank **Counted Qty** cells. A saved voucher's items are included even if their current stock is zero. Spare rows allow other active item codes to be counted. A read-only voucher also offers the template download. Downloaded filenames include the reconciliation number and warehouse, for example `REC-000001-Main-Store-count-sheet.xlsx`; unsaved vouchers use `new-reconciliation` in place of the number.

Fill **Counted Qty** with the physical count, including **0** for zero stock, using up to three decimal places. Leave uncounted rows blank; blank quantities are ignored rather than treated as zero. Keep **Warehouse** and **Item Code** intact and use one row per item. The workbook includes an Instructions sheet.

Select **Upload count sheet** on a new or editable draft voucher and choose the completed `.xlsx` file (up to 5 MB and 5,000 item rows). Matching item counts are replaced and additional valid items are added. Rows omitted from the upload keep their current form counts. Unknown or inactive items, duplicate counted items, wrong warehouses, negative or invalid quantities, and formula quantities reject the upload without changing the form. Item names, current book quantities, and valuation rates come from the app; workbook book quantities and names are not trusted as current data, and rates are not imported. Existing valuation-rate permissions still apply.

Uploading fills the form without saving or posting. Review the count and value differences, then **Save draft** or **Submit reconciliation**. Submitted and cancelled vouchers cannot receive uploads. Submission checks the current stock balance and applies the existing reconciliation rules.

Scanned physical stock sheets and spreadsheet files can be attached separately under **Scanned stock sheets** after saving the voucher. Users with Stock Entry Edit can attach or remove supporting PDF, JPG, PNG, CSV, and Excel (.xls/.xlsx) files on saved draft, submitted, or cancelled reconciliations. Upload up to three files at a time, no larger than 10 MB each. A “request is too large” (413) response for a smaller file indicates that the server proxy upload limit needs to be increased. The list shows file name, size, uploader, and upload time; select a file name to download it. Uploaded scans are retained until removed or the voucher is deleted. Attaching or removing scans does not change the count, voucher status, stock ledger, or accounting entries. These attachments are supporting evidence; use **Upload count sheet** above to import Excel quantities.

### Paying multiple purchase invoices in one journal

Select **Supplier** and the supplier's **Party ID**, then choose one or more outstanding purchase invoices from **References**. Each selection adds a separate **Accounts Payable** debit row with its invoice reference and outstanding balance. Repeated selection of the same invoice does not add another row. Edit the debit amounts for partial payments. Add a separate bank or cash credit row for the combined payment, leaving its Reference blank. You can also select an invoice directly in a row's Reference field. Removing a selected reference removes its rows; changing the party clears referenced rows to prevent allocations to the previous party.

The invoice picker lists submitted invoices with outstanding balances for the selected supplier. Saving a draft does not pay the invoices. Posting creates one payment allocation per invoice and updates each invoice's paid amount and status. Repeated rows for one invoice are added together. Payments cannot exceed the invoice's outstanding balance or precede its posting date. Cancel the journal to reverse all its allocations and restore invoice balances; its linked allocations cannot be cancelled individually from an invoice. For **Customer** parties, select multiple outstanding sales invoices in **References** to add separate **Accounts Receivable** credit rows. Add a bank or cash debit row for the combined receipt. Posting applies each row to its invoice; cancellation reverses those allocations. Customer invoice lists, payment details, debtor statements, and reports include these receipts. Existing journals with a single header reference remain supported. For **Employee** parties, references with permitted employee ledger rows copy those account rows and amounts into the form. Review these copied rows and balance the journal before posting; employee references do not allocate invoice payments.

### Journal account rules

- Journal forms hide **Posting Time** beneath the posting date. Select **Edit time** to reveal and change it; the current time value is saved even when collapsed. Read-only journal pages offer **View time**.
- The journal's **Remarks** field appears below the account rows and totals, just above the form's action buttons. Individual **Line Remarks** remain beside their account rows.
- Every amount-bearing line needs an account. A single line cannot contain both a debit and a credit.
- Total debits must equal total credits.
- An account may appear on multiple debit lines or multiple credit lines, but it cannot appear on **both** sides of the same journal. The form shows this conflict, and the server rejects it when saving or posting. Submitting an older draft applies the same rule.

## General Ledger downloads

In **Reports → General Ledger**, select **CSV**, **Excel**, or **PDF** beside Apply to download all matching transactions, including entries beyond the current page. Downloads use the current Search, Account, Party, Voucher, From, and To fields and the same account, ownership, and customer/supplier access restrictions as the report. Each file includes debit and credit totals and net balance; row balances follow the report’s running balance per account within the selected filters. Excel amounts are numeric, and PDF uses a landscape table with repeating column headers, alternating row shading, wrapped account and voucher details, right-aligned amounts, filter details, summary totals, and page numbers. Long remarks continue onto the next page without being omitted.

## Other app functions

- **Chart of Accounts** supports a case-insensitive search by account code or name, plus Root Type, Account Type, Status, and Account Kind (posting or group) filters. The compact filters place each fixed label on the top border of its input box, with equal-height fields and Apply/Reset buttons centered on one row; scroll horizontally on narrow screens to reach all controls. Select **Apply** to combine filters, or **Reset** to clear them. The count shows matching accounts out of those you have permission to view.
- **Settings** manages customers, suppliers, items, warehouses, employees, cost centers, price lists, item prices, company details, users, and roles. Master record actions require the corresponding permissions.
- **HR** manages employee employment details, pay plans, attendance, leave, employee money, payroll, and payslips. It has separate HR permissions.
- **Accounts** includes the chart of accounts and journals. Administrators can import ERPNext accounts using the server command documented in the README. Imported accounts use numeric local codes grouped by root type (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, and 5xxx expenses) and category. Names retain the ERPNext company suffix. Subsequent imports preserve assigned account codes and local code edits. Group accounts cannot receive journal postings, and disabled or frozen ERPNext accounts are unavailable for new postings. The import retains existing local accounts and posting defaults.
- **Stocks → Stock Balance** shows current nonzero stock balances. Use **Download CSV** to download all rows matching the Item and Warehouse fields, including rows beyond the current page. The CSV includes item code, warehouse, quantity, valuation rate, and stock value.
- **Reports** includes debtors, stock ledger, stock movement, gross profit, general ledger, trial balance, profit and loss, balance sheet, and Daily Activity. Each report has its own Read permission. Daily Activity reads ERPNext data and is read-only in this app.
- App-created vouchers and accounting data are stored in PostgreSQL. ERPNext/MySQL supplies imported master data and the read-only Daily Activity report; app-created entries are not written back to ERPNext.

## Keeping this guide current

When a feature changes, update its workflow and rules here in the same work as the code. Update [Permissions and voucher visibility](permissions.md) for access changes and the [README](../README.md) for setup, deployment, or operational changes. Describe behavior that users can observe; keep field names and implementation details only where they clarify a workflow.

### Customer statement PDF downloads

Under **Sales → Debtors**, open a customer statement and select **Download PDF** in the statement drawer or full statement view. The download uses the applied statement date range (or the report date range when no separate statement range is applied). Apply any date changes before downloading. The PDF includes the configured company name and contact details, customer identity, period, UGX debit and credit totals, closing balance, and all statement transactions. Running balances include transactions before the selected period. Multi-page statements repeat the transaction headings and show page numbers. Print and CSV Export remain available.


## Human Resources

Open **HR** from the landing page or sidebar. HR contains Employees, Attendance, Leave, Payroll, Employee Money, and HR Settings. Each workspace requires its own Read permission. Existing employee master permissions do not grant payroll access. Admin has access; other roles need explicit HR grants. Employee, cost-center, and account record restrictions apply to HR reads and changes, including exports and payslip printing.

### Set up HR

1. Create or maintain employee master records under **Settings → Employees**. Under **HR → Employees**, open an employee and save joining/leaving dates, manager, shop/cost center, branch, and employment type. Updating employment details requires HR Employees Write. Master name, company, status, department, contact details, and designation continue to use the existing master editor and its permissions.
2. Under **HR → Settings**, choose an active non-group liability account for Salary payable. Configure leave types as paid or unpaid, regular working weekdays, and dated public holidays. With HR Settings Write, use **Edit** to rename a leave type or change its paid status before it is used, and **Remove** to delete an unused type. Types referenced by allocations or leave requests can be renamed but cannot be removed or have their paid status changed; create a new type for a different paid status. Validation errors appear on the settings page. The leave calendar applies to all HR employees; it starts with all seven weekdays selected. Set the actual workweek before approving leave.
3. Go to **HR → Employees**, select the employee's name, then open **Pay plans → Add or replace a dated pay plan**. The payroll preparation screen also links to employee pay-plan setup. Set **Effective from** to the first day of the payroll month or earlier. Payroll Read shows compensation; Payroll Write saves a plan effective from a chosen date. Add earning, deduction, or employer-contribution rows. Earnings require expense accounts; deductions require liability accounts; employer contributions require both an expense account and a payable account. Amounts are in UGX. Select **Prorate by paid days** where appropriate. Saving the same effective date replaces that plan; existing payroll keeps its own component snapshot.
4. Grant HR actions through **Settings → Roles** or user overrides. Employee Money Payment and Payroll Payment have separate Create permissions for recording disbursements/returns and salary payments. Assign employee and cost-center records for narrower access. User-to-employee assignments remain under Settings → Users.

### Attendance

Under **HR → Attendance**, select one or more active employees, a date, and Present, Absent, or Half day, then **Save drafts**. Submit individual rows to confirm attendance. One non-cancelled record is allowed per employee/day. Cancel an incorrect row and create its replacement. Dates must fall within recorded employment dates. The register can be filtered by date and shows up to 1,000 recent records.

Attendance is recorded separately from payroll. Missing attendance is unrecorded, not an automatic absence or salary deduction. A month with posted payroll blocks submission or cancellation of its attendance records until that payroll is corrected.

### Leave

Under **HR → Leave**, select an employee, leave type, dates, and reason. A half-day request must cover one date. Working weekdays and holidays determine the requested days; a request crossing calendar years must be split. Approval rechecks the calendar, employment dates, overlaps, and paid-leave entitlement.

Use **Set an employee's annual allocation** to set a type/year allowance. An allocation cannot be reduced below leave already approved for that year. Paid leave requires enough allocated days; unpaid leave can be approved without an allocation. Submitted requests display Approved, consume the applicable allocation, and cannot overlap other approved requests. Cancellation restores available days. A different user must approve a request; Admin can approve directly. Approval/cancellation is blocked for dates covered by posted payroll. The request list shows up to 1,000 recent requests; balances include all approved requests.

### Employee advances, loans, recoveries, and reimbursements

Under **HR → Employee Money**, save a draft with employee, type, date, amount, account, reason/supporting reference, and optional cost center:

- **Salary advance / Employee loan:** choose an employee receivable account. Approval authorizes the amount; **Disburse funds** records the actual cash/bank payment and creates the receivable. Partial disbursements are allowed up to the approved amount.
- **Approved recovery / charge:** choose a receivable account and an income/expense offset account according to the approved accounting policy. Approval posts the charge. Record the authorization or supporting document reference in Reason; charges are not automatically created from stock losses or attendance.
- **Expense reimbursement:** choose an employee payable account and expense offset account. Approval posts the expense/payable; **Pay reimbursement** settles it partially or fully.

A different user must approve the transaction; Admin can approve directly. Approved advances, loans, and recovery charges can receive **Cash return / repayment** or be recovered through a payroll deduction. Balances are calculated from posted obligations, disbursements, returns, and posted payroll allocations. A draft payroll recovery does not reduce an employee balance.

Payments require an active Cash or Bank account, amount, date, and reference. Overpayments, over-recoveries, and returns exceeding the funded balance on their date are rejected. Cancel payments to reverse their GL entries. A disbursement already used by repayments/payroll cannot be reversed until the dependent amounts are reversed. Cancel employee transactions only after linked payments and payroll recoveries are cancelled. Reasons support external document references; HR file uploads and automatic loan schedules are not included.

### Monthly payroll and payment

Payroll draft validation errors appear on the payroll screen with the entered company, month, posting date, and employee selections retained. Missing pay plans and missing leaving dates identify the employee and link to the relevant employee section when you have HR Employees Read. Inactive employees need a leaving date before their payroll eligibility can be established.

1. Under **HR → Payroll**, choose company, month, posting date, and employees from that company. Each employee needs a pay plan effective on or before the first day of the month. Payroll posting cannot precede month-end. A non-cancelled payslip is unique per employee/month; separate runs can cover different employee groups.
2. Open the draft run. For each employee, review paid calendar days, component amounts, and variable earnings such as commission or overtime. **Save reviewed inputs** requires a note explaining the inputs. Payroll starts with calendar employment days, including partial joining/leaving months, and prorates only components whose checkbox is selected. An inactive/former employee needs a leaving date establishing eligibility for the period. A mid-month pay-plan change requires an explicit draft component adjustment; automatic within-month plan splitting is not included.
3. With Employee Money Read, select approved, funded employee balances and recovery amounts. These become explicit deduction lines against the receivable accounts. The available amount is rechecked at posting; a draft allocation reserves no funds. Changing pay-plan or employee eligibility information does not silently recalculate an existing run.
4. An authorized reviewer selects **Approve and post**. Non-admin users cannot post a run they created or last edited. Posting freezes the run, creates employee-level GL accruals once, and applies recovery allocations. Earnings minus deductions equals net pay; employer contributions are additional expense/liability lines and do not reduce net pay. Deductions cannot exceed gross pay.
5. Finance records salary payments in each employee section. Partial payments are allowed up to net salary outstanding. Approval and payment are separate: the register shows Unpaid, Partly paid, or Paid. Payment dates cannot precede payroll posting.
6. Use **Export payroll CSV** for the run's employee amounts, cost centers, contributions, paid amounts, and outstanding amounts. Open an employee payslip and use **Print / Save PDF** through the browser. Draft and cancelled outputs are clearly labelled. Individual payslips are also available under Payroll → Individual payslips; access can be narrower than access to an entire run.

Payroll currently uses reviewed manual amounts for statutory deductions, employer contributions, commission, and paid days. It does not automatically calculate PAYE/NSSF, commission formulas, overtime, or attendance/leave deductions. Enter policy-approved calculated amounts as components. Leave balances and attendance remain independently tracked.

Run totals and exports are visible only when every employee, snapshot cost center, and component account in the run is permitted. Individual payslips enforce that employee's permissions without exposing other employees' amounts. The payroll register shows the latest 200 permitted runs and the payslip list the latest 1,000 records within the retrieved recent records.

### Payroll cancellation and accounting

Cancel active salary payments before cancelling payroll. A posted cancellation requires a date no earlier than payroll posting and a reason. It reverses the accrual, restores employee recovery balances, preserves the original records, and permits a replacement payroll for the employee/month. Salary payments and employee-money payments have their own reversal actions and dates. Posted records cannot be edited.

HR accounting appears in General Ledger and financial totals. New HR transaction details in General Ledger and its exports require the matching Payroll or Employee Money Read permission, plus applicable employee/cost-center/account scopes. General Ledger cannot be used to bypass HR access. HR vouchers are excluded from the generic journal reference picker; settle them through HR so their allocations remain correct. Financial statement totals still include posted HR accounting.

No ERPNext salary slips, leave balances, advances, or opening employee balances are imported automatically. Existing employee masters are reused. Reconcile and agree any historical/opening data separately before a payroll cutover.
