# Implemented API service (Phases 1–2)

The versioned API is mounted at `/api/v1`. The [implemented OpenAPI contract](openapi.v1.json) covers authentication, self identity, credential administration and authorized business reads. The [Phase 0 draft](openapi.v1.draft.json) also contains future financial mutations; those write endpoints are not available yet.

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

Sales selectors return `data.invoicers` or `data.receiving_accounts` according to the required `purpose`, plus the same pagination metadata. Invoicers expose only ID, label and active status. Receiving accounts expose ID, label, code, active status and the existing derived cash/bank method; this is not a general employee or chart-of-accounts API. Public financial write endpoints remain planned.

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

Scopes: `masters:read`, `stock:read`, `invoices:read`, `invoices:create`, `invoices:submit`, `payments:record`. Read/selector scopes enable only implemented endpoints; financial mutation scopes do not enable planned write endpoints. They narrow the account's current permissions; they cannot grant new permissions. Configure the new account's role, user overrides and record assignments using existing administration controls. Standard-role ownership limits remain relevant to later invoice access.

Integration accounts cannot log in through the website or mobile password login, even if their password is reset. Their account flag defaults false for existing users. Deactivation immediately denies credential use; promotion to Admin also denies integration access. Do not reset service-account passwords as a rotation mechanism: this sets the existing password-change restriction and blocks token use. Revoke compromised credentials and issue replacements instead.

## Transport, validation and operational limits

Production API requests require HTTPS, including when the website uses the private HTTP cookie exception. Configure the existing trusted reverse proxy and TLS. Native clients do not require CORS; browser-origin requests are not enabled. The API rejects website session cookies and mixed credentials. Existing website cookie/origin checks are unchanged. Login/refresh reject bearer headers and do not log passwords or tokens.

JSON writes require `Content-Type: application/json`, use the existing 1 MB body cap, reject unknown fields, and bound credentials/password strings. Error responses use `error.code`, `error.message`, and `error.request_id`; malformed JSON uses the same envelope. Every API response includes a server-generated `X-Request-ID`. Internal and database errors are hidden.

PostgreSQL-backed fixed-window limits coordinate across app instances: login 20 requests/IP and 10 requests/username per 15 minutes; refresh 60/IP/minute; protected requests 300/IP/minute and 120/account/minute. Limits count attempts, not just failures. Throttling returns 429 and `Retry-After`. These are initial defensive limits, not measured capacity targets. Proxies must supply client addresses correctly under the existing trusted-proxy setting.

## Transaction and audit foundation

Internal sales services reuse the existing draft, submission and payment domain logic through client-taking functions. Website wrappers and their financial behavior remain unchanged. The website uses the extracted validation helpers with the same rules and errors. There are no public financial API routes yet; their strict JSON validation and full contract serializers belong to later phases.

The shared retry executor rechecks credentials, permissions and resource access before replay, serializes concurrent duplicates, and commits business effects, a seven-day retry response and an audit record in one transaction. Identical keys/payloads return the saved result; changed payloads conflict. Contention exceeding three seconds returns a retryable conflict. The executor operates on validated JSON and must be wired only to explicit operation-specific services.

API-only permanent payment source/reference records survive retry expiry and credential rotation. The same account/source/reference cannot post again under a new key; changed payment details conflict. The initial adapter targets one invoice. Existing payment references are still rewritten to journal numbers by the existing posting logic; the external reference is preserved separately in the API-owned table. No uniqueness constraints or behavior changes were introduced to existing payment tables. These checks do not deduplicate independent website payments or references used by different integration accounts.

API audit records link request, actor, session/credential and operation outcome; financial services also link the resulting resource. Existing business creator/updater stamps remain intact. Authentication failures, denials, refresh replay, issuance and revocation are recorded without credential values. Financial audit and permanent payment references are retained; access to these tables is through database operations, with no public audit-edit endpoint.

## Verification and remaining scope

`tests/api-reads.test.js` covers scoped resources, public fields, counts/pages, selectors, pricing parity and financial immutability. `tests/api.test.js` exercises real HTTP authentication, existing cookie login, refresh races/revocation, account/scopes, expiry, error envelopes, rate limits, actual website payment posting, transaction-wrapper parity, concurrent retry protection, permanent references, audit attribution and rollback. Run `npm run test:postgres` using README's isolated local database procedure so API integration tests are enabled and no database checks are skipped.

Remaining phases add strict financial HTTP contracts, final transaction-local reference validation, performance measurements, monitoring/alerts and client pilot acceptance. No multiple-invoice allocation, existing payment schema change, or website pricing change is authorized by this foundation.
