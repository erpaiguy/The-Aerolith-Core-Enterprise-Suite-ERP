# Authentication and Users (Wave 0 step 5)

Code: `apps/api/src/auth`. Migrations: `control-plane/0003_auth.sql`, `tenant/0002_sessions.sql`.

## Who signs in, and how

| Who | Identity stored in | Sign-in | Second factor | Forgot password |
|-----|--------------------|---------|---------------|-----------------|
| Platform operator (you, owner console) | Control plane `core.operator` | Email + password | **TOTP, mandatory** | Another operator, or the CLI (single-owner: keep the recovery codes) |
| Tenant admin | Control plane `core.owner_account` | Email + password, on a device activated with the licence key | **TOTP, mandatory** | Email link, valid 30 minutes |
| Staff (manager, worker) | Tenant's own database `platform.user` | Username + password, on an activated device | None | Request to the admin, who issues a one-time password |

**The tenant is always taken from the device's signed entitlement token** (from licence activation), never from a
field the client sends. Staff usernames are unique per tenant and cannot contain `@`, so `@` routes a sign-in to the
admin path.

## First sign-in flows

- **Operator:** `pnpm --filter @aerolith/api operator:create -- --email you@domain --name "You"` prints a one-time
  password → sign in → set up an authenticator app (scan the `otpauthUri` as a QR code) → confirm one code → receive
  10 recovery codes (shown once; store offline, docs/09-security.md §7) → sign in with a code → change the password.
- **Tenant admin:** the trial-creation email contains a 7-day **set-password link** → set a password → sign in on an
  activated device → set up the authenticator → sign in with email + password + code.
- **Staff:** the admin creates the user and gets a 12-character one-time password (shown once) → the user signs in →
  every route except "change password", "me" and "log out" is blocked until they choose their own password.

## Sessions

| | Value |
|---|---|
| Access token | 15 minutes, HMAC-signed, carries tenant, user, role, licence state |
| Refresh token | Single use, rotated on every refresh, stored only as an HMAC |
| Stolen refresh token | Re-using an old one ends the session for both holders |
| Idle timeout | Browser 30 minutes, desktop 12 hours (Phase 9) |
| Absolute lifetime | Tenant sessions 30 days, operator sessions 12 hours |
| Password changed / reset / user deactivated / licence revoked | Other sessions are revoked |

## Protections

| Control | Detail |
|---------|--------|
| Password hashing | Argon2id (19 MiB, 2 passes). Unknown users still cost one hash, so timing doesn't reveal usernames |
| Password policy | At least 10 characters, not in a built-in list of common passwords, must not contain the username |
| Lockout | 5 wrong attempts → 15-minute lock, for every identity type. The response stays "Incorrect sign-in details" |
| TOTP | RFC 6238 (tested against the RFC's own test vectors), ±30 s drift, each code usable once |
| Recovery codes | 10 per person, single use, stored as SHA-256 |
| Rate limits (per IP, per route, per minute) | Login 10, refresh 60, change password 10, reset request 5, admin forgot/set password 5/10, MFA 10, licence activation 20, downloads 10, onboarding 30 |
| Enumeration | Reset requests and forgot-password always return the same response |
| Owner console roles | `owner` can change things; `support` and `read_only` can only read (plus their own password and sign-out) |

Rate limits are kept in memory per API process, which fits the single-server trial. Move them to Valkey when the API
runs on more than one server. Set `TRUST_PROXY=true` only behind a proxy or tunnel that sets `X-Forwarded-For`,
otherwise every request appears to come from the proxy.

## Seats (docs/06-pricing.md)

Creating or reactivating a user, or changing a role, checks the licence's seat cap and role caps inside a
transaction with a lock, so two admins can't overfill seats at the same time. Trial: 1 admin, 1 manager, 1 worker.
Deactivating a user frees the seat immediately (owner decision) and signs them out. Read-only licences can still
deactivate users but cannot add or reactivate them.

## Routes

| Method | Path | Who |
|--------|------|-----|
| POST | `/auth/login` | Anyone with an activated device: `{entitlementToken, identifier, password, code?, client}` |
| POST | `/auth/refresh`, `/auth/logout` | Signed-in user |
| GET | `/auth/me` | Signed-in user |
| POST | `/auth/change-password` | Signed-in user |
| POST | `/auth/password-reset-request` | Staff (from the sign-in screen) |
| POST | `/auth/admin/forgot-password`, `/auth/admin/set-password` | Tenant admin |
| POST | `/auth/mfa/enroll`, `/auth/mfa/confirm` | Admin or operator holding an enrolment token |
| GET/POST | `/tenant/users`, `/tenant/users/:id/{deactivate,reactivate,role}` | Tenant admin |
| GET/POST | `/tenant/password-resets`, `/tenant/password-resets/:id/{issue,dismiss}` | Tenant admin |
| GET | `/tenant/notifications` | Signed-in user (the basic pending inbox) |
| POST | `/owner/auth/login`, `/owner/auth/refresh`, `/owner/auth/change-password`, `/owner/auth/logout` | Operators |

## Not yet built

Email delivery (the outbox fills; the sender comes with the email worker), the web/desktop screens, MFA reset by
support (docs/09-security.md §3.4 checklist), custom roles beyond manager/worker, and a remote breached-password check.
