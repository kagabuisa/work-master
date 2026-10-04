# Work Master

Node/Express app for sales invoices, purchases, inventory, and accounting. It syncs ERP/MySQL master data into local Postgres tables and stores app-created vouchers in Postgres.

## Run

```bash
npm install
npm start
```

Open the URL printed by the server. In this workspace it uses `PORT` from `.env`.
When `INVOICE_STORE=postgres` points to localhost, `npm start` starts the installed PostgreSQL service if it is stopped. Starting a stopped service requires permission to manage system services. Remote and Docker PostgreSQL connections are left to their own service managers.

Create the first login account on the app server:

```bash
npm run user:create -- admin
```

The command prints a one-time temporary password. Log in with it and set a new password when prompted. To add another user, run the same command with a different username. Passwords are stored as salted scrypt hashes; sessions last seven days and are revoked when the password changes. User accounts and sessions are stored in Postgres when `INVOICE_STORE=postgres`, or in `data/auth.json` for local JSON storage.

The app includes Standard, Privileged, Admin, Retail, Wholesale, Finance, Logistics, and Management as built-in roles. The five department roles start with Standard access. At **Settings → Roles**, an admin searches for a role and selects a permission type from grouped Voucher types, Master lists, Payments, Reports, and Accounts options. Each report, including Debtors, Stock Ledger, Stock Movement, Gross Profit, General Ledger, Trial Balance, Profit & Loss, and Balance Sheet, has its own Read permission row. Accounts controls account creation; Chart of Accounts controls viewing the account list. Only ERPNext sync remains under **Other access**. Admin's full access cannot be changed. Assign roles at **Settings → Users**. Built-in roles cannot be deleted; a custom role can be deleted after all users are moved to another role. Permission changes take effect on the next request. Existing roles with the old Reports grant receive all individual report permissions during migration.

Only admins can create, edit, activate, deactivate, or delete master records. A new master record is saved inactive; its Active switch controls whether it appears in lookups and operations. Submitted and cancelled master states are no longer exposed. Existing imported active records remain available. Manual journals retain their draft, submit, and cancel workflow because submission posts ledger entries.

Sales and purchase vouchers require an active Price List. An active Item Price on that list supplies the suggested rate for its item; otherwise sales use the item's default rate and purchases use its unit cost. Existing voucher lines keep their saved rates. A master record referenced elsewhere may be deactivated, but deletion can be blocked by database references.

Existing customer-group and supplier-type role restrictions are cleared during this migration. Role access is controlled by the selected permission rows. Admin always has full access.

The first existing account becomes admin when upgrading to roles (preferring the username `admin`); the first account created in a new installation is admin. Later CLI accounts default to Standard. To choose a role from the command line, run `npm run user:create -- <username> <role-slug>`.

To reset a user's password, run `npm run user:reset -- admin` on the same app server. This prints a new temporary password and revokes existing sessions. If the username does not exist, the command creates it. For Docker deployments, run `docker compose exec invoice-app npm run user:reset -- admin` after building the updated image. Accounts created outside the deployment container may use a different database.

By default, local runs keep using `data/invoices.json`. To store created invoices in Postgres, set:

```bash
INVOICE_STORE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=work_master
POSTGRES_USER=invoice_user
POSTGRES_PASSWORD=invoice_password
```

You can use `POSTGRES_URL` or `DATABASE_URL` instead of the separate Postgres fields.

## Run With Docker

```bash
docker compose up -d --build
docker compose exec invoice-app npm run user:create -- admin
```

Then open the app on the port configured in `.env`, for example:

```bash
http://localhost:3020
```

Useful commands:

```bash
docker compose logs -f
docker compose down
docker compose restart
```

Docker stores created invoices in the named volume `invoice-data`, so they survive image rebuilds and container restarts.
With the included Compose file, created invoices are stored in Postgres by default and survive restarts in the `postgres-data` volume.

## What It Does

- Searches item master data from the local Postgres `app_master_items` table. Use `npm run import:mysql-items` to sync ERP/MySQL items into that table.
- Searches customers and suppliers from local Postgres master tables. Use `npm run import:mysql-customers`, `npm run import:mysql-suppliers`, or `npm run import:mysql-master-data` to sync ERP/MySQL master data.
- Creates invoices with line items, discounts, tax, multiple payments, and debtor balances.
- Lists invoices and shows a print-friendly invoice page.
- Stores created invoices in Postgres when `INVOICE_STORE=postgres`, otherwise in `data/invoices.json`.
- In Postgres mode, submitted invoices reduce local stock, calculate COGS/gross profit, and post local GL entries.
- In Postgres mode, stock entries, customer payments, cancellations, and manual journals post to the local double-entry ledger.
- Creates combined Purchase vouchers: choose a supplier, items, warehouse, quantities, and costs; save a draft, then submit to receive stock and create the payable. Record one or more supplier payments on the same voucher. Purchases require Postgres storage and active supplier, item, and warehouse master records.
- Creates Purchase Order vouchers with supplier, expected delivery date, warehouse, items, quantities, and costs. Orders can be saved as drafts, submitted, or cancelled. They require Postgres storage and active buying master records. Submitting an order does not receive stock or create a payable; record the delivery separately as a Purchase voucher.
- Includes accounting reports for General Ledger, Trial Balance, Profit and Loss, and Balance Sheet.

Purchase vouchers currently cover stock items and supplier payments. They do not yet calculate purchase tax or discounts, or support cancellation, returns, or payment edits after submission. Existing Purchase Receipt stock entries remain in the stock ledger; do not record the same delivery again as a Purchase voucher.

## Pricing Master Lists

Open **Settings → Price Lists** or **Settings → Item Prices**. Price lists have a name, currency (default UGX), Buying/Selling direction, and Pricelist Type (Retail, Wholesale, or Distribution). Existing ERPNext records with no matching type show Unspecified until edited. Only an admin can create, update, activate, deactivate, or delete a price list. A new price list is saved inactive; turn Active on before adding item prices to it. Item prices link an active submitted item to an active price list, with a non-negative rate per stock UOM in that list's currency.

All master lists support search, pagination, row editing, record tracking, and Previous/Next navigation. The list and form show an Active switch (`1` for available, `0` for unavailable); Save creates an inactive record, and Update appears when an edit changes a field. Admin can edit saved records and delete records that have no blocking references. Price Lists and Item Prices migrate their old `disabled` columns to `active` at startup. The six other master tables expose a generated `active` column while retaining `disabled` internally for compatibility with existing ERPNext import scripts. Price Lists and Item Prices have no Submit or Cancel actions. A price list can be deactivated even when it has item prices; those prices are unavailable until the list is activated again.

The tables are created automatically at app startup in Postgres mode. Import price lists from the configured old ERPNext MySQL database with `npm run import:mysql-price-lists` on the app server. The import preserves ERPNext names, currencies, buying/selling types, and enabled states. It skips same-named local lists, so rerunning it does not overwrite local edits; it fills missing Pricelist Type values when the source uses one of the three supported choices. Sales and purchase vouchers require an active UGX price list. An active Item Price on the chosen list takes priority over the item's base rate in lookups.

Import ERPNext Item Prices for the locally active price lists with `npm run import:mysql-item-prices`. Use `npm run import:mysql-item-prices -- --dry-run` to see counts first. The import adds source item-price details to the local table and edit form, including cost history, packaging, promotion fields, and ERPNext source metadata. It also adds source items that those prices need and that are absent locally. Every source price is retained; when ERPNext has several prices for one item and list, the most recently modified is active and earlier prices remain inactive. A rerun skips imported ERPNext IDs and preserves local edits.

## Accounting Utilities

Backfill GL entries for existing submitted invoices, payments, and stock entries:

```bash
npm run backfill:accounting
```

Verify current accounting consistency:

```bash
npm run verify:accounting
```

The verification script checks voucher balance, overall GL balance, balance sheet balance, Accounts Receivable against submitted invoices minus payments, and Inventory against local stock value.

## Development Plans

- [Accounting development plan](docs/accounting-development-plan.md)

## Important

The current MySQL user is still used only for reading ERPNext tables. Stock and accounting entries created by this app are local to the app's Postgres database and are not written back to ERPNext.

The **Reports → Daily Activity** page reads Daily Activity Report vouchers directly from the configured ERPNext MySQL source. It filters by date, shop/unit, status, and text, and opens each DAR voucher in a read-only detail view with its sales, expenses, delivery report, and remarks. This page requires the Daily Activity report Read permission and does not copy or edit ERPNext records.
