# Implemented API foundation (Phase 1)

The versioned API is mounted at `/api/v1`. The [implemented OpenAPI contract](openapi.v1.json) covers authentication, self identity and credential administration. The [Phase 0 draft](openapi.v1.draft.json) also contains future business resources; those reads and financial endpoints are not available yet.

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

Scopes: `masters:read`, `stock:read`, `invoices:read`, `invoices:create`, `invoices:submit`, `payments:record`. Scopes reserve the future business actions and do not make those endpoints available now. They narrow the account's current permissions; they cannot grant new permissions. Configure the new account's role, user overrides and record assignments using existing administration controls. Standard-role ownership limits remain relevant to later invoice access.

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

`tests/api.test.js` exercises real HTTP authentication, existing cookie login, refresh races/revocation, account/scopes, expiry, error envelopes, rate limits, actual website payment posting, transaction-wrapper parity, concurrent retry protection, permanent references, audit attribution and rollback. Run `npm run test:postgres` using README's isolated local database procedure so API integration tests are enabled and no database checks are skipped.

Remaining phases add scoped master/invoice reads, strict financial HTTP contracts, final transaction-local reference validation, performance measurements, monitoring/alerts and client pilot acceptance. No multiple-invoice allocation, existing payment schema change, or website pricing change is authorized by this foundation.
