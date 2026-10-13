# Implemented API service (Phases 1–4)

The versioned API is mounted at `/api/v1`. The [implemented OpenAPI contract](openapi.v1.json) covers 23 operations: authentication, self identity, credential administration, authorized business reads and the financial operations below. The [Phase 0 draft](openapi.v1.draft.json) is a historical proposal; use the implemented contract for current fields and limits. Real-client staging acceptance and production launch checks remain open.

Phase 5 operational tooling now includes redacted request/aggregate metrics, API containment, a disposable backup/restore drill and a bearer read-load tool. See the [operations runbook](operations.md) and [Phase 5 report](phase-5-report.md). These local capabilities do not establish real-client or staging acceptance.

An [isolated local HTTPS staging deployment](local-staging.md) now verifies production-mode proxy/TLS behavior, restricted mobile/integration API flows and website reconciliation using synthetic records. Generated credentials and redacted results remain private under `data/api-staging/`. Scripted staging checks are separate from actual native mobile/business-client acceptance; those launch gates remain open.

## Invoice and receipt operations

All three operations require bearer authentication, `Content-Type: application/json` and exactly one `Idempotency-Key` header containing 1–128 visible ASCII characters without spaces. Query parameters are rejected. Integration scopes narrow current account permissions; mobile users use their account permissions directly.

| Endpoint | Scope / action | Behavior |
| --- | --- | --- |
| POST `/invoices` | `invoices:create` / `vouchers.sales.create` | Save a draft with authoritative names and server totals; no receipt or stock reservation |
| POST `/invoices/{id}/submit` | `invoices:submit` / `vouchers.sales.submit` | Submit a saved draft, posting existing stock and accounting effects; send `{}` |
| POST `/invoices/{id}/payments` | `payments:record` / `payments.sales.record` | Record a receipt for one submitted invoice using an active permitted Cash/Bank account |

Submission and receipts require the same parent-record visibility rules as existing website actions: creator/employee exceptions for Standard users, customer category, every line warehouse and price-list access. They do not implicitly grant invoice Read. Creating a draft checks current permitted customer, warehouse, price list, invoicer and optional cost center. Replaying creation also checks the saved invoice's current visibility, including changes made through the website.

Create example (illustrative identifiers; use your permitted master records):

```http
POST /api/v1/invoices
Authorization: Bearer <mobile-access-token-or-integration-token>
Content-Type: application/json
Idempotency-Key: order-2026-001-draft

{
  "customer_id": "C1",
  "warehouse": "Main",
  "price_list": "Retail",
  "invoicer_id": "E1",
  "invoice_date": "2026-10-01",
  "items": [{ "item_code": "I1", "quantity": "2", "unit_price": "100" }]
}
```

Required draft fields are shown above. Optional fields: `due_date`, `posting_time`, `cost_center`, `notes`, `non_system_invoice`, `tax_amount`, `discount_amount`. Dates are valid `YYYY-MM-DD` in years 0001–9999. Posting time accepts `HH:mm` or `HH:mm:ss`; existing storage normalization retains hours/minutes. If omitted, Kampala time is chosen on first successful creation, not during retry hashing. No due-date ordering rule is added to the website's existing date policy.

Drafts contain 1–200 lines, each accepting only `item_code`, `quantity`, `unit_price`. All lines use the header warehouse. Quantities are positive decimal strings with at most three fractional digits and maximum `99999999999.999`. Money inputs are nonnegative decimal strings with at most two fractional digits and maximum `999999999999`; payment amounts must be positive and remain positive after existing rounding. Leading zeros (except `0`), signs, exponent notation, numeric JSON values and overprecision are rejected. Rates, tax, discounts and receipts retain the existing whole-UGX rounding and totals behavior; there is no new rate-override policy or forced replacement of supplied rates with list rates. Line and aggregate storage bounds are checked transactionally.

Master identifiers are trimmed nonempty strings up to 200 characters. Optional `cost_center` may be empty. Notes allow up to 4000 characters and `non_system_invoice` up to 100; these may be empty. Strings reject NUL and surrounding whitespace. Client-supplied names, totals, method, status, item warehouse/costs, `amount_paid`, embedded `payments` and undocumented fields are rejected. Draft creation returns 201 with `data: {id, invoice_no, docstatus, subtotal, tax_amount, discount_amount, total}`; IDs and decimals are strings. Submission returns 200 with the same shape, showing `submitted`. These are saved operation results; fetch the current permitted invoice after subsequent edits or payments.

Receipt example, using a separate key and a saved submitted invoice:

```http
POST /api/v1/invoices/42/payments
Authorization: Bearer <mobile-access-token-or-integration-token>
Content-Type: application/json
Idempotency-Key: provider-receipt-001

{
  "payment_date": "2026-10-01",
  "amount": "50",
  "account_id": "1",
  "external_source": "provider",
  "external_reference": "receipt-001"
}
```

All displayed receipt fields are required; only `notes` is optional. `account_id` is a positive safe-integer string. The receiving account determines cash/bank method through existing posting. `external_source` is a trimmed nonempty string up to 100 characters, and `external_reference` up to 200. They are required for mobile and integration receipts alike. The existing journal number remains the website payment reference; external identity lives in the existing API-owned protection table. Success returns 201 with `data: {id, invoice_id}`, where `id` is the receipt database ID. Use the permitted invoice/payment GET endpoints for current receipt details and balances.

Retry keys are scoped by stable account, operation and resource path and retained for seven days. Retry the identical JSON with the same key after a lost/uncertain response, `409 operation_in_progress` or `503 operation_timed_out`. JSON object field order is irrelevant; changing a decimal's text or adding an optional field changes the validated payload. Identical authorized replays return the original status/body even after later website changes. `409 idempotency_conflict` rejects changed key reuse. After draft-key expiry, reconcile the original invoice rather than blindly recreating it.

The permanent account/source/reference namespace protects receipts across new keys, key expiry and credential rotation. An identical reference/payload returns the original receipt ID; changed payload or invoice returns `409 payment_reference_conflict`. Website cancellation never frees a reference or reactivates a receipt. Reference protection does not deduplicate independent website payments or other API accounts. Current action, parent and receiving-account access are checked before replay; revoked credentials cannot retrieve stored results.

Malformed/undocumented fields, decimal/date formats and key/header errors return 400; missing/revoked credentials 401; forbidden actions/references 403; hidden/missing invoices 404; document state conflicts 409; active-reference, insufficient-stock and receipt/balance business failures 422; throttling 429 with `Retry-After`. Posting, retry-result and audit failures roll back together. A failed submission retains its already committed draft. Draft editing, cancellation, cash-sale shortcuts and multiple-invoice allocation are not API endpoints; corrections use existing website workflows.

## Authorized business reads

| Endpoint | Scope and account access | Response |
| --- | --- | --- |
| GET `/customers`, `/suppliers`, `/items`, `/warehouses`, `/price-lists`, `/cost-centers` | `masters:read` plus the corresponding existing website lookup permission alternatives | Enabled permitted master records |
| GET `/stock-balances?warehouse=Main` | `stock:read` plus the existing stock-balance lookup alternatives and permitted warehouse | Nonzero balances in the requested warehouse |
| GET `/invoices` | `invoices:read` and `vouchers.sales.view` | Permitted invoice summaries |
| GET `/invoices/{id}` | Same action, scope and parent visibility | Invoice detail and item lines |
| GET `/invoices/{id}/payments` | Same invoice Read access plus receipt account visibility | Existing receipts/allocations linked to that invoice |
| GET `/sales-options?purpose=invoicing` | `invoices:create` and `vouchers.sales.create` | Permitted active invoicer IDs/names only |
| GET `/sales-options?purpose=payments` | `payments:record` and `payments.sales.record` | Permitted active asset Cash/Bank receiving accounts only |

Mobile users use their account permissions; integration accounts must additionally hold the indicated scope. Website lookup permission alternatives are preserved: for example, sales Create permits customer/item/warehouse selection without a separate master Read grant. Customer/supplier category scope, named record assignments, explicit denials and Standard ownership/employee exceptions apply. Every nonempty invoice line warehouse must be permitted; a filter for one warehouse does not expose mixed-warehouse invoices with forbidden lines. Missing and hidden invoice IDs both return 404.

List responses contain `data` and `meta: {page, page_size, total}`. Default page size is 50; maximum is 200. `page` is a positive integer capped at 1,000,000. Master lists keep the existing stable name/ID ordering; invoices default to descending ID. Scope restrictions run before invoice/master counts and page selection. There is no shared API response cache. Pages are ordinary live reads, not a snapshot across requests; concurrent changes can shift rows between pages.

All lists accept `page`, `page_size` and `q`. Invoice lists additionally accept `from`, `to` (valid calendar dates with from ≤ to), `customer_id`, `warehouse`, `docstatus` (draft/submitted/cancelled) and `sort` (id_asc/id_desc). Stock requires `warehouse` and accepts exact `item_code`. Unknown, repeated, nonscalar and oversized query parameters return 400; each string is bounded to 200 characters. Invoice detail accepts no query filters.

`/price-lists` returns active submitted UGX selling/both lists permitted for sales. `/items?price_list=Retail` optionally adds `unit_price`, `has_list_price` and `currency` using the website's existing list-rate/default-rate fallback; the list must itself be permitted, active, submitted and suitable for UGX sales. No rate or pricing rule is changed. Without this parameter, items do not expose rates or costs. Item search uses public identifiers, names, UOM, category and description; invoicer search uses only ID/name, so hidden costs and employee contacts cannot be inferred from results.

Money/quantity values are decimal strings; database numeric text is preserved where available, while invoice values follow existing server normalization/rounding. Resource IDs are strings. Invoice summaries and details omit raw audit identities and item cost/profit internals. Details omit embedded receipts; use the separate paginated payments endpoint. Invoice `amount_paid` and `balance_due` preserve the authorized website invoice calculations, including existing journal allocations; they are not recalculated when account restrictions hide individual receipts. `balance_due` is total minus paid on the displayed voucher, not a replacement for the accounting debtor report or an assertion that a cancelled document is payable.

Receipt visibility and search are filtered before their permitted count and page slicing. Ordinary receipt IDs are payment database IDs (`source: invoice_payment`); existing standalone journal allocations use `journal-{id}` (`source: journal_allocation`); legacy balance-only history uses `legacy-{invoiceId}` (`source: legacy_balance`). The latter two are read representations, not new payment records or cancellation identifiers. Receipts keep the domain's deterministic receipt-number order followed by journal date/ID order. When account scope is restricted, journal/legacy receipts without an explicit receiving account require permitted linked journal accounts; unidentified legacy accounts are concealed.

Sales selectors return `data.invoicers` or `data.receiving_accounts` according to the required `purpose`, plus the same pagination metadata. Invoicers expose only ID, label and active status. Receiving accounts expose ID, label, code, active status and the existing derived cash/bank method; this is not a general employee or chart-of-accounts API.

Both mobile access tokens and integration tokens use the same read request format:

```http
GET /api/v1/invoices?page_size=50&docstatus=submitted
Authorization: Bearer <mobile-access-token-or-integration-token>
Accept: application/json
```

Illustrative summary response (IDs, records and amounts vary):

```json
{
  "data": [
    {
      "id": "42",
      "invoice_no": "INV-000042",
      "docstatus": "submitted",
      "total": "100",
      "amount_paid": "30",
      "balance_due": "70"
    }
  ],
  "meta": { "page": 1, "page_size": 50, "total": 1 }
}
```

The illustration omits other required summary fields for brevity; the OpenAPI contract defines the full shape. A token with only `masters:read` cannot fetch this invoice resource, even when its account has sales Read permission. Native clients must use HTTPS in production and coordinate refresh as documented below.

## Mobile authentication

Use `POST /auth/login` with JSON `username` and `password`. Existing password verification and active-account checks apply. The response's `data` contains an opaque access token, refresh token, `token_type: Bearer`, `expires_in: 900` and `password_change_required`. Store credentials in the client's OS secure storage. Send `Authorization: Bearer <access-token>` on protected requests. Responses are `Cache-Control: no-store`.

Access tokens last 15 minutes. `POST /auth/refresh` accepts only `refresh_token` in JSON, without an Authorization header. Rotation replaces the access token and refresh token; the maximum session-family lifetime is 30 days from login. Refresh token history is retained until family expiry. Reuse, including concurrent reuse, revokes the whole family; coordinate refresh requests and sign in again after an uncertain refresh outcome rather than retrying an old refresh token. Refresh is deliberately not idempotent.

`GET /me` returns public identity, current account permission keys as `capabilities`, and `credential_scopes` (null for mobile users). Account permission keys are not a guarantee of record access; integrations must also satisfy scopes. Credentials and password hashes are never serialized. Unknown protected routes/methods return 404; absent/expired credentials return 401. HEAD/OPTIONS are not enabled.

Temporary-password sessions can call only `POST /auth/password` and `POST /auth/logout`. Password change accepts `current_password` and `new_password`, follows existing password requirements, revokes browser and mobile sessions, and requires a new login. Website password changes/resets invalidate mobile credentials through a password-version check without altering website password workflows. Logout accepts `{}` and revokes the caller's mobile family.

## Integration accounts and credentials

Authenticate an active Admin through the mobile login flow to manage credentials. Integration tokens cannot administer other credentials.

| Endpoint | JSON fields / behavior |
| --- | --- |
| POST `/integration-accounts` | `username`, non-admin `role`, `scopes`; creates a dedicated account and initial credential atomically |
| POST `/integration-credentials` | String `user_id`, `scopes`; issues another credential for an existing active integration account |
| GET `/integration-credentials` | Newest 200 credentials' metadata; never token hashes or secrets |
| POST `/integration-credentials/{id}/revoke` | `{}`; revokes the specified credential |

Issued credentials expire after 90 days. The secret is displayed only in the issuance response and stored as a SHA-256 hash. Rotate by issuing a replacement, updating the client, then revoking the old ID; overlapping credentials are supported. Retrieve IDs through the metadata endpoint if an issuance response is lost. Never retry account creation blindly; duplicate usernames conflict.

Scopes: `masters:read`, `stock:read`, `invoices:read`, `invoices:create`, `invoices:submit`, `payments:record`. These enable only the corresponding implemented endpoints and narrow the account's current permissions; they cannot grant new permissions. Configure the new account's role, user overrides and record assignments using existing administration controls. Standard-role ownership limits apply to invoice access.

Integration accounts cannot log in through the website or mobile password login, even if their password is reset. Their account flag defaults false for existing users. Deactivation immediately denies credential use; promotion to Admin also denies integration access. Do not reset service-account passwords as a rotation mechanism: this sets the existing password-change restriction and blocks token use. Revoke compromised credentials and issue replacements instead.

## Transport, validation and operational limits

Production API requests require HTTPS, including when the website uses the private HTTP cookie exception. Configure the existing trusted reverse proxy and TLS. Native clients do not require CORS; browser-origin requests are not enabled. The API rejects website session cookies and mixed credentials. Existing website cookie/origin checks are unchanged. Login/refresh reject bearer headers and do not log passwords or tokens.

JSON writes require `Content-Type: application/json`, use the existing 1 MB body cap, reject unknown fields, and bound credentials/password strings. Error responses use `error.code`, `error.message`, and `error.request_id`; malformed JSON uses the same envelope. Every API response includes a server-generated `X-Request-ID`. Internal and database errors are hidden.

When operators set `API_V1_ENABLED=false`, all new `/api/v1` requests return 503 `api_disabled`, including authentication, while the website remains available. Clients must retain financial keys/references and reconcile uncertain results when service returns. Containment does not revoke credentials or reverse earlier commits. HTTP 503 messages remain generic; clients use the stable error code. Deployment environment changes require app recreation.

PostgreSQL-backed fixed-window limits coordinate across app instances: login 20 requests/IP and 10 requests/username per 15 minutes; refresh 60/IP/minute; protected requests 300/IP/minute and 120/account/minute. Limits count attempts, not just failures. Throttling returns 429 and `Retry-After`. These are initial defensive limits, not measured capacity targets. Proxies must supply client addresses correctly under the existing trusted-proxy setting.

## Transaction and audit foundation

The financial routes use shared sales services and existing client-taking draft, submission and payment domain functions. Website wrappers and their financial behavior remain unchanged. The website uses the extracted validation helpers with the same rules and errors. Phase 4 adds no schema migration or change to existing payment tables, allocations or posting functions.

Financial authorization and final validation now use the same transaction connection as posting. User/role and credential/session locks stabilize current access until commit; refresh and logout follow the same user-before-session order. User locks allow concurrent audit foreign-key reads. Credential activity timestamps are best-effort under contention and skip pinned rows, while durable request audit remains available. A revocation that races an already authorized operation waits for that commit, then prevents subsequent requests/replays. Current actor identity supplies both record stamps and submission fields, even when the caller's previously resolved actor data is stale.

New API draft creation resolves customer, invoicer and item names from locked master records rather than trusting supplied labels. It checks current permitted/enabled reference choices and storage-safe quantities/amounts. Draft stock snapshots use the existing website normalization and do not reserve inventory. Request identity is hashed before mutable names, posting-time defaults and stock snapshots are derived, so these values do not invalidate an otherwise identical retry.

Submission locks/revalidates its stored invoice and item rows, checks active submitted items, and locks item/warehouse stock keys in deterministic order before invoking the unchanged posting function. Invoice lines are not reordered. Stock checks account for repeated item/warehouse lines. Saved header snapshots retain website eligibility: inactive historical customer, employee or price-list records do not newly prevent submission/payment; current record permissions still apply. New receipts lock an active permitted Cash/Bank account and reuse the existing payment/balance/journal logic. Final business checks run for new mutations, not for replaying an already committed result.

The shared retry executor rechecks credentials, permissions and resource access before replay, serializes concurrent duplicates, and commits business effects, a seven-day retry response and an audit record in one transaction. Identical keys/payloads return the saved result; changed payloads conflict. Contention exceeding three seconds returns a retryable conflict. The executor operates on validated JSON and must be wired only to explicit operation-specific services.

Financial transaction statements have a maximum 15-second timeout, retaining any shorter configured database statement timeout. Lock timeout/deadlock rolls back and returns a retryable 409; statement cancellation rolls back and returns 503 `operation_timed_out`. No automatic financial retry is performed. Clients must reuse the original key after contention or an uncertain response. Failed validation/posting/audit/retry-result storage commits no financial effects and does not consume a retry key. After ordinary keys expire, do not blindly repeat draft creation; reconcile the original resource first. Permanent payment references continue protecting receipts beyond key expiry and cancellation.

Migration 19 stores resource type/ID in API retry metadata so committed replays also carry their original audit resource link. Known older financial retry records with a usable resource ID are backfilled; original response bodies/statuses are retained. No existing payment table or allocation rule is changed.

API-only permanent payment source/reference records survive retry expiry and credential rotation. The same account/source/reference cannot post again under a new key; changed payment details conflict. The initial adapter targets one invoice. Existing payment references are still rewritten to journal numbers by the existing posting logic; the external reference is preserved separately in the API-owned table. No uniqueness constraints or behavior changes were introduced to existing payment tables. These checks do not deduplicate independent website payments or references used by different integration accounts.

API audit records link request, actor, session/credential and operation outcome; financial services also link the resulting resource. Existing business creator/updater stamps remain intact. Authentication failures, denials, refresh replay, issuance and revocation are recorded without credential values. Financial audit and permanent payment references are retained; access to these tables is through database operations, with no public audit-edit endpoint.

## Verification and remaining scope

`tests/api-transactions.test.js` covers final reference checks, real lock waits, scarce-stock/opposite-order concurrency, timeout/fault rollback, permanent references through cancellation and single-connection execution. `tests/api-reads.test.js` covers scoped resources, public fields, counts/pages, selectors, pricing parity and financial immutability. `tests/api.test.js` exercises real HTTP authentication, existing cookie login, refresh races/revocation, account/scopes, expiry, error envelopes, rate limits, actual website payment posting, transaction-wrapper parity, concurrent retry protection, permanent references, audit attribution and rollback. Run `npm run test:postgres` using README's isolated local database procedure so API integration tests are enabled and no database checks are skipped.

`tests/api-financial.test.js` verifies strict financial input and real HTTP creation/submission/receipts, concurrent retries, scoped denials, scarce-stock contention, overpayment serialization, audit/retry-storage rollback, permanent references after cancellation and website financial parity. Remaining launch work includes performance measurements, monitoring/alerts, recovery drills and real-client staging/pilot acceptance. See the [Phase 4 report](phase-4-report.md). No multiple-invoice allocation, existing payment schema change or website pricing change is introduced.

`tests/api-operations.test.js` verifies telemetry redaction and bounded labels, completion/disconnection accounting, configuration, API containment and bearer load-tool restrictions/status reporting. The financial HTTP suite checks distinct commit/key-replay/reference-replay metrics. Local PostgreSQL restoration is verified separately through the disposable drill; production log collection/alerts, representative recovery and staging capacity/client acceptance remain open.
