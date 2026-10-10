# Work Master

Node/Express app for sales invoices, purchases, inventory, and accounting. It syncs ERP/MySQL master data into local Postgres tables and stores app-created vouchers in Postgres.

## Run

```bash
npm install
npm start
```

Excel count-sheet downloads and uploads use the ExcelJS dependency installed by `npm install`/`npm ci`. After updating an existing installation, install the updated dependencies and restart the app; Docker deployments must rebuild the app image. Count-sheet uploads are limited to 5 MB and are processed in memory without retaining the uploaded workbook. Scanned reconciliation sheets (PDF/JPG/PNG/CSV/XLS/XLSX) are stored in PostgreSQL with their voucher link and uploader metadata, so include them in database backups. Startup creates the attachment table and upgrades its allowed file types when needed. Scan uploads allow three files per request, up to 10 MB each; files are removed when their voucher is deleted.

Open the URL printed by the server. In this workspace it uses `PORT` from `.env`.
When PostgreSQL points to localhost, `npm start` starts the installed service if it is stopped. Starting a stopped service requires permission to manage system services. Remote and Docker PostgreSQL connections are left to their own service managers.

Create the first login account on the app server:

```bash
npm run user:create -- admin
```

The command prints a one-time temporary password. Log in with it and set a new password when prompted. To add another user, run the same command with a different username. Passwords are stored as salted scrypt hashes; sessions have a seven-day maximum lifetime, end after five minutes of inactivity, and are revoked when the password changes. User accounts and sessions are stored in PostgreSQL.

The app includes Standard, Privileged, Admin, Retail, Wholesale, Finance, Logistics, and Management as built-in roles. The five department roles start with Standard access. At **Settings → Roles**, an admin searches for a role and selects a permission type from grouped Voucher types, Master lists, Payments, Reports, and Accounts options. Each report, including Debtors, Stock Ledger, Stock Movement, Gross Profit, General Ledger, Trial Balance, Profit & Loss, and Balance Sheet, has its own Read permission row. Accounts controls account creation; Chart of Accounts controls viewing the account list. Only ERPNext sync remains under **Other access**. Admin's full access cannot be changed. Assign roles at **Settings → Users**. Built-in roles cannot be deleted; a custom role can be deleted after all users are moved to another role. Permission changes take effect on the next request. Existing roles with the old Reports grant receive all individual report permissions during migration.

See [Permissions and voucher visibility](docs/permissions.md) for role inheritance, user overrides, permitted records, and Standard users' voucher ownership rules.

See the [app guide](docs/app-guide.md) for current voucher workflows, validation rules, and other user-facing functions. Keep it updated with each behavior change.

Master record actions require the corresponding master list permissions. A new master record is saved inactive; its Active switch controls whether it appears in lookups and operations. Submitted and cancelled master states are no longer exposed. Existing imported active records remain available. Manual journals retain their draft, submit, and cancel workflow because submission posts ledger entries.

Sales and purchase vouchers require an active Price List. An active Item Price on that list supplies the suggested rate for its item; otherwise sales use the item's default rate and purchases use its unit cost. Existing voucher lines keep their saved rates. A master record referenced elsewhere may be deactivated, but deletion can be blocked by database references.

Role permissions, user overrides, and assigned record scopes together control access. Admin always has full access.

The first existing account becomes admin when upgrading to roles (preferring the username `admin`); the first account created in a new installation is admin. Later CLI accounts default to Standard. To choose a role from the command line, run `npm run user:create -- <username> <role-slug>`.

To reset a user's password, run `npm run user:reset -- admin` on the same app server. This prints a new temporary password and revokes existing sessions. If the username does not exist, the command creates it. For Docker deployments, run `docker compose exec invoice-app npm run user:reset -- admin` after building the updated image. Accounts created outside the deployment container may use a different database.

PostgreSQL is the only application store. Configure its connection with:

```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=work_master
POSTGRES_USER=invoice_user
POSTGRES_PASSWORD=invoice_password
```

You can use `POSTGRES_URL` or `DATABASE_URL` instead of the separate Postgres fields.

## Production transport and database TLS

For Nginx, set `client_max_body_size 32m;` inside the app server block so three 10 MB reconciliation attachments plus multipart overhead can reach the app. Validate with `nginx -t` and reload Nginx after changing the configuration. The application still enforces 10 MB per attachment; the proxy limit applies to the whole request.

For a TLS reverse proxy, set `TRUST_PROXY=true` and forward the original Host and `X-Forwarded-Proto: https`. Restrict direct access to the app to that proxy. Production always issues Secure session cookies unless `ALLOW_INSECURE_COOKIES=true` explicitly enables HTTP on a trusted private network. `TLS_TERMINATED_PROXY` alone does not satisfy the startup check. Set one of these supported configurations before starting the production Docker image.

Mutation requests with an Origin must match the app origin, including scheme and port; sibling subdomains are rejected. Non-browser clients without Origin remain supported.

Pages use `Referrer-Policy: same-origin` so browsers preserve the Origin on same-origin form submissions while withholding referrers from external sites. A `no-referrer` policy can cause form POST requests to carry `Origin: null` and be rejected with “Request origin is not allowed.”

Enable PostgreSQL TLS with `POSTGRES_SSL=true` (or `PGSSL=true`) and ERPNext MySQL TLS with `DB_SSL=true`. Server certificates are verified. For a private CA, set `POSTGRES_SSL_CA_FILE` or `DB_SSL_CA_FILE` to a readable PEM file; mount that file into Docker when applicable. Invalid or missing CA files fail connection setup.

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

The Docker image includes the operational scripts, tests, and app documentation. Run supported imports and accounting utilities with `docker compose exec invoice-app npm run <command>`. Release checks still require a dedicated test database as described below.

Docker stores application records in the `postgres-data` volume and uploaded project files in the `invoice-data` volume. Both survive image rebuilds and container restarts.

## Performance operations

The server logs requests slower than `SLOW_REQUEST_MS` (default 300 ms). Measure response-time percentiles and database load under realistic data and concurrent users before changing capacity. PostgreSQL's `pg_stat_statements` extension can identify queries with the highest total execution time; it needs to be loaded in `shared_preload_libraries` and enabled by a database administrator. Use `EXPLAIN (ANALYZE, BUFFERS)` on slow read queries in a staging database with production-sized data. Keep autovacuum enabled and check that it keeps up with invoice, ledger, and session table activity. Display-format settings are cached for 30 seconds per app process, and simultaneous cache refreshes share one database read.

Run a read-only HTTP check against a representative staging deployment with an authenticated session cookie:

```bash
PERF_COOKIE='wm_session=your-staging-session-token' npm run perf:http -- --url=http://localhost:3020/invoices --requests=200 --concurrency=20
```

The command reports response status counts, failures, requests per second, and 50th/95th/99th percentile latency. It issues only GET requests and stops after the requested count. A redirect to login counts as a failure; set `PERF_COOKIE` in the shell without putting a real session token in source control. Run the same scenario with production-sized staging data at several concurrency levels, and compare the latency and error rate. Results include the app's short-lived caches, so compare a cold run and a warm run when diagnosing database load.

The invoice list limits each page to at most 200 rows. Pages without text search select their invoice IDs before joining payment totals and restrict journal calculations to those invoices; text searches still calculate totals before filtering because status and paid amount are searchable. A startup migration creates a partial index on relevant journal reference numbers using `CREATE INDEX CONCURRENTLY`. On a large existing journal table, allow time for this migration before the app begins accepting requests. The short-lived in-process invoice-list cache holds at most 200 filter combinations and shares a pending query among simultaneous requests for the same list. Each app process has its own cache and PostgreSQL connection pool, so account for all app instances when sizing database connections. A local development database with only a few invoices cannot establish peak-load performance; test the expected data volume and concurrent workload in staging.

## Release checks

Run `npm run release:check` before deploying. It runs the unit suite, upgrades a
version-1 test schema, compares accounting reports with the golden snapshot, and
checks invoice, cash sale, payment, stock, and journal postings. GitHub Actions
runs the same gate on pushes and pull requests.

Point the command at a dedicated Postgres database whose name ends in `_test` or
`_golden`, owned by the test database user. The accounting tests **drop and recreate
its public schema**. The test user must also own `public` and have CREATE on the
test database. On PostgreSQL 14, a database administrator may need to run
`ALTER SCHEMA public OWNER TO invoice_user` while connected to the test database.
The runner checks these permissions and refuses to reset another database. For
example, with an existing `work_master_test` database:

```bash
POSTGRES_DB=work_master_test npm run release:check
```

To run the complete suite, including every PostgreSQL integration check, use
`POSTGRES_DB=work_master_hr_test npm run test:postgres` with a dedicated database
whose name ends in `_hr_test`. This command enables all database test flags and
runs test files sequentially because several reset the public schema. It checks
the database name and schema ownership before running any tests. Set the database
connection URL to that test database too if a URL is configured.

If `POSTGRES_URL` or `DATABASE_URL` is configured, it takes precedence over
`POSTGRES_DB`; set that URL to the dedicated test database instead. Application
startup applies pending schema migrations under a database lock before accepting
requests. A required migration or backfill failure stops startup. Back up the live
database before upgrading. The current migration list is in `src/migrate.js`.

## What It Does

- Searches item master data from the local Postgres `app_master_items` table. Use `npm run import:mysql-items` to sync ERP/MySQL items into that table.
- Searches customers and suppliers from local Postgres master tables. Use `npm run import:mysql-customers`, `npm run import:mysql-suppliers`, or `npm run import:mysql-master-data` to sync ERP/MySQL master data.
- Creates invoices with line items, discounts, tax, multiple payments, and debtor balances.
- Lists invoices and shows a print-friendly invoice page.
- Stores created invoices in PostgreSQL.
- Submitted invoices reduce local stock, calculate COGS/gross profit, and post local GL entries.
- Stock entries, customer payments, cancellations, and manual journals post to the local double-entry ledger.
- Creates combined Purchase vouchers: choose a supplier, items, warehouse, quantities, and costs; save a draft, then submit to receive stock and create the payable. Record one or more supplier payments on the same voucher. Purchases require active supplier, item, and warehouse master records.
- Creates Purchase Order vouchers with supplier, expected delivery date, warehouse, items, quantities, and costs. Orders can be saved as drafts, submitted, or cancelled. They require active buying master records. Submitting an order does not receive stock or create a payable; record the delivery separately as a Purchase voucher.
- Includes accounting reports for General Ledger, Trial Balance, Profit and Loss, and Balance Sheet.

Purchase vouchers currently cover stock items and supplier payments. They support cancellation, which reverses stock and ledger entries, but do not yet calculate purchase tax or discounts or support returns or payment edits after submission. Existing Purchase Receipt stock entries remain in the stock ledger; do not record the same delivery again as a Purchase voucher.

## Pricing Master Lists

Open **Settings → Price Lists** or **Settings → Item Prices**. Price lists have a name, currency (default UGX), Buying/Selling direction, and Pricelist Type (Retail, Wholesale, or Distribution). Existing ERPNext records with no matching type show Unspecified until edited. Price list actions require the corresponding permissions. A new price list is saved inactive; turn Active on before adding item prices to it. Item prices link an active submitted item to an active price list, with a non-negative rate per stock UOM in that list's currency.

All master lists support search, pagination, row editing, record tracking, and Previous/Next navigation. The list and form show an Active switch (`1` for available, `0` for unavailable); Save creates an inactive record, and Update appears when an edit changes a field. Users with the corresponding permissions can edit saved records and delete records that have no blocking references. Price Lists and Item Prices migrate their old `disabled` columns to `active` at startup. The six other master tables expose a generated `active` column while retaining `disabled` internally for compatibility with existing ERPNext import scripts. Price Lists and Item Prices have no Submit or Cancel actions. A price list can be deactivated even when it has item prices; those prices are unavailable until the list is activated again.

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

The **Reports → Daily Activity** page reads Daily Activity Report vouchers directly from the configured ERPNext MySQL source. It filters by date, shop/unit, status, and text, and opens each DAR voucher in a read-only detail view with its sales, expenses, delivery report, and remarks. This page requires the Daily Activity report Read permission and is unavailable to Standard users because the ERPNext records cannot be reliably matched to their login. It does not copy or edit ERPNext records.

Schema migration 11 adds journal row invoice references and links supplier payment allocations to their journals. It runs automatically on app startup.

General Ledger downloads use ExcelJS for `.xlsx` files and PDFKit for PDF files. Install updated dependencies and restart the app after updating; Docker installations must rebuild the app image.

Import the current ERPNext chart of accounts with `npm run sync:erpnext-accounts` (preview with `-- --dry-run`). Configure `ERPNEXT_URL`, `ERPNEXT_USERNAME`, and `ERPNEXT_PASSWORD` for an ERPNext user who can read Accounts. This imports the accounts visible to that user into the existing PostgreSQL schema. Imported accounts receive unique four-digit local codes: 1xxx for assets, 2xxx for liabilities, 3xxx for equity, 4xxx for income, and 5xxx for expenses. Category groups and their posting accounts share numbering ranges. Existing numeric local codes are retained. ERPNext document names remain display names, preserving company suffixes and parent relationships, and are stored separately as source identifiers. Reruns preserve assigned codes, including subsequent local code edits; legacy imports that used document names as codes are numbered on their next sync. The import retains local accounts, posting defaults, and existing account IDs; reruns refresh imported names, detail types, parent links, and enabled states. The sync summary includes the number of recoded accounts. Account metadata is read before importing so older ERPNext versions without a disabled field are supported. Frozen accounts are imported inactive. Classification changes require manual review and abort the import. All account changes run in one transaction; connection or validation errors leave accounts unchanged.


## HR and payroll

The app includes an HR module for employee employment profiles and dated pay plans, daily/bulk attendance, leave allocations/approvals, advances, simple loans, approved recoveries, reimbursements, monthly payroll, payslips, CSV payroll registers, and partial payments/reversals. Schema migrations 13–14 create the HR tables, their record-audit triggers, working-week calendar, and payroll review tracking at startup. Existing employee masters, cost centers, and accounts are reused; ERPNext HR transactions and opening balances are not imported automatically.

After updating the app, rebuild the local Docker service with `docker compose up -d --build invoice-app`. An admin should configure **HR → Settings** (salary payable account, workweek, holidays, leave types), save employee employment details and pay plans, and grant the necessary HR permissions. HR is not granted by default to non-admin built-in roles. See [the application guide](docs/app-guide.md#human-resources) and [HR permissions](docs/permissions.md#hr-permissions-and-visibility).

Payroll uses approved manual paid-day and component amounts. Statutory calculations, commission formulas, attendance-based deductions, employee-file uploads, and automated loan schedules are not automated. Payslips can be printed/saved as PDF using the browser. Accounting posts to PostgreSQL and never writes HR data back to ERPNext.

Run `npm test` for the standard checks. To exercise HR accounting, concurrent payment protection, permission checks, and actual HTTP page rendering, configure a separate PostgreSQL database whose name ends in `_hr_test`, then run `npm run test:hr`. That integration test resets its dedicated public schema and refuses any other database name. Do not point it at the application database.
