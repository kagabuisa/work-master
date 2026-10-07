# Work Master app guide

This guide describes the current app behavior. Update the relevant section whenever a user-facing workflow, validation rule, permission, or report changes. The implementation and tests remain the source of truth when older documentation disagrees.

## Sign-in and access

- Users sign in with a PostgreSQL-backed account. Sessions have a seven-day maximum lifetime and end after five minutes without activity. An idle open page returns to the login screen. Activity in an open form keeps its session alive.
- Roles grant actions on vouchers, master lists, payments, accounts, and reports. An admin can adjust a user's permissions and assign permitted records in **Settings → Users**. See [Permissions and voucher visibility](permissions.md) for ownership and scope rules.
- In **Settings → Roles → Role permissions** and **User permissions**, choose a role or user, then tick actions in the permission table. Checkbox changes save automatically. Unticking Read clears the row's actions and removes the row after saving. To add a row, choose a voucher, master list, or other permission type below the table. The second field offers specific records when available: for example, choose **Warehouse** first, then choose a warehouse in **Specific record**. Choosing **Accounts** or **Chart of Accounts** offers the saved accounts. Leave the second field at **No specific record** to save the broad type. Price lists also offer specific records; User permissions additionally offers cost centers and employees. If the chosen permission already has a row, edit that row's checkboxes instead. A user's assigned default record is changed through **Edit default** on the Edit user page; its Read box stays selected until that default changes.
- Available navigation and actions depend on the signed-in user's permissions. The server also checks those permissions on requests.
- A Standard user with General Ledger Read sees a General Ledger link under Reports. The report shows entries from their own vouchers or assigned sales invoices, limited to their permitted accounts and customer or supplier categories.

## Vouchers

| Voucher | Where to find it | Main workflow |
| --- | --- | --- |
| Sales Invoice and Cash Sales Invoice | **Sales → Sales Invoices** | Create or edit a draft, then submit. Cash sale submission records a payment with the invoice. Submitted invoices post stock cost and accounting entries. Payments and cancellations have their own actions. |
| Purchase Order | **Purchases → Purchase Orders** | Save, edit, submit, or cancel an order. An order can lead to a Purchase Invoice for the quantity received. Submitting the order alone does not receive stock or create a payable. |
| Purchase Invoice | **Purchases → Purchase Invoices** | Save a draft, then submit to receive stock and create the payable. Record and cancel supplier payments from the submitted voucher. Cancelling a purchase reverses its stock and ledger entries. |
| Stock Entry | **Stocks → Stock Entries** | Record opening stock, purchase receipts, transfers, adjustments, or a cancellation entry. The entry type determines its stock movement. |
| Stock Reconciliation | **Stocks → Stock Reconciliation** | Load warehouse stock, enter physical counts, save a draft, then submit the differences. A submitted reconciliation can be cancelled with a reversal. |
| Journal Entry | **Accounts → Journals** | Enter two or more account lines, save a draft or post it, and cancel eligible manual journals. Posting creates general ledger entries. Automatically generated journals are managed from their source voucher. |

On a voucher form, press **Ctrl+S** (or **Command+S** on Mac) to use its Save action. The shortcut does not submit or post the voucher.
Voucher drawers show the reason for an access denial and distinguish a missing voucher from a server error. For a journal created by the signed-in user, an account permission denial names the restricted line accounts.
The Journals list and report include a journal only when every line account is permitted, including journals created by the signed-in user.
The Journals report column picker includes **User**, which shows the login that created each journal. Creator login can be matched through the User filter or the main Search field; both apply to CSV downloads.

### Sales invoice details

- New invoices start with the current Kampala **Posting Date** and **Posting Time**; both can be changed. The stored `invoice_date` field is the posting date used by the invoice and ledger workflows. **Due Date** is separate.
- New invoices select the user's assigned warehouse and retail price list when those choices are permitted and available. Without an assigned retail list, the form selects **Retail Pricelist** when it is active and permitted. The user can change either field before saving. **Ext Invoice** holds an optional outside invoice reference.
- The full view and print view show the invoice number directly below the **Sales Invoice** or **Cash Sales Invoice** title. The drawer also shows the number.
- Sales invoice lists and reports label the date as a posting date. The sales invoice report supports filters, selectable columns, and CSV download.
- Price lists and item prices supply suggested rates. Existing invoice lines retain their saved rates.
- Duplicating an invoice fills each copied line's Stock column with the current balance in the selected warehouse when the duplicate form opens. The balance is checked again when the invoice is saved or submitted.

### Journal account rules

- Every amount-bearing line needs an account. A single line cannot contain both a debit and a credit.
- Total debits must equal total credits.
- An account may appear on multiple debit lines or multiple credit lines, but it cannot appear on **both** sides of the same journal. The form shows this conflict, and the server rejects it when saving or posting. Submitting an older draft applies the same rule.

## Other app functions

- **Settings** manages customers, suppliers, items, warehouses, employees, cost centers, price lists, item prices, company details, users, and roles. Master record actions require the corresponding permissions.
- **Accounts** includes the chart of accounts and journals.
- **Reports** includes debtors, stock ledger, stock movement, gross profit, general ledger, trial balance, profit and loss, balance sheet, and Daily Activity. Each report has its own Read permission. Daily Activity reads ERPNext data and is read-only in this app.
- App-created vouchers and accounting data are stored in PostgreSQL. ERPNext/MySQL supplies imported master data and the read-only Daily Activity report; app-created entries are not written back to ERPNext.

## Keeping this guide current

When a feature changes, update its workflow and rules here in the same work as the code. Update [Permissions and voucher visibility](permissions.md) for access changes and the [README](../README.md) for setup, deployment, or operational changes. Describe behavior that users can observe; keep field names and implementation details only where they clarify a workflow.
