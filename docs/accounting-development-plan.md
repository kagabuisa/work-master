# Accounting Development Plan

## Goal

Add a Postgres-backed double-entry accounting layer to the invoice and stock app. Accounting should be posted from existing business events: invoice submission, customer payments, stock entries, and stock cancellations.

The general ledger should become the accounting source of truth. Existing invoice, payment, stock balance, and stock ledger tables remain operational records.

## Current App Context

- The app is a Node/Express/EJS app.
- ERPNext/MySQL is used for read-only item, customer, and warehouse lookup.
- App-created invoices, payments, stock entries, stock balances, and stock ledger rows are stored in Postgres when `INVOICE_STORE=postgres`.
- Stock management already requires Postgres, so accounting should also be Postgres-only.
- Invoice submission currently reduces stock and records item cost and gross profit.
- Customer payments currently update invoice payment totals and payment status.

## Accounting Scope

### In Scope

- Chart of accounts.
- General ledger entries.
- Posting rules for:
  - Sales invoices.
  - Customer payments.
  - Stock purchases.
  - Opening stock.
  - Stock adjustments.
  - Stock cancellations/reversals.
- Accounting reports:
  - General ledger.
  - Trial balance.
  - Profit and loss.
  - Balance sheet.
- Backfill/repost script for existing submitted invoices, payments, and stock entries.

### Out of Scope for First Version

- Full ERPNext accounting synchronization.
- Multi-company accounting.
- Multi-currency accounting.
- Supplier invoice aging.
- Bank reconciliation.
- Fiscal period locking.
- Tax authority filing.

## Data Model

Add these tables in `initPostgresStore()`.

### `app_accounts`

Stores the chart of accounts.

Suggested columns:

- `id BIGSERIAL PRIMARY KEY`
- `account_code TEXT UNIQUE`
- `account_name TEXT NOT NULL`
- `account_type TEXT NOT NULL`
- `normal_balance TEXT NOT NULL`
- `parent_account_id BIGINT REFERENCES app_accounts(id)`
- `is_group BOOLEAN NOT NULL DEFAULT false`
- `is_active BOOLEAN NOT NULL DEFAULT true`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Recommended account types:

- `asset`
- `liability`
- `equity`
- `income`
- `expense`

### `app_accounting_settings`

Stores default account mappings used by posting code.

Suggested columns:

- `setting_key TEXT PRIMARY KEY`
- `account_id BIGINT NOT NULL REFERENCES app_accounts(id)`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Required default mappings:

- `accounts_receivable`
- `cash`
- `bank`
- `mobile_money`
- `card_clearing`
- `sales_income`
- `tax_payable`
- `inventory`
- `cost_of_goods_sold`
- `accounts_payable`
- `opening_equity`
- `stock_adjustment_gain`
- `stock_adjustment_loss`

### `app_gl_entries`

Stores posted debit and credit lines.

Suggested columns:

- `id BIGSERIAL PRIMARY KEY`
- `posting_date DATE NOT NULL`
- `account_id BIGINT NOT NULL REFERENCES app_accounts(id)`
- `party_type TEXT`
- `party_id TEXT`
- `party_name TEXT`
- `voucher_type TEXT NOT NULL`
- `voucher_id BIGINT`
- `voucher_no TEXT`
- `line_no INTEGER NOT NULL`
- `debit NUMERIC(14, 2) NOT NULL DEFAULT 0`
- `credit NUMERIC(14, 2) NOT NULL DEFAULT 0`
- `remarks TEXT`
- `is_reversal BOOLEAN NOT NULL DEFAULT false`
- `reversal_of_voucher_type TEXT`
- `reversal_of_voucher_id BIGINT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Recommended constraints:

- `CHECK (debit >= 0 AND credit >= 0)`
- `CHECK (debit = 0 OR credit = 0)`
- Unique index on `(voucher_type, voucher_id, line_no)`.
- Index on `(posting_date, account_id)`.
- Index on `(voucher_type, voucher_id)`.
- Index on `(party_type, party_id)`.

## Posting Helper

Create a reusable helper in `src/store.js` or a new `src/accounting.js`.

Suggested API:

```js
async function postGlEntry(client, {
  posting_date,
  voucher_type,
  voucher_id,
  voucher_no,
  party_type,
  party_id,
  party_name,
  remarks,
  lines,
})
```

Each line should include:

- `account_key` or `account_id`
- `debit`
- `credit`
- optional `party_type`, `party_id`, `party_name`
- optional `remarks`

The helper must:

- Resolve account keys through `app_accounting_settings`.
- Reject unbalanced entries.
- Reject entries with both debit and credit on the same line.
- Insert all lines in the caller's transaction.
- Be idempotent per voucher by replacing existing GL lines before inserting new ones, except for cancellation workflows where explicit reversal rows are preferable.

## Posting Rules

### Sales Invoice Submission

Trigger from invoice submission after stock cost is calculated.

Entry:

- Dr Accounts Receivable: invoice total.
- Cr Sales Income: taxable/net sales amount.
- Cr Tax Payable: tax amount, if tax exists.
- Dr Cost of Goods Sold: total item cost.
- Cr Inventory: total item cost.

Notes:

- Use invoice date as `posting_date`.
- Use `voucher_type = 'sales_invoice'`.
- Use invoice id and invoice number as voucher identifiers.
- Store customer as party on Accounts Receivable.
- Cost values should come from `app_invoice_items.cost_amount`.

### Customer Payment

Trigger when a payment is added or updated.

Entry:

- Dr Cash/Bank/Mobile Money/Card Clearing: payment amount.
- Cr Accounts Receivable: payment amount.

Payment method mapping:

- `cash` -> `cash`
- `bank` -> `bank`
- `mobile_money` -> `mobile_money`
- `card` -> `card_clearing`
- `other` -> choose `cash` initially, then add a configurable mapping later.

Notes:

- Use payment date as `posting_date`.
- Use `voucher_type = 'customer_payment'`.
- Use a stable voucher id. A simple first version can use the payment table primary key. If unavailable in existing helper flow, use invoice id plus payment number through a dedicated lookup.
- Store customer as party on Accounts Receivable.

### Opening Stock

Trigger when a submitted stock entry has `entry_type = 'opening'`.

Entry:

- Dr Inventory: stock value.
- Cr Opening Equity: stock value.

### Stock Purchase

Trigger when a submitted stock entry has `entry_type = 'purchase'`.

Entry:

- Dr Inventory: purchased stock value.
- Cr Accounts Payable: purchased stock value.

First version can credit Accounts Payable even if supplier details are partial. Later, add supplier payments.

### Stock Adjustment

Trigger when a submitted stock entry has `entry_type = 'adjustment'`.

Increase:

- Dr Inventory.
- Cr Stock Adjustment Gain.

Decrease:

- Dr Stock Adjustment Loss.
- Cr Inventory.

### Stock Transfer

No general ledger impact in the first version because the app tracks one Inventory account. Keep stock ledger movement only.

If warehouse-specific inventory accounts are added later, post:

- Dr Target Warehouse Inventory.
- Cr Source Warehouse Inventory.

### Cancellation/Reversal

When a posted stock entry is cancelled:

- Insert reversal GL rows with debit and credit swapped.
- Set `is_reversal = true`.
- Link back with `reversal_of_voucher_type` and `reversal_of_voucher_id`.

Invoice cancellation is not currently part of the app. If added later, follow the same explicit reversal pattern.

## Reports

### General Ledger

Route: `/reports/general-ledger`

Filters:

- Date range.
- Account.
- Party.
- Voucher type.
- Search by voucher number or remarks.

Columns:

- Posting date.
- Account.
- Party.
- Voucher.
- Remarks.
- Debit.
- Credit.
- Running balance.

### Trial Balance

Route: `/reports/trial-balance`

Filters:

- Date range.

Columns:

- Account code.
- Account name.
- Opening debit.
- Opening credit.
- Period debit.
- Period credit.
- Closing debit.
- Closing credit.

Validation:

- Total closing debit must equal total closing credit.

### Profit and Loss

Route: `/reports/profit-and-loss`

Filters:

- Date range.

Sections:

- Income.
- Cost of goods sold.
- Gross profit.
- Expenses.
- Net profit.

### Balance Sheet

Route: `/reports/balance-sheet`

Filters:

- As-of date.

Sections:

- Assets.
- Liabilities.
- Equity.

Validation:

- Assets must equal liabilities plus equity.

## Implementation Phases

### Phase 1: Schema and Seed Accounts

- Add `app_accounts`, `app_accounting_settings`, and `app_gl_entries`.
- Seed a minimal chart of accounts during store initialization.
- Seed default account mappings.
- Add indexes and constraints.

Acceptance checks:

- App starts with a fresh Postgres database.
- Seed is idempotent.
- Required account mappings exist.

### Phase 2: Posting Infrastructure

- Add account lookup helpers.
- Add `postGlEntry`.
- Add balance validation.
- Add voucher-level repost behavior.

Acceptance checks:

- Balanced entry inserts successfully.
- Unbalanced entry is rejected.
- Reposting the same voucher does not duplicate GL lines.

### Phase 3: Sales Invoice Accounting

- Post GL entries when submitting an invoice.
- Include receivable, sales, tax, COGS, and inventory lines.
- Keep all posting inside the existing invoice submission transaction.

Acceptance checks:

- Submitting an invoice creates balanced GL entries.
- Invoice cost lines match `app_invoice_items.cost_amount`.
- Duplicate submit does not duplicate GL entries.

### Phase 4: Payment Accounting

- Post GL entries when adding a payment.
- Repost GL entries when updating a payment.
- Map payment methods to configured asset accounts.

Acceptance checks:

- Payment decreases receivable in the GL.
- Updating payment amount/date/method updates the GL.
- Invoice payment totals and GL entries stay consistent.

### Phase 5: Stock Entry Accounting

- Post opening, purchase, and adjustment entries.
- Skip transfer entries for GL in first version.
- Add reversal GL entries for stock cancellation.

Acceptance checks:

- Stock purchase increases Inventory in both stock balance and GL.
- Stock decrease adjustment credits Inventory.
- Cancellation creates reversal GL entries.

### Phase 6: Reports

- Add store functions for general ledger, trial balance, P&L, and balance sheet.
- Add Express routes.
- Add EJS report views.
- Add navigation links from dashboard or report pages.

Acceptance checks:

- General ledger filters work.
- Trial balance balances.
- P&L agrees with gross profit directionally for invoice sales and COGS.
- Balance sheet balances after posted transactions.

### Phase 7: Backfill Existing Data

- Add a script to clear and rebuild GL entries from existing submitted invoices, payments, and submitted/cancelled stock entries.
- Run in a transaction where practical.
- Produce an audit log with counts by voucher type and any skipped records.

Acceptance checks:

- Existing submitted invoices receive GL entries.
- Existing payments receive GL entries.
- Trial balance balances after backfill.

## Testing Plan

Add focused tests or smoke scripts for these workflows:

- Submit invoice with no tax.
- Submit invoice with tax.
- Submit invoice with multiple items and COGS.
- Add cash payment.
- Add mobile money payment.
- Update payment method and amount.
- Create opening stock entry.
- Create purchase stock entry.
- Create stock adjustment increase and decrease.
- Cancel stock entry.
- Run trial balance after all workflows.

At minimum, add a script similar to the existing stock smoke scripts that creates sample transactions in a test database and verifies:

- Every voucher's GL debits equal credits.
- Overall GL debits equal credits.
- Accounts Receivable equals submitted invoice totals minus payments.
- Inventory GL balance agrees with `app_stock_balances.stock_value`.

## Risks and Decisions

- Accounting must not be added to JSON-file mode. It needs Postgres transactions and constraints.
- The app currently reads ERPNext/MySQL but does not write ERPNext accounting entries. This accounting layer is local to this app unless a later ERPNext sync is built.
- Payment rows need stable identifiers for clean voucher posting. If `payment_no` is not enough, use the `app_invoice_payments.id` primary key in the posting flow.
- Tax rules are currently simple. More complex VAT handling should be deferred until tax categories and tax accounts are modeled explicitly.
- Inventory is modeled as one account in the first version. Warehouse-specific inventory accounts can be added later.

## Suggested First Pull Request

Keep the first change small:

- Add accounting schema.
- Seed default accounts.
- Add `postGlEntry`.
- Post GL for sales invoice submission only.
- Add a simple general ledger report.

This creates the foundation without mixing every accounting workflow into the first change.
