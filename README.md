# Work Master

Node/Express app for sales invoices, purchases, inventory, and accounting. It syncs ERP/MySQL master data into local Postgres tables and stores app-created vouchers in Postgres.

## Private audit artifacts

The root `audits/` directory contains private local evidence and benchmark artifacts. It is excluded from Git and Docker build contexts; references to `audits/` elsewhere in this guide require those separately retained local files. Fresh clones do not include them. Keep audit artifacts and their backups in private storage, and do not force-add them to Git.

The repository history has been rewritten to remove `audits/`. Existing clones must use the cleaned history before pushing again; merging an old branch can restore the removed information. Preserve uncommitted work and local artifacts before replacing a clone, then transfer only the required source changes onto a fresh clone. Rotate any exposed credentials, and request GitHub Support cleanup for sensitive cached commits or pull-request references.

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

Employee personal and contact details are stored in PostgreSQL alongside HR employment profiles. Startup adds the profile details column and synchronizes the employee compatibility flag with Active/Left employment status. Existing disabled employees with a blank status become Left; an explicit Active/Left status takes precedence over the old disabled flag. After updating the code, restart the app; Docker installations must rebuild and recreate the `invoice-app` service to apply the form and schema changes.

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

Schema migration 39 adds indexed Stock Entry delivery metadata and per-user read-only shares. Existing entries start with no delivery status or shares. Operational delivery metadata is stored separately so it can change after inventory closure without rewriting posted documents or ledger history. Owner-mode startup applies it automatically. With controlled-inventory runtime credentials, run `npm run db:migrate` with owner credentials before restarting; migration 39 grants the existing database-specific runtime role access to the two new tables. Transaction resets remove these dependent records with their stock entries.

Schema migration 40 adds Read-only / Read & write sharing levels; all existing Stock Entry shares remain Read-only. On controlled-inventory deployments, run the owner migration before restarting the runtime. No ledger records are rewritten.

Schema migration 41 adds the journal-creator and ledger/daily-balance read indexes
described below. Build the updated image first with `docker compose build invoice-app`.
Then apply it with the owner credentials before restarting a restricted runtime:
`docker compose run --rm --no-deps --entrypoint node invoice-app scripts/migrate.js`.
This migration builds indexes concurrently and does not rewrite financial records.

Schema migration 43 optimises historical inventory availability checks. It sums
stock through the selected posting time and calculates running balances only for
later movements. Invoice draft validation uses the same rule, including later
shortages and the recorded order of movements sharing a timestamp. The migration
replaces a private helper without rewriting ledger rows or stock balances; it
preserves its owner and execution permissions. Build the updated image and run
the owner migration command above before restarting a restricted runtime.

Schema migration 44 avoids unnecessary invoice and stock-document index lookups
during historical stock checks. Only controlled declining movements that need a
saved document time look up their source header; other movements keep their
recorded physical time. It preserves the private helper's identity and
permissions and does not rewrite inventory or accounting records. Apply the
owner migration before starting the updated restricted runtime.

Schema migration 45 speeds up controlled-inventory checks for posting times at
or after the warehouse's latest physical movement. Successful checks use the
protected current balance; earlier times and shortage warnings retain the full
historical calculation. Draft checks use one database snapshot, and submission
checks remain under the existing warehouse/stock locks. Stock and accounting
still commit together. Run the owner migration before restarting a restricted
runtime; no inventory or accounting history is rewritten.

Schema migration 46 builds `app_stock_ledger_balance_cover_idx` concurrently on
item/warehouse, including quantity and value deltas. The deferred stock-balance
verification can use this covering index to reduce historical table-page reads;
the full reconciliation and warehouse locks remain enforced. Index-only reads
depend on PostgreSQL visibility information, so keep autovacuum enabled. The
index uses additional disk space and adds maintenance work on new ledger rows.
Build the updated image and run the owner migration before restarting a
restricted runtime. The migration runs outside a transaction, verifies the
index definition/readiness, retries an invalid interrupted build and refreshes
item/warehouse statistics. It does not rewrite stock or accounting history.

## Performance operations

Invoice stock previews use `POST /api/invoice-stock-balances` with up to 200 raw
item/warehouse pairs and an optional posting date/time. Each batch runs one
read-only quantity query, deduplicates pairs, checks every warehouse and disables
response caching. The read-only POST shares the interactive read connection
budget, preserving posting capacity. Current previews read maintained balances; historical previews
retain ledger time ordering and later minimum-balance protection. Large invoices
use sequential bounded batches. No additional migration or index is required.
See [the batching comparison](audits/stock-preview-batching-2026-10-18/report.md)
for the local fixture, measurements and reproduction procedure.

See the [export follow-up and repeat benchmark](audits/performance-2026-10-11/export-follow-up.md) for the implemented worker protections and remaining PDF capacity limits. See the [11 October 2026 performance review](audits/performance-2026-10-11/review.md) for measured search/export behavior, the concurrent Excel export failure, and the limitations of that synthetic historical-data test.

See the [14 October 2026 twenty-user resilience test](audits/resilience-2026-10-14/review.md) for concurrent browsing, journal posting, report export and recovery results on an isolated copy of the current local data.

The server logs requests slower than `SLOW_REQUEST_MS` (default 300 ms). Measure response-time percentiles and database load under realistic data and concurrent users before changing capacity. PostgreSQL's `pg_stat_statements` extension can identify queries with the highest total execution time; it needs to be loaded in `shared_preload_libraries` and enabled by a database administrator. Use `EXPLAIN (ANALYZE, BUFFERS)` on slow read queries in a staging database with production-sized data. Keep autovacuum enabled and check that it keeps up with invoice, ledger, and session table activity. Display-format settings are cached for 30 seconds per app process, and simultaneous cache refreshes share one database read.

Migration 23 adds GIN trigram candidate indexes for invoice and journal text searches and indexes for generated sales-journal references and submitted/cancelled customer-payment journal lookups. It uses `CREATE INDEX CONCURRENTLY` and retries invalid indexes left by interrupted builds. PostgreSQL must provide `pg_trgm`; the migration role needs permission to create that extension if it is absent and to create indexes. On a large database the first startup can take longer while these indexes build. Keep this migration outside an explicit transaction. Startup records the migration only after all four indexes are valid.

General Ledger pages read totals and rows in one repeatable-read, read-only transaction and disable JIT only for that transaction. Count and debit/credit totals use one aggregate. Identical simultaneous ledger, trial-balance, and journal-list reads share work using their complete SQL/filter/access keys. Completed financial results are not cached; committed app transactions start a new sharing generation. Dropdown metadata is cached for 30 seconds per process, and transaction resets clear it. These changes do not increase the database pool or change global PostgreSQL JIT settings.

Database pool settings apply to each app process and to operational scripts:

| Variable | Default | Behavior |
| --- | --- | --- |
| `POSTGRES_POOL_MAX` | `10` | Maximum connections per process. |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `10000` | Maximum wait to acquire/connect a database connection; `0` disables the timeout. |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `0` | PostgreSQL statement timeout; disabled by default because exports, imports, and migrations share the pool. |
| `POSTGRES_IDLE_TIMEOUT_MS` | `30000` | Idle connection lifetime; `0` disables idle eviction. |
| `POSTGRES_POOL_METRICS_MS` | `0` | Interval for `postgres_pool total=… idle=… waiting=…` log snapshots; `0` disables logging. |

Values must be nonnegative integers (pool maximum must be at least one). Restart after changing these settings. Start with `POSTGRES_POOL_METRICS_MS=10000` during a staging load test. Pool counts are per process; sample logs alongside database CPU, memory, and query plans. Setting a statement timeout also affects startup and maintenance commands, so choose it against the measured workloads or override it for those commands.

Run a read-only HTTP check against a representative staging deployment with an authenticated session cookie:

```bash
PERF_COOKIE='wm_session=your-staging-session-token' npm run perf:http -- --url=http://localhost:3020/invoices --requests=200 --concurrency=20
```

The command reports response status counts, failures, requests per second, and 50th/95th/99th percentile latency. It issues only GET requests and stops after the requested count. A redirect to login counts as a failure; set `PERF_COOKIE` in the shell without putting a real session token in source control. Run the same scenario with production-sized staging data at several concurrency levels, and compare the latency and error rate. Results include the app's short-lived caches, so compare a cold run and a warm run when diagnosing database load.

The invoice list limits each page to at most 200 rows. Normal lists and conservative text searches select their invoice IDs before computing payment totals; numeric and payment-state searches retain computed filtering. Normal pages fetch one extra row for Next navigation; exact totals are available on demand. Creator and assigned-employee access use separate indexed candidate routes before deduplication and pagination. Payment journals are narrowed by header and line references, preserving customer matching, cancellation history and linked-payment exclusion. Identical in-flight requests share only matching filter/access scopes; completed financial results are not retained. Each app process and export worker has its own PostgreSQL pool: budget all instances within the database connection limit. Test the expected data volume and mixed concurrency in staging.

Benchmark invoice lists, text searches, and CSV/XLSX/PDF ledger exports over a historical date range:

```bash
PERF_COOKIE='wm_session=your-staging-session-token' PERF_SEARCH_TERMS='["paid","partial","historical customer name"]' npm run perf:suite -- --url=http://localhost:3020 --from=2024-01-01 --to=2026-10-01 --requests=100 --concurrency=10 --warmup=5
```

Use a staging database with a representative historical copy and an account permitted to view those invoices and ledger entries. Choose actual customer/invoice search terms from that copy. Scenarios run sequentially, each with concurrent requests; run at concurrency 1, 10, and 20 for comparison. By default all workers use `PERF_COOKIE`. For multiple users, set `PERF_COOKIES` to a JSON array of cookie strings from distinct test accounts instead; workers keep their assigned session for the run. The benchmark does not seed records or modify vouchers, but authenticated requests update session activity. Warmup requests are excluded from timing. Redirects and non-2xx responses fail the run. Outputs include p50/p95/p99, request throughput, statuses, transport-error counts, and response bytes; response files are drained without being retained in the benchmark process. Search cache warmth affects results, so compare representative terms and cold/warm runs. Export requests default to a 60-second client deadline in the suite; use `--timeout_ms=120000` (up to 360000 ms) to observe longer queued downloads and busy responses instead of cancelling them at the client. Keep the session active within its seven-day maximum lifetime.

Record invoice, payment, journal-line, and GL-row counts, the tested account's scope, app/database resources, pool waiting logs, and server memory alongside benchmark JSON. A successful run against an empty or narrowly scoped dataset does not establish capacity for a full historical workload.


### General Ledger export workers

General Ledger CSV, Excel, and PDF downloads run in separate, bounded Node processes. Workers read 500 rows at a time within a repeatable-read, read-only PostgreSQL transaction, retaining the report's access filters and running balances. CSV and Excel generation streams rows; PDF writes completed pages without buffering the whole document. Files are prepared in private temporary directories before the response begins, then streamed to the browser. Normal completion, cancellation, and worker errors remove the temporary files. The web process remains available while PDFs render. Abruptly terminating the web process can leave temporary `wm-ledger-export-*` directories; include the operating system's temporary-directory cleanup in operations.

File workers omit source-voucher link-availability lookups, which are needed for
interactive links but are absent from CSV/Excel/PDF columns. Export access,
financial fields, narration and balances use the same filtered snapshot. Direct
ledger-reader callers retain link checks by default.

| Variable | Default | Behavior |
| --- | --- | --- |
| `LEDGER_EXPORT_WORKERS` | `2` | Maximum active ledger downloads per web process, including file transfer (1–32). |
| `LEDGER_EXPORT_PDF_WORKERS` | `1` | Maximum active PDF downloads, within the total worker limit. |
| `LEDGER_EXPORT_QUEUE_MAX` | `20` | Maximum waiting downloads (0–1000). |
| `LEDGER_EXPORT_QUEUE_TIMEOUT_MS` | `60000` | Maximum wait for an export slot (1–3600000 ms). |
| `LEDGER_EXPORT_JOB_TIMEOUT_MS` | `300000` | Maximum generation and transfer time after receiving a slot (1–3600000 ms). |
| `LEDGER_EXPORT_HEAP_MB` | `256` | JavaScript heap limit for each worker (64–4096 MB); native memory is additional. |

Restart the app after changing these settings. Workers each open at most one extra PostgreSQL connection, beyond the web process's configured pool; account for every app instance and its workers when sizing database connections. For a reverse proxy, allow the configured queue wait plus generation time before its read timeout; the defaults total 360 seconds (for example, Nginx `proxy_read_timeout 360s;`). A full queue or expired queue wait returns HTTP 429 with `Retry-After: 30`. Generation failures/timeouts return HTTP 503 before download headers are sent. A transfer failure closes the download; retry it. Client disconnects cancel queued/running work. Exports are request-bound downloads, not persisted jobs that survive restarts.

Provide sufficient local temporary disk space for up to the configured active downloads. The production Docker image already includes these worker modules through `COPY src`; rebuild and recreate the app container to deploy code changes. No new dependency or database migration is required. PostgreSQL statement timeouts still apply to worker queries; long cursor snapshots can delay vacuum cleanup, so keep generation deadlines bounded and monitor database activity.

## Release checks

### ERPNext-sized background benchmark

The synthetic benchmark runs locally in detached Docker containers, with a
dedicated database, internal network, frozen app image and no published ports.
It makes no AI API calls and receives no application `.env` or ERPNext connection.
The machine must remain running. The source profile records the aggregate reads
from 18 October 2026 and its explicit payment, line-size and ownership assumptions;
this tests this app, rather than measuring ERPNext performance.

Prepare and validate a small pilot first:

```bash
python3 scripts/erpnext-benchmark/control.py start --pilot
python3 scripts/erpnext-benchmark/control.py status --pilot
```

After the pilot finishes successfully on the same source snapshot, start the full
1× profile and inspect its progress without an active AI session:

```bash
python3 scripts/erpnext-benchmark/control.py start
python3 scripts/erpnext-benchmark/control.py status
```

The full target includes 237,260 sales invoices / 2,214,223 sales lines, 207,213
legacy journal analogues, 15,977 purchases, 25,094 stock transfers and 2,808 purchase
orders, with observed document statuses and historical date proportions. Opening
stock and generated accounting records add app-specific documents. Source payment
allocation is unknown: the fixture uses one synthetic receipt for each settled
sale, preserves the observed positive-outstanding count and represents source
overpayments as settled. Historical line lengths cluster around the observed
means; separate 1/5/10/20/50-line workload scenarios explore tails that were not
measured in ERPNext. Current app lifecycle functions create every voucher/posting.

The full job runs distinct authenticated users at concurrency 10, 20 and 50, each
with a warmup, sustained mixed work with 0.5–1.5 second think time, and a burst
against shared items. Sustained phases last 15, 15 and 25 minutes; warmups last
one minute and bursts three minutes. It exercises lists/search/detail, invoice
drafts/cash sales/credit receipts, journal postings, purchases/orders, transfers and
reports. It also checks denied ownership/report reads and generates full-history
CSV plus daily Excel/PDF ledger exports. This is HTTP workload testing, without
browser rendering or production network latency. Pilot phases are deliberately
short and validate the harness; they do not establish full-data capacity.

Run data, private credentials, progress, resource samples, integrity results and
`summary.md`/`summary.json` are retained under a new
`/mnt/HC_Volume_107155360/wm-erp-<mode>-<run-id>/` directory. The status command prints
the actual path. Local pointers live in ignored `data/erp-benchmark/`. Never paste
the private `config.env` or `output/credentials.json` into logs or source control.

By user instruction, retain the benchmark setup and resources for future tests
until the user explicitly requests removal. This includes seeded databases, run
directories, private configuration, frozen images, containers/networks, local
pointers, scripts, profiles and results. Exclude these resources from routine
cleanup and Docker pruning. Completed containers may stop to release CPU and
memory; their data and configuration remain available. Preserve existing fixtures
and results when preparing another test. Disposable integration-test resources
remain subject to the cleanup procedure below. This policy is also recorded in
`AGENTS.md` for future work.

The job and database have 900 MiB/850 MiB memory limits and 0.8/1.0 CPU limits.
Full startup requires 15 GiB free on the attached volume, a passing pilot from the
same source snapshot whose measured storage projection fits with a 6 GiB reserve,
and 1200 MiB available host memory. Execution stops if free attached-volume storage
falls below 6 GiB. Storage estimates remain provisional until the full run finishes.
The pilot checks recovery after an interrupted committed draft, replay of completed
seed keys, and detection of deliberately missing cancellation GL rows inside a
rolled-back transaction. Its `integrity-intentional-fault.json` is expected to fail;
`pilot-checks.json` and the normal before/after integrity reports must pass.
The concurrency mix keeps 10% Admin and 90% Standard accounts at each level and
reports operation latency separately by role. A passing HTTP/integrity result
does not assert a response-time SLO; review the measured latency and overload data.

```bash
python3 scripts/erpnext-benchmark/control.py stop --run <run-id>
python3 scripts/erpnext-benchmark/control.py resume --run <run-id>
```

`stop` affects only the selected benchmark deployment. `resume` retains the database
and durable seed checkpoints, and refuses replay after HTTP traffic has started.
If a seed failure needs a code fix, first run a fresh passing pilot with the fixed
source, then use `resume --run <run-id> --use-pilot-image`. This adopts that pilot's
immutable image only when the full profile fingerprint still matches the retained
checkpoint and no benchmark job is running. It preserves the failed status,
checkpoint and previous image identity in the run output. The database is retained;
ordinary resume continues to require the retained pinned image.
No reset/prune/delete command is provided. A monitor records Docker resource use
and stops only the benchmark database when its job exits. Inspect `status.json`,
the job exit/OOM state and `summary.json` before claiming success; failures are
retained and never automatically treated as passing. Start a new run after fixing
a traffic failure. Existing fixtures and the working app are preserved.

The 19 October report follow-up uses a separate cold copy of the completed full
fixture, with its own private configuration, frozen image, containers and output.
It reruns the mixed workload without seeding or modifying the original fixture.
Use `python3 audits/erpnext-report-followup-2026-10-19/recheck.py status` for that
follow-up; `control.py status` continues to describe the original baseline.
Run only one benchmark workload at a time. Both deployments and their results
remain retained until the user requests removal. The follow-up's monitor stops
only its copy database when its job exits.

### Application release gate

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

### Local Docker integration tests

When Node.js is unavailable on the host, run the complete suite against a fresh,
isolated local PostgreSQL container. The following uses disposable database data,
an internal network with no published ports, and the current source mounted
read-only. It does not load the application's `.env`. The writable temporary
`data` directory lets upload tests run under the app image's non-root user.
Build the app image with `docker compose build invoice-app` first if it is absent.

```bash
docker network create --internal wm-skipped-tests
docker run -d --name wm-skipped-postgres --network wm-skipped-tests \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=work_master_hr_test -e POSTGRES_USER=test_user \
  -e POSTGRES_PASSWORD=local_test_only postgres:16-alpine
```

Wait until `docker exec wm-skipped-postgres pg_isready -U test_user -d work_master_hr_test`
reports that connections are accepted, then run:

```bash
docker run --rm --name wm-skipped-runner --network wm-skipped-tests \
  --entrypoint sh -v "$PWD:/workspace:ro" \
  --tmpfs /workspace/data:mode=1777 -w /workspace \
  -e NODE_PATH=/app/node_modules -e POSTGRES_HOST=wm-skipped-postgres \
  -e POSTGRES_DB=work_master_hr_test -e POSTGRES_USER=test_user \
  -e POSTGRES_PASSWORD=local_test_only \
  -e POSTGRES_URL=postgresql://test_user:local_test_only@wm-skipped-postgres:5432/work_master_hr_test \
  work_master-invoice-app \
  -c 'npm run test:postgres'
```

The API cleanup script also respects an explicitly configured `*_hr_test` database and skips the application `.env` in that environment.

The runner checks the dedicated database name and schema ownership, enables all
database test flags, and runs files sequentially to avoid conflicting schema
resets. The dedicated URL is also needed by the pool-timeout test, which creates
its own connection pool. Check the runner's exit status and test totals. After it exits, clean up
even if tests failed:

```bash
docker rm -f wm-skipped-postgres
docker network rm wm-skipped-tests
```

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

### Transaction reset and recovery

Administrators can reset transactional data from **Settings → Maintenance** after creating a verified full database/file backup and confirming their password and `RESET TRANSACTIONS`. Migration 21 adds backup metadata and reset history. The financial scope preserves HR transactions and their ledger entries; the all-transactions scope clears HR too. Master records, app configuration, users/permissions, employee profiles, pay plans, holidays, leave types, project files, and audit/reset history remain. Document sequences continue to prevent old IDs/numbers from identifying new vouchers. All sessions end and integration credentials are revoked on success.

The Docker image includes PostgreSQL 16 backup tools and GNU tar. Non-Docker installations need matching PostgreSQL `pg_dump`/`pg_restore` tools and GNU tar on PATH. Backup tool credentials are supplied through process environment, never command arguments. The database user must be able to read all schema/data; insufficient permissions or storage fail before any removal. PostgreSQL sessions from this app and its CLI tasks use a shared maintenance lock; backups/resets hold the exclusive lock, temporarily returning 503 for other database operations. In-flight checkouts finish before maintenance acquires its lock. Website/API POST requests capture the reset generation, and later database checkouts reject a request that predates a committed reset so delayed requests cannot recreate cleared transactions.

Private backup bundles are stored in `data/transaction-reset-backups` with a directory mode of 0700 and archive mode of 0600. A bundle contains `database.dump`, `files.tar.gz`, and `manifest.json`. The database dump uses an exported consistent snapshot. Verification reads the complete dump/archive and checks SHA-256 hashes; a changing file tree prevents backup completion. Reset eligibility lasts 15 minutes and requires unchanged business data/files, an unused backup, and the same administrator/scope. Backups remain downloadable by their owner after reset or expiry; download and keep an independent copy. They contain confidential data, including account/password hashes. Backup bundles themselves are excluded from nested file backups and are not automatically deleted.

For recovery, extract the bundle into a private directory. First restore `database.dump` into a separate empty database using `pg_restore --exit-on-error --no-owner --dbname YOUR_EMPTY_RESTORE_DATABASE database.dump`; supply connection credentials securely through PostgreSQL environment settings. Extract `files.tar.gz` into a separate directory and verify its contents against the manifest. Stop the app before switching to the restored database and file directory and preserve current backups separately. Restoration also restores the snapshot's users, permissions, sessions, and integration credentials: review access and revoke restored sessions/tokens before reopening the app. Routine recovery testing must use the isolated local test database procedure above, never the application database. Automated maintenance tests restore a generated archive into a second disposable database and verify uploaded file recovery.

Schema migration 20 enforces unique employee, cost center, and account names using case-insensitive comparisons that ignore surrounding spaces. This applies to active and inactive masters. Resolve duplicate names before upgrading; startup fails rather than merging, deleting, or automatically renaming master records. Rename the affected masters while preserving their existing IDs so voucher links and permissions remain intact. Imports must also comply with these name constraints.

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
- [API development roadmap](docs/api-development-roadmap.md)

## API service

Phases 1–4 provide `/api/v1` mobile authentication, self identity, Admin-managed integration credentials, scoped master-data/stock/invoice/receipt reads and three financial POST operations: invoice draft creation, separate submission and one-invoice receipt recording. See the [implemented API guide and contract](docs/api/README.md) and [Phase 4 verification report](docs/api/phase-4-report.md). Website payment workflows, allocation rules, pricing and accounting behavior are preserved. Real-client staging acceptance and production launch checks remain open.

Migration 18 adds API-owned `wm_api_*` credential, session, retry, permanent payment-reference, audit and rate-limit tables, plus an `api_service_account` flag on users (false for existing users). It does not add constraints or change columns on existing payment tables. Dedicated integration accounts cannot use interactive login. Back up before upgrading; rebuild with `docker compose up -d --build invoice-app`. Disabling API routes must retain permanent payment references and financial audit records. Rolling back to older-schema code requires a reviewed migration plan because startup rejects a newer schema.

Production API credential traffic requires HTTPS via the supported TLS proxy with `TRUST_PROXY=true`; the website's private HTTP cookie exception does not permit insecure API credentials. Native clients use bearer tokens; browser-origin API access is not enabled. The local HTTP website remains available on its configured port, while API authentication requires TLS in production mode. Never transmit production tokens over HTTP or store them in URL/query strings.

Migration 19 adds resource type/ID metadata to API retry records and backfills known resource links without changing stored responses or existing financial rows. Internal financial services now authorize, validate references, post, save retry results and audit on one connection. Refresh and financial requests use consistent lock order. API-only lock/deadline handling and permanent receipt references leave website posting, pricing and cancellation behavior unchanged. No public financial endpoint is enabled by this migration.

Phase 4 exposes those services through strict financial HTTP contracts without a new migration or payment-table change. Every financial request requires JSON and exactly one stable `Idempotency-Key` header (1–128 visible ASCII characters without spaces). Seven-day retry responses commit atomically with effects and audit; retry the same payload/key after contention, timeout or a lost response. Reconcile draft creation after expiry. Receipts additionally require source/reference identity, permanently protected within the API account namespace across key expiry and credential rotation; cancellation does not free it. Never purge permanent references during cleanup or rollback. Invoice results contain saved totals; receipt results identify the original payment. Read current permitted resources to reconcile later website changes. Website cache invalidation remains process-local; the initial deployment is one app instance.

Schedule `docker compose exec invoice-app node scripts/api-cleanup.js` daily to remove expired retry records, rate-limit windows and mobile families. Refresh history remains for the entire family lifetime. Cleanup does not remove financial audit, integration credential metadata or permanent payment references. Include all new tables in PostgreSQL backups and protect database access because retry results contain business data. Monitor table growth and account for database-backed API limits when measuring capacity.

The full isolated Docker procedure above enables API integration tests through `npm run test:postgres`; it exercises real HTTP financial workflows, website/payment/ledger parity, stock and overpayment concurrency, retry/audit rollback and credential lifecycles. Run `npm run test:accounting` against the same disposable database after the full suite, using the same runner environment and mounts. Do not run these schema-resetting commands concurrently or use the application database for tests.

### API operational hardening

Phase 5 adds redacted JSON `api_request` events and cumulative per-process `api_metrics` latency/count snapshots. `API_REQUEST_LOGS=true` and `API_METRICS_INTERVAL_MS=60000` are defaults; use `false` and `0` respectively to disable those outputs. Templates replace raw API URLs and metric labels omit actor/resource IDs. Configure a restricted log collector and alerts through your deployment; no external monitoring service is installed automatically. See the [operations and launch runbook](docs/api/operations.md) for counters, outcomes, incident recovery and alert proposals.

`API_V1_ENABLED=false` returns JSON 503 `api_disabled` before new API requests are parsed/authenticated, while website access remains available. Recreate the app after changing deployment environment values. This switch preserves committed vouchers, retry records, permanent receipt references, credentials and revocations; it does not undo preceding operations. Default is `true`. All three settings reject invalid values. No new schema migration, public monitoring endpoint or financial workflow change is introduced.

Run `bash scripts/api-recovery-drill.sh` on the local Docker host to seed synthetic data, dump a fresh disposable database and restore into a separate empty test database. It verifies table fingerprints, restored credentials/revocations, retries, permanent references, absence of repeated postings and sequence continuity, then removes all temporary Docker/data/credential artifacts. It uses no application environment file or database credentials. Do not execute this Docker-orchestrating command inside the app container. `npm run verify:api-recovery` is an equivalent host command when Node/npm are installed. This drill covers PostgreSQL; persistent file volumes, deployment secrets and production recovery timing remain separate staging checks.

The bearer-only read-load tool is `npm run perf:api -- --url=https://staging.example/api/v1 --resource=invoices --requests=30 --concurrency=1 --interval_ms=1000`. Supply opaque tokens through `API_BENCHMARK_TOKEN` or `API_BENCHMARK_TOKENS` in a secure process environment; never use token command arguments or checked-in credentials. It issues GETs only, rejects redirects/non-2xx/non-JSON responses and reports status/error counts, latency percentiles and throughput without token/query/business-data output. See the runbook for allowed resources, bounds, pacing and loopback-only local HTTP. Representative staging load, real clients, deployed TLS, production alert ownership, recovery timing and pilot acceptance remain pending.

### Isolated local staging

Run `bash scripts/api-staging.sh up` to start the separate staging project, then `bash scripts/api-staging.sh check` to verify actual production-mode HTTP/TLS deployment and synthetic sales flows through HTTPS. The local URL is `https://localhost:3443`; trust `data/api-staging/tls/ca.crt` explicitly (for curl, `--cacert`). App/database ports are private; only the TLS proxy publishes a loopback port. The database, volumes, random credentials and environment are separate from the working app, with no application `.env` or ERPNext data/credentials used.

Generated private credentials and redacted acceptance evidence are in ignored `data/api-staging/`; do not remove this state while retaining staging database volumes. `status` lists staging services; `down` stops them without deleting data. Checks create synthetic financial records and rotate/revoke staging integration credentials. The [local staging guide](docs/api/local-staging.md) documents trust, credentials, isolation and retained artifacts. Real native/external clients, a reachable public staging domain, representative capacity, external alerts and pilot acceptance remain pending.

## Important

The current MySQL user is still used only for reading ERPNext tables. Stock and accounting entries created by this app are local to the app's Postgres database and are not written back to ERPNext.

The **Reports → Daily Activity** page lists local Daily Activity drafts stored in PostgreSQL. Users with Daily Activity Read and Create can choose **New Daily Activity** and **Save draft**; this generates a DAR number, records the creating app user, and opens the saved detail page. It validates enabled local shops and warehouses and applies user record restrictions. Saving does not post stock or accounting entries. Existing ERPNext vouchers remain available through the separate **ERPNext reference** view, which is read-only. Local drafts can currently be created and viewed; editing and submission are not provided. Schema migration 17 creates the local table and audit trigger automatically at startup.

Schema migration 11 adds journal row invoice references and links supplier payment allocations to their journals. It runs automatically on app startup.

General Ledger downloads use ExcelJS for `.xlsx` files and PDFKit for PDF files. Install updated dependencies and restart the app after updating; Docker installations must rebuild the app image.

Import the current ERPNext chart of accounts with `npm run sync:erpnext-accounts` (preview with `-- --dry-run`). Configure `ERPNEXT_URL`, `ERPNEXT_USERNAME`, and `ERPNEXT_PASSWORD` for an ERPNext user who can read Accounts. This imports the accounts visible to that user into the existing PostgreSQL schema. Imported accounts receive unique four-digit local codes: 1xxx for assets, 2xxx for liabilities, 3xxx for equity, 4xxx for income, and 5xxx for expenses. Category groups and their posting accounts share numbering ranges. Existing numeric local codes are retained. ERPNext document names remain display names, preserving company suffixes and parent relationships, and are stored separately as source identifiers. Reruns preserve assigned codes, including subsequent local code edits; legacy imports that used document names as codes are numbered on their next sync. The import retains local accounts, posting defaults, and existing account IDs; reruns refresh imported names, detail types, parent links, and enabled states. The sync summary includes the number of recoded accounts. Account metadata is read before importing so older ERPNext versions without a disabled field are supported. Frozen accounts are imported inactive. Classification changes require manual review and abort the import. All account changes run in one transaction; connection or validation errors leave accounts unchanged.


## HR and payroll

The app includes an HR module for employee employment profiles and dated pay plans, daily/bulk attendance, leave allocations/approvals, advances, simple loans, approved recoveries, reimbursements, monthly payroll, payslips, CSV payroll registers, and partial payments/reversals. Schema migrations 13–14 create the HR tables, their record-audit triggers, working-week calendar, and payroll review tracking at startup. Existing employee masters, cost centers, and accounts are reused; ERPNext HR transactions and opening balances are not imported automatically.

After updating the app, rebuild the local Docker service with `docker compose up -d --build invoice-app`. An admin should configure **HR → Settings** (salary payable account, workweek, holidays, leave types), save employee employment details and pay plans, and grant the necessary HR permissions. HR is not granted by default to non-admin built-in roles. See [the application guide](docs/app-guide.md#human-resources) and [HR permissions](docs/permissions.md#hr-permissions-and-visibility).

Payroll uses approved manual paid-day and component amounts. Statutory calculations, commission formulas, attendance-based deductions, employee-file uploads, and automated loan schedules are not automated. Payslips can be printed/saved as PDF using the browser. Accounting posts to PostgreSQL and never writes HR data back to ERPNext.

Run `npm test` for the standard checks. To exercise HR accounting, concurrent payment protection, permission checks, and actual HTTP page rendering, configure a separate PostgreSQL database whose name ends in `_hr_test`, then run `npm run test:hr`. That integration test resets its dedicated public schema and refuses any other database name. Do not point it at the application database.


The optional **ERPNext reference** view uses `ERPNEXT_URL`, `ERPNEXT_USERNAME`, and `ERPNEXT_PASSWORD` from the deployment environment (`.env` for local Docker Compose). Its ERPNext user needs Read access to Daily Activity Report. When no API URL is configured, the legacy MySQL source requires `DB_HOST`, `DB_USER`, and `DB_NAME`, plus `DB_PASSWORD` when required and `DB_PORT` if it differs from 3306. Missing or unavailable ERPNext settings show HTTP 503 in the reference view only; local Daily Activity creation and viewing use PostgreSQL and do not require ERPNext. No Daily Activity records are written to ERPNext. Recreate the app with `docker compose up -d --build invoice-app` after changing connection settings.

Schema migration 22 adds per-reconciliation Photo Count Rpt quantities and Photo ID links for supporting item photos. Stock transaction resets include these records.

### Large historical load-test artifacts

The read-only ERPNext comparison retrieved on 17 October 2026 is in
[`audits/erpnext-benchmark-review-2026-10-17/report.md`](audits/erpnext-benchmark-review-2026-10-17/report.md).
It compares current aggregate counts with the proposed reduced benchmark and
defines a candidate with 1,000,000 sales invoices averaging 10 items and other
records at three times measured ERPNext counts. The machine-readable proposal is
[`benchmark-3x.json`](audits/erpnext-benchmark-review-2026-10-17/benchmark-3x.json).
Counts reflect the configured ERPNext account's visibility. The remote benchmark
preparation and results are tracked in
[`audits/vps-benchmark-2026-10-17/`](audits/vps-benchmark-2026-10-17/).
Its isolated Compose project on `s1.zenjji.com` is `wm-benchmark-20261017`, under
`/home/kagabu/wm-benchmark-20261017`, with no published app/database ports.
It uses a source snapshot and freshly generated test credentials, never the
application `.env` or business data. The full fixture contains one million invoices and ten million invoice items. Baseline,
backup-restore and post-load reconciliation passed, as did the 90-write duplicate audit.
The measured one-user stage recorded six stock-ledger timeouts in 156 requests; the
error guard skipped higher concurrency. Performance acceptance failed. See the
[completed report](audits/vps-benchmark-2026-10-17/report.md) for latency, resource
limits and modeling limitations. The isolated app/DB have been stopped with data and
backup retained. Restart with both `compose.yml` and `runtime.override.yml`; do not
rerun the seed/controller against the retained fixture.
Keep its databases, backup and results separate from the server's existing apps.

The follow-up [invoice submission investigation](audits/invoice-submission-investigation-2026-10-17/report.md)
traced the fixed submission delay to deferred inventory-event reconciliation without
a stock-ledger index on `posting_event_id`. A temporary index on the retained
synthetic database sharply reduced the delay and was removed after comparison.
The permanent index is supplied by migration 38; the [fix and retry report](audits/invoice-submission-fix-2026-10-17/report.md) tracks its verification and submission-investigation retry.

The 17 October 2026 storage-only pilot is documented in
[`audits/storage-sample-2026-10-17/report.md`](audits/storage-sample-2026-10-17/report.md).
It uses the current schema/indexes, 40,000 synthetic invoices and proportional
supporting records, with full proposed customer/supplier/item counts. Its dedicated
database is `storage_sample_hr_test` in `wm-storage-sample-db-20261017`, with data
under `/mnt/HC_Volume_107155360/wm-storage-sample-20261017`. The internal network
publishes no database ports and receives no application environment file.
The retained sample is for storage sizing only: direct SQL does not produce a
fully reconciled financial history and must not be reused for posting benchmarks.
`run.sh` in that directory refuses existing resources; `project.py` validates sample
counts and estimates the 4-million-invoice footprint. Preserve the results and data;
the database container is stopped after measurement to release resources.

The isolated 20/50-user, four-year synthetic workload and its measured results are
kept in `audits/load-3m-2026-10-14/`. See that directory's `report.md` for the
record breakdown, container limits, commands, latency measurements, integrity
checks, and test limitations. The seed script requires the disposable database
`load_3m_hr_test` on `wm-load-db` and refuses an existing invoice dataset. Never
point this workload at the application database. Both scripts use the current
workspace mounted at `/workspace`; hide `/workspace/.env` with a read-only
`/dev/null` mount, and supply only disposable database settings. The benchmark
creates 50 synthetic admin users and submits real test vouchers in that database.

The historical query profiles are documented in
`audits/load-3m-2026-10-14/profile-report.md`. Implemented changes, correctness
checks, and the subsequent 20/50-user concurrency comparison are in
`audits/load-3m-2026-10-14/implementation-report.md`. The archived prototype
scripts and plans describe the pre-implementation query shapes; use the latest
implementation report for current behavior and measured capacity limits.

### Report concurrency and posting diagnostics

General-ledger pages/full reads/streaming exports and trial-balance queries share
a per-process limit, applied before acquiring a database connection. Defaults:
`HEAVY_REPORT_CONCURRENCY=1`, `HEAVY_REPORT_QUEUE_MAX=100`, and
`HEAVY_REPORT_QUEUE_TIMEOUT_MS=30000`. Extra work waits in FIFO order; overflow
or expiry raises a report-busy error (status 503). Identical in-flight page
requests share one execution. Reports have a separate admission queue and a `HEAVY_REPORT_CONNECTIONS=2` sub-budget within the common read-connection limit. Waiting reports do not occupy list admission slots. Each app process has its own
limit; budget the combined limits when running multiple instances.

Set `POSTING_TIMINGS=1` to emit JSON `posting_timing` records for standard invoice
creation/submission and website invoice-create requests, including payload
validation, creation/submission calls, connection wait, invoice lock, stock (including its stock-lock query), line costs,
payment totals, accounting, commit, and total durations where applicable. Stage
measurements include database execution and lock waits; they do not distinguish
those two costs. `submit` includes its child stages, so durations must not be
added together. Records contain no invoice payload or document identifiers.
Request success means the handler returned normally (including handled validation
responses); transaction success means it committed. Diagnostics are disabled by default. Compare timings under repeatable workloads
before changing pool sizes or concurrency limits.

### Database connection interruptions

The app handles pooled connection errors, discards failed connections, and opens
replacement connections on subsequent requests. Structured `postgres_pool_error`
and `postgres_connection_error` logs contain a bounded error code rather than SQL,
connection strings, or database error messages. An interrupted request may fail
while the database is unavailable; connection recovery does not automatically
retry financial writes. For API financial operations, retry the same payload with
the same idempotency key to recover an uncertain response. For website saves,
check the document before resubmitting. A database outage during app startup
remains subject to the deployment restart policy.

The [growth resilience live report](audits/growth-resilience-2026-10-14/live-report.md)
tracks the isolated four-hour mixed workload and its 100-user traffic spikes.
The retained workload, fault-drill and monitor scripts are in that audit
directory. The monitor captures settled financial checks; the finalizer performs
a low-concurrency recovery probe and writes `report.md` after the run. Dumps and
private credential fixtures are excluded from Git. Test databases and volumes
are retained for follow-up; routine schema-resetting integration containers are
removed separately.

### Ledger daily balances

Migration 24 builds `wm_gl_daily` from the detailed ledger under a write lock on
`app_gl_entries`; existing reports can still read, but ledger posting waits for
the initial backfill transaction. Schedule the first upgrade for a quiet period
on large databases. Insert/update/delete statement triggers maintain the derived
balances in the same transaction as the detailed ledger. Truncation clears them.
Sixteen voucher buckets reduce contention. Trial balance uses these daily totals;
GL counts/totals use them for date/account/voucher filters and compatible HR/account
access rules. Ordinary owner-scoped pages use the additional ownership summaries
described under migration 42 below. More restrictive owner-scoped pages, party
and free-text queries retain detailed-ledger aggregation. Detail rows and filtered
running balances still use ledger entries.
Daily balances are included in normal PostgreSQL backups; do not modify them or
disable their triggers. Website invoice validation batches references and items
in two reads, with fresh stock validation retained in the posting transaction.
Cost-center display labels use a 30-second metadata cache; permission and posting
validation continue to read current records.

Migration 25 adds a concurrent partial index on linked invoice-payment journals.
Ordinary invoice list/text-search pages materialize eligible unlinked customer
journals once for the selected page before reading their lines. Linked receipts
continue to come from invoice payments; manual journal references and computed
payment-status searches retain their existing matching rules.

The GL voucher-type dropdown also reads maintained daily counts, avoiding a
scan of the full ledger just to populate its small list. Zero-count historical
summary rows do not contribute dropdown choices.

### Retained four-hour accounting verification

`audits/final-verification-2026-10-15/` contains the follow-up endurance harness
and its reports. It targets only the retained isolated `resilience_4y_hr_test`
database on `wm-growth-db`, never the application database. The workload
alternates 20/50 users and adds one-minute 100-user spikes every 30 minutes.
`live-report.md` reports request counts, failures, averages and maxima; after
the run, `report.md` adds exact nearest-rank p50/p95/p99 for every operation
and each concurrency target, source-document/GL/stock/payment reconciliation,
expected-write manifest checks, recovery checks and sampled host/container,
PostgreSQL pool and report-queue evidence. Resource samples may miss brief peaks.

The test app loads `queue-telemetry.cjs` only in its isolated container; it
observes the existing report gate without changing its limits or retry behavior.
`supervise.py` runs independently of SSH and writes final reports automatically.
The original historical fixture has 101 stock balances seeded directly with
10,000 units and no opening ledger entry. These are explicit baseline exceptions;
a report with unresolved mismatches requires review and does not grant production
approval. No test database, backup, volume or app is automatically disposed.

### Expensive-read capacity

Invoice/journal list pages use count-free navigation by default. Website users
can request an exact total explicitly; API pagination totals remain compatible.
Lists/searches and heavy reports have separate bounded admission queues. GET/HEAD requests, including authentication and detail/supporting lookups, use the common read-connection budget after store initialization. POST financial validation and writes do not enter this read budget. Defaults:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `EXPENSIVE_READ_CONCURRENCY` | 2 | Concurrent admitted list/search operations |
| `EXPENSIVE_READ_QUEUE_MAX` | 100 | Maximum waiting operations |
| `EXPENSIVE_READ_QUEUE_TIMEOUT_MS` | 15000 | Maximum admission/reader-lease wait |
| `EXPENSIVE_READ_CONNECTIONS` | 4 | Maximum combined connections for classified reads |
| `HEAVY_REPORT_CONNECTIONS` | 2 | Report connection sub-limit; capped below the common read limit when possible |
| `POSTGRES_POSTING_RESERVE` | 3 | Minimum pool capacity excluded from those reads |

The read limit is the smaller of `EXPENSIVE_READ_CONNECTIONS` and
`POSTGRES_POOL_MAX - reserve`; very small pools retain at least one reader slot.
With the default ten-connection pool, classified reads hold at most four connections; at most two are held by heavy reports. The configured reserve bounds reads, but login POSTs, financial transactions and background tasks share the remaining capacity. Each process has its own limits: include export workers and other app instances in the overall database connection budget. Nested work must reuse a checked-out
transaction client rather than acquire another reader connection while holding
one. Reports retain their own `HEAVY_REPORT_*` limits as well.

`POSTGRES_POOL_METRICS_MS` also emits structured `workload_capacity` records with
pool waiting, active reader connections, separate report/list queue peaks and refusals, and checkout count/mean/max/failures by workload class. Checkout timing includes reader admission, pool wait and audit setup, not just PostgreSQL execution; it contains no SQL or request payloads.
Increasing connection counts on a CPU-saturated server requires measurement.
Migration 26 refreshes invoice/journal statistics, increases search-expression
statistics and lowers their automatic analyze threshold to 2% plus 1,000 modified
rows. PostgreSQL autovacuum/analyze must remain enabled. The migration changes no
voucher values or ledger postings.

Staged measurements and the frozen-source endurance harness are retained under
`audits/capacity-improvements-2026-10-15/`. The copied test database retains known
synthetic opening-stock exceptions; these must be reported separately from new
reconciliation discrepancies. No historical test resources are automatically
removed. Performance results describe the tested workload, not an unqualified
production capacity guarantee.

Compiled EJS templates are cached by default in all runtime modes. Financial
values, permissions and rendered pages are still supplied fresh on each request.
Rebuild/restart after template changes, as required by this project's workflow.
Set `VIEW_CACHE=0` only when live template recompilation is needed during
development; that mode consumes more rendering CPU and must be identified in
performance comparisons. This setting does not change HTTPS/authentication mode.

Historical load-fixture opening stock: `scripts/fixtures/seed-load-stock.cjs`
creates test opening documents, lines, stock ledger and balances atomically, and
rejects existing stock with missing history. Its database allowlist is limited
to `load_3m_hr_test` and `resilience_4y_hr_test`. The maintained posting benchmark
scripts use this helper; older archived benchmark copies are historical evidence
and must not be reused as fixture generators.

The one-time `scripts/fixtures/repair-load-opening-stock.sql` is restricted to
`resilience_4y_hr_test` and the exact 101 known zero-value, 10,000-unit discrepancies.
Take a consistent backup before running it through `psql -X`; it restores source
and opening-ledger history without changing current balances or existing ledger
rows. It aborts for unexpected differences and safely does nothing on a second
run. Evidence and backup are retained in
`audits/opening-stock-repair-2026-10-15/`. This is a test-fixture repair, not a
production stock adjustment procedure.

Expanded-history load-test preparation is recorded in
`audits/expanded-history-2026-10-15/plan.md`. Its read-only storage preflight is
`python3 audits/expanded-history-2026-10-15/preflight.py`; it checks the retained
isolated `wm-growth-db/resilience_4y_hr_test` database and writes capacity evidence.
It does not create data or start traffic. The 3× stock-ledger/invoice-line expansion uses the separately attached
Hetzner volume `/mnt/HC_Volume_107155360`; rerun the preflight with
`--storage-root /mnt/HC_Volume_107155360` to measure that filesystem. Preserve successful databases and results;
provision and verify storage, then validate a representative sizing pilot, restored
backups, full accounting integrity and preliminary performance before any full run.

The isolated expansion work lives under
`/mnt/HC_Volume_107155360/wm-expanded-history-20261015/`. Its PostgreSQL container
is `wm-expanded-db`, database `expanded_4y_hr_test`, on the internal
`wm-expanded-history` network without published ports. Preparation checks the
volume is mounted before creating the instance. Data/WAL, source snapshot,
backups, manifests and logs use this volume. The original successful database
and its result files stay in place. Keep the volume mounted while its containers
run; these test containers do not automatically start on reboot.

`audits/expanded-history-2026-10-15/preparation-status.json`, `pilot-status.json`
and `expansion-status.json` describe background stages. Preparation restores and
reconciles a fresh backup. The pilot runs only after clone verification; full
generation runs only after pilot accounting and projected capacity pass. The
generation controllers stop for review on errors. The detached `scenarios.py`
controller waits for full expanded integrity, restore-verifies backups, checks
shared-stock accounting controls, and runs a separate three-minute preliminary
20/50/100 test before launching each four-hour scenario. It restores the same
pristine paired fixture before scenario B and archives scenario A first. Any
failed prerequisite stops that scenario for review; the original successful
database is never a restore/reset target.
Generation stops if free space falls below 8 GiB or retained WAL exceeds 4 GiB.
Do not rerun a failed seeder blindly: committed documents and its manifest remain
for review, and a persistent start marker prevents duplicate seeding.

The pilot passed 18 global and five expanded-stock reconciliation checks plus
its independent expected-document manifest. Full data generation is running
through the unchanged application domain. Preliminary size estimates were
replaced by the measured pilot forecast in `pilot-result.json`; allowances now
include 5 GiB of retained backups and 2 GiB of logs/manifests. Source and result
retention uses the attached volume; the combined live stage report is
`audits/expanded-history-2026-10-15/live-report.md`. Source snapshots and test
containers remain independent of terminal/SSH lifetime. Four-hour correctness
passes are not production latency/capacity approval; no production SLO was
specified.

### Invoice payment lookup migration

Schema migration 27 builds a partial index on nonblank journal-line invoice references concurrently. This supports invoice lists and text searches without scanning unrelated payment histories. Startup waits for the index build to complete before accepting requests; existing database traffic can continue during the build. A failed concurrent build is repaired on retry. Allow index-build time and storage when upgrading a large database; the migration does not change financial records.

The expanded-history paired test can resume after the query fixes using `audits/expanded-history-2026-10-15/resume-after-query-fixes.py`, after `invoice-fix-release.json` records passing release checks. This controller archives the previous preliminary database state, restores the verified paired fixture into the isolated expanded database, reruns preliminary traffic and reconciliation, and compares browsing/posting p95 before launching Scenario A. Scenario B restores the paired fixture again and has its own preliminary gate. The original successful database, archives and failed preliminary results are retained. Controllers stop for review on failed gates; this does not constitute production performance approval.

### Invoice ownership lookup migration

Schema migration 28 builds concurrent indexes on invoice creator/ID and assigned employee/ID, excluding NULL ownership keys. Creator and assignment page candidates are fetched separately through these indexes and combined without duplicates before pagination; other filters apply to both routes. This improves owner-restricted list filtering without changing access rules. Startup waits for both indexes and invoice statistics refresh; allow build time and storage on large databases. Invalid concurrent indexes are repaired on retry. There is no accounting-data rewrite.

### Mixed-workload detail lookup migration

Migration 29 concurrently indexes customer payment-journal header references for submitted and cancelled journals. Invoice detail hydration now narrows journals by invoice header/line references before applying party and linked-payment rules. Cancelled payments remain visible in history and excluded from paid totals. Index creation does not rewrite accounting records. The migration waits for a valid index and refreshes journal statistics before startup completes.

### Queued financial reads and freshness

Identical pending report/list requests can share a future snapshot across commits only while their database work is still waiting for admission. Once execution starts, that read keeps its generation: a caller after another commit must receive a different fresh execution. Pool, filters, permissions and invalidation scopes remain part of the sharing key. Completion or failure removes financial results, including entries moved to a newer pending generation; completed financial values are not cached. The `sharing` field in workload-capacity metrics counts queued joins and rekeys without logging filters or financial data.

### Historical invoice warehouse choices

Migration 30 concurrently creates a partial warehouse index on nonblank invoice lines and refreshes their statistics. The invoice warehouse picker uses one indexed successor lookup per distinct warehouse rather than a full line-table DISTINCT on each metadata refresh. Historical warehouse codes are retained and request-level warehouse permissions still filter the choices. Display metadata keeps the existing 30-second lifetime; no financial values are cached. Allow index build time and storage on large datasets; invalid concurrent builds are repaired on retry.

### Controlled inventory deployment (schema 33)

Schema 33 installs warehouse count sessions, frozen snapshots, revision-based independent approval, immutable closure/audit records, canonical inventory movement timestamps, reviewed corrections and database posting guards. Installation alone leaves the policy inactive for a controlled client/role rollout. Existing reconciliations remain legacy records and do not establish closures. The first boundary for each warehouse must come from a new physical count. Activation affects **all warehouses**, not only warehouses that have already counted.

Before activation, deploy compatible website/API/mobile clients and take a verified backup. Review outstanding physical movements and legacy future-dated inventory. Activation refuses unregistered stock items/warehouses, undated/future movements, or stock balances that do not match ledger quantities/values. Resolve such data through an evidenced repair process; never force activation by changing the policy flag.

Run `npm run db:migrate` with the existing schema-owner credentials while application writers are drained. Then, from the project directory with owner-level role-management credentials, run `npm run inventory:setup`. On a host without Node.js, use the local image in a one-off container on the application's Docker network, mount the project read/write for this setup operation, pass the application environment, and run the script in `/workspace`; this is an operational command, not an isolated test. Stop the application before activation and restart it immediately after setup. Do not expose an older app version during rollout.

The setup command creates a database-specific `wm_inventory_runtime_*` login, grants ordinary application access while withholding direct stock/control/schema writes, activates inventory controls, and atomically writes generated `POSTGRES_RUNTIME_USER` / `POSTGRES_RUNTIME_PASSWORD` entries into the local `.env` without displaying the secret. It requires a writable environment file (`INVENTORY_ENV_FILE`, default `.env`). These runtime credentials take precedence over the owner `POSTGRES_USER` credentials for application queries. When an owner URL is configured, the pool replaces its credentials with the generated runtime login in memory; an explicit `POSTGRES_RUNTIME_URL` may instead provide the separate runtime connection. Owner URL credentials never take precedence over the generated runtime login. Restart with `docker compose up -d --build invoice-app` and verify the local app before admitting traffic.

Activation is one-way for the runtime and application administrators. Inventory-account GL lines require a matching controlled posting event and date; manual inventory journals and inventory-account mapping changes are rejected. Do not delete closures, lower boundaries, disable triggers or roll back by running an old image. Setup is intended to be performed by the operator during maintenance; no web administrator action can disable it. Database owners/superusers can alter database protections and remain an infrastructure trust boundary. In production, keep owner credentials in a separate migration job/environment and supply only runtime credentials to the web process. Runtime startup validates the schema version without attempting DDL; complete owner migrations before restarting it. Never grant runtime membership in the schema-owner role or schema CREATE/TRUNCATE rights.

Use UTC database timestamps with Kampala display. The count's effective cut-off is distinct from its later approval/submission time. All ordinary inventory posting uses database time after warehouse locks; document dates never override it. Clock regressions or future-dated legacy conflicts fail closed. Transfers lock both warehouses in stable order. A short database-wide posting gate coordinates count lifecycle changes with already-running application transactions; warehouse freezes then persist independently while staff count offline.

Backups include count/control/closure/correction records and supporting attachments. Runtime backups use the existing maintenance gate and an exported repeatable-read snapshot; table ACCESS SHARE locks permit the read-only inventory role to back up data without mutation rights. Transaction resets are prohibited once controls are active. Privileged restore procedures must verify recovered closures and recovery point before reopening traffic; restoring an older backup is not an application-level inventory reopening operation.

`npm run test:postgres` includes enabled-policy tests for posting/count concurrency, both transfer warehouses, independent approval and evidence revision invalidation, zero-difference closure, failed-commit rollback, abandonment, immutable closed originals, correction double-count prevention and restricted SQL privileges. Use the isolated Docker procedure above; never target the application database.

Schema version 34 allows completed Excel count sheets to revise unfinished reconciliations even during review or after approval. Run `npm run db:migrate` with the schema owner before starting the updated runtime; imports return the count to Counting and clear approval in the same transaction.

Schema version 35 extends administrator authority over unfinished reconciliations, including own-count approval and edits during review. Apply the owner migration before starting the updated runtime. Historical closure and terminal-record protections remain enforced.

### Posting date policy

Apply schema migration 36 with `npm run db:migrate` using the existing owner credentials while application writers are stopped, then rebuild/restart the runtime. Schema migration 36 enforces that new submitted vouchers, payments, attendance and ledger postings cannot be dated after today in Africa/Kampala, including website, API and Admin operations. Future-dated drafts remain available for preparation; submission rechecks the date. Due dates and planning dates are unaffected. Existing records are not rewritten. Sales invoice accounting and generated journals use the selected invoice posting date; controlled physical inventory continues to use its separate server timestamp. Historical accounting and physical-stock reports can therefore show a sale on different dates.

### Historical stock and reconciliation date enforcement

Migration 37 adds database checks to controlled posting while preserving existing function identities and runtime grants. Stop application writers and run `npm run db:migrate` with the schema-owner credentials before restarting the updated runtime. Ordinary sales, purchase and stock-entry document timestamps must be after all affected warehouse reconciliation cut-offs. Stock-decreasing postings also check selected-date availability and later minimum balances under warehouse locks, including previous controlled backdated issues, repeated lines and concurrent submissions. Later physical receipts cannot supply earlier sales. The saved voucher header supplies the checked timestamp; movement payload dates cannot override it. Current-minute inputs with minute precision resolve to the submission instant for checks; earlier minutes and precise timestamps remain exact. Physical movements retain server timestamps. Approved count postings and current-period corrections retain their distinct workflows. No existing postings or closures are rewritten.


### Stock posting-event index (migration 38)

Run `npm run db:migrate` with the schema-owner credentials before starting the updated controlled runtime. Migration 38 builds `app_stock_ledger_posting_event_idx` on non-NULL `posting_event_id` values using `CREATE INDEX CONCURRENTLY`, outside a transaction, and checks that the index is ready and valid. It also refreshes statistics for that column. It does not rewrite vouchers, stock movements, accounting or inventory protections. New databases receive the same index through their migrations.

If the build is interrupted, rerun the owner migration: an invalid index with that name is dropped concurrently and rebuilt before the migration is recorded. Allow storage and time for PostgreSQL to scan the ledger; a concurrent build can wait for existing transactions. Runtime credentials cannot perform this migration. Rebuild/restart the updated app after the owner migration completes.


The [larger submission-only study](audits/invoice-submission-deep-study-2026-10-17/report.md)
records 1,420 further submissions, balanced same/different-warehouse bursts and
Admin/Standard HTTP timings on the retained synthetic VPS fixture. It identifies
historical-availability document lookups as the next optimization target. Its
read-only query prototype was not installed at the time of that study. Later
migrations 43–45 optimise availability checks; migration 46 adds the covering
index for final stock-balance verification, as described above.

The [Stock Ledger report investigation and mixed-workload retry](audits/stock-ledger-fix-2026-10-17/report.md)
records the report query change, balance regression checks and synthetic VPS measurements.
The report calculates chronological quantity balances after selecting the visible page,
using the existing item/warehouse/date index; this change needs no schema migration.

The [General Ledger execution and queue investigation](audits/report-execution-study-2026-10-17/report.md)
separates ownership-scoped SQL costs, CSV export work and admission waiting. Its
one-versus-two-report experiments used temporary benchmark settings; application
source and permanent concurrency/JIT settings were left unchanged.

The [General Ledger CSV query and index review](audits/gl-export-query-review-2026-10-17/report.md)
compares the original export, temporary composite indexing, redundant-sort removal
and separate opening balances. At the time of that review its SQL rewrites were
prototypes, and the temporary index was removed.

General Ledger CSV, Excel and PDF exports now calculate eligible dated exports
from opening totals in the existing transactionally maintained `wm_gl_daily`
table and a running window over only the selected period. Ownership, party,
text and individual-voucher restrictions retain detailed historical matching.
The redundant inner output sort is removed from dated historical queries.
This change requires no schema migration, additional index or balance refresh.
The [export implementation validation](audits/gl-export-fix-2026-10-18/report.md)
records local regression checks and before/after measurements on the retained
synthetic VPS fixture.

Ownership-restricted General Ledger bulk exports now build distinct permitted
voucher keys and use the existing voucher index to retrieve ordinary entries.
Reversals match their original source IDs separately; account, category and HR
rules retain their existing meaning. Source existence already established by
these lookups is reused for ordinary entries. Single-voucher exports keep their
direct query. This path disables JIT only within its read-only export transaction,
consistent with interactive reports; it changes no persistent database or queue
setting. No new index, schema migration, ownership cache or posting writes are
required. The [ownership export validation](audits/ownership-ledger-2026-10-18/report.md)
records query experiments, regression coverage and measurements.

The [mixed posting, browsing and export retry](audits/mixed-export-retry-2026-10-18/report.md)
compares both export fixes with the original implementation on the retained
million-invoice fixture. CSV median time falls from 30.59 to 3.67 seconds under
the sampled mixed workload, with successful posting and full accounting/stock
reconciliation. Browsing and interactive-report p95 do not improve; restricted
interactive GL execution and report admission remain performance constraints.
This bounded comparison does not establish maximum concurrent-user capacity.

Ownership-restricted interactive General Ledger pages that require detailed
permission matching and have no Account filter
use permitted voucher lookups for totals and rows. A single query reuses narrow
matching balance history for opening totals, page selection and running balances,
applying To, party, search and account/access restrictions before materializing
that history. Descriptive fields and voucher-link checks are loaded for the
selected page. Permitted voucher keys are ordered before indexed lookups to avoid
random reads across the historical ledger. Schema migration 41 builds journal
creator, posted-voucher, reversal-source and daily-balance covering indexes
concurrently. Interrupted invalid index builds are retried; allow extra disk
space and startup time for the builds on a large existing database. No persisted
result cache or report-concurrency change is introduced. Account-filtered and individual-voucher pages retain their direct
matching path. The [interactive GL validation](audits/interactive-ledger-2026-10-18/report.md)
records execution plans, result-equivalence checks and the mixed-workload retry.

Migration 42 adds `wm_gl_owned_entries`, a narrow indexed projection of non-HR
ledger entries and their source ownership, and `wm_gl_owned_daily`, transactionally
maintained daily totals grouped by ownership signatures, account, voucher type
and contention bucket. A small `wm_gl_owned_scopes` registry resolves permitted
signatures once per query; covering indexes retrieve those exact groups, and
historical balances for the displayed accounts are accumulated together.
Ordinary owner-scoped interactive GL pages use these for
period rows, counts and opening/running balances. Overlapping creator, assigned
invoicer and linked supplier-payment ownership is represented once per entry.
Source ownership changes, payment relinking, backdated ledger edits, reversals,
deletions and truncation update the derived records within the original transaction.
Per-user permissions are evaluated on each read, not stored as financial result
caches. Category/account access lists, HR grants, grouping, party/text filters and
individual-voucher reports retain the existing detailed path; bulk exports are
unchanged. Report admission limits and deadlines are unchanged.

For this upgrade, stop application writers, build the updated image with
`docker compose build invoice-app`, run `docker compose run --rm --no-deps
--entrypoint node invoice-app scripts/migrate.js` using the existing schema-owner
settings, then run `docker compose up -d --build invoice-app`. Migration 42 locks
source voucher/payment tables and the GL against writes while backfilling both
derived tables and their indexes. Allow a quiet maintenance period and additional
disk/WAL space proportional to the ledger size. Existing GL readers can continue
during backfill. The migration grants SELECT on the derived tables to existing
non-superuser roles that can read the GL; trigger routines maintain them as the
schema owner. Controlled-runtime provisioning grants these tables read-only
access. Do not manually edit these tables or disable their triggers. Normal
PostgreSQL backups include all three derived tables and their trigger definitions.

The retained full-size follow-up for this change is controlled with
`python3 -B audits/owned-ledger-balances-2026-10-20/recheck.py status`.
Its fixture, frozen image, private configuration and output are separate from
the original benchmark and the 19 October repeat; retain all of them until the
user explicitly requests removal.

Stock Ledger ownership checks now use indexed source-voucher probes instead of
preloading all owned source IDs. Invoice warehouse/customer authorization reads
only the relevant fields, and invoice detail hydration holds one connection and
one repeatable-read snapshot for its header, lines and payments. These changes
need no additional migration beyond the existing schema version 42 and do not
change access rules, read admission limits or request deadlines.

The [read-contention follow-up](audits/read-contention-2026-10-20/report.md)
records this implementation and its verification. Its controller is
`python3 -B audits/read-contention-2026-10-20/recheck.py` (prepare/start/status).
Further repeats reuse the retained isolated copy and append uniquely identified
traffic instead of making another full database copy. Every repeat has a new
private output directory and frozen image; existing records, configurations and
results are preserved. This measures a reusable warm fixture, not a fresh
cold-cache run. The database/job CPU and memory caps, request deadlines and 6 GiB
disk reserve remain unchanged. A passing short 50-user diagnostic on the same
source is required before this controller starts the full 10/20/50 repeat.

Invoice payment validation also narrows manual customer journals by indexed
header and line references before calculating the remaining balance. It keeps
the invoice lock, party matching, cancellation exclusions and linked-payment
deduplication. No new index or migration is required.


The large controlled-inventory mixed workload has a separate retained controller:
`python3 -B audits/controlled-erp-mixed-2026-10-20/control.py status`.
It uses a cold copy of the original synthetic full fixture, upgrades that copy,
activates inventory controls and provisions a restricted runtime role before
traffic, then checks integrity before and after the 10/20/50-user HTTP phases.
App connection, report and export settings use the local app defaults;
database/job CPU and memory limits remain explicit benchmark caps. The workload
uses current Kampala document dates/times. The retained manifest records both
database storage on the benchmark volume and a separate tablespace for summaries and temporary query files under
`data/erp-benchmark/`; both must remain mounted for future use. The monitor retains
results and stops completed benchmark containers. It enforces six GiB free on the
benchmark volume and two GiB on the root volume. Private configuration stays in
the retained run directory. Existing legacy fixtures, images, configurations and
results remain untouched; this controller does not reseed or reset them.
