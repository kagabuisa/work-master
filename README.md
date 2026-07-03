# Invoice App

Small Node/Express app for creating sales invoices. It reads items and customers from the ERP/MySQL database configured in `.env`, and can store app-created invoices in Postgres.

## Run

```bash
npm install
npm start
```

Open the URL printed by the server. In this workspace it uses `PORT` from `.env`.

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

- Searches ERPNext/MySQL items from `tabItem`, `tabItem Price`, and `stock_balance`.
- Searches customers from `tabCustomer`.
- Creates invoices with line items, discounts, tax, multiple payments, and debtor balances.
- Lists invoices and shows a print-friendly invoice page.
- Stores created invoices in Postgres when `INVOICE_STORE=postgres`, otherwise in `data/invoices.json`.
- In Postgres mode, submitted invoices reduce local stock, calculate COGS/gross profit, and post local GL entries.
- In Postgres mode, stock entries, customer payments, cancellations, and manual journals post to the local double-entry ledger.
- Includes accounting reports for General Ledger, Trial Balance, Profit and Loss, and Balance Sheet.

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
