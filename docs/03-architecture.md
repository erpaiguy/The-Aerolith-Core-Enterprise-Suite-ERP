# Phase 3: Architecture

## 1. Shape

A **modular monolith** split into two planes.

```
                 ┌──────────────── Control Plane (ours) ────────────────┐
 Website ───────▶│ Signup · Auth · Tenant Catalog · Plans/Entitlements  │
 (trial/download)│ Billing (Razorpay) · Licence signer · Provisioner    │
                 │ Migration orchestrator · Admin console · Audit       │
                 └───────────────┬──────────────────────────────────────┘
                                 │ tenant_id → connection descriptor
 Browser SPA ─┐                  ▼
 Desktop (Electron)─▶ API Gateway ─▶ Tenant Resolver ─▶ Connection Manager (LRU pools + PgBouncer)
                                 │
                 ┌───────────────┴──────────── Data Plane ──────────────┐
                 │ ERP modules (NestJS): Projects, BOQ, Procurement, ... │
                 │ Workers (BullMQ): reports, notifications, imports      │
                 └───────────────┬───────────────┬───────────────┬───────┘
                                 ▼               ▼               ▼
                          Shared cluster    Dedicated DB     Tenant's own DB
                          (DB per tenant)   (managed)        (BYO-DB)
```

## 2. Deployment modes (one codebase)

| Mode | Where app runs | Where tenant DB lives | Licence | Plan |
|------|----------------|-----------------------|---------|------|
| A. Managed shared | Our cloud | Our shared Postgres cluster, **one database per tenant** | Cloud entitlement | Trial, Starter, Growth |
| B. Managed dedicated | Our cloud | Dedicated Postgres instance for the tenant | Cloud entitlement | Business |
| C. BYO-DB | Our cloud | Tenant's own Postgres (TLS, IP-allowlisted, least-privilege role) | Cloud entitlement | Business+ |
| D. Self-hosted | Tenant's server (Docker Compose / Helm) | Tenant's Postgres | **Signed offline licence** | Enterprise |

Same migrations and same app for all four. Only the *connection descriptor* and *licence source* differ.

## 3. Control plane data (our DB, never tenant data)

`tenants`, `tenant_databases` (mode, host, port, db name, encrypted credentials ref, schema_version, status),
`tenant_owners` (admin email identity, one per tenant plus optional co-owners), `licence_keys`, `device_activations`, `plans`, `entitlements`, `subscriptions`,
`licences`, `invoices`, `audit_events`, `migration_runs`.

Credentials for BYO-DB are envelope-encrypted (KMS or libsodium sealed box), never in plain config.

## 4. Request flow

1. Client calls `https://{tenant}.app.example.in/api/...` (subdomain) or sends `X-Tenant`.
2. Gateway authenticates the token, resolves `tenant_id`, checks entitlement (active/trial/suspended, seat count, module flags).
3. Connection Manager returns a pooled connection for that tenant's database (LRU, capped, idle eviction).
4. Module code runs with a **tenant-scoped context object**. Modules cannot receive a raw cross-tenant connection.
5. Audit event is written to the tenant DB; usage counters go to the control plane.

## 5. Per-tenant database isolation: operational rules

- A migration is **versioned and backwards-compatible for one release** (expand, then contract) so old and new app versions can coexist during rollout.
- The **migration orchestrator** runs with bounded concurrency, records every tenant's result, and can pause a rollout on failure threshold. Failed tenants are quarantined (read-only banner), not left half-migrated.
- Backups: `pg_dump`/WAL archiving per database, restore tested monthly. Restore of a single tenant must be a one-command operation.
- Connection budget: Postgres `max_connections` is the real ceiling. PgBouncer in transaction mode, pools per tenant capped small (e.g. 5), idle eviction.
- Tenant-scoped test fixture: every integration test runs against two tenants and asserts no leakage.
- A tenant's BYO-DB being down must degrade only that tenant. Circuit breaker per tenant.

## 6. Identity, login and multi-user model (rev 2)

Two kinds of people, two login paths.

| | Tenant Admin (owner) | Tenant User (staff) |
|---|---|---|
| Created by | Website signup with their email | Tenant Admin, inside the app |
| Website/portal login | Email + password | Not applicable |
| App login | **Email + password + licence key** | **Username + password** (+ tenant code/licence key on first activation of a device) |
| Credentials stored | Control plane | **Tenant's own database** (so BYO-DB and self-hosted tenants keep their users) |
| Forgot / change password | Yes | Yes |

**Licence key is a tenant locator and device activation token, not a secret.** Keys get shared and pasted into emails.
The password is the security factor. The key tells the server which tenant database to open, and it is bound to a
device activation count. Admin can revoke a device or rotate the key from the portal.

**Key delivery (two paths, as specified):**
1. Download from the website: the key is shown in the customer portal and displayed on the download page after login.
2. Emailed: the key is sent from our company domain email to the tenant's signup email. [Guessing] I read "domain
   email" as our own company domain address; tell me if you meant something else.

**Usernames:** unique within a tenant, not globally. The login screen therefore carries the tenant context
(licence key remembered after first activation on that device, or tenant code entered once).

**Forgot password, per user type:**
- Admin: email reset link (single-use, 15 min expiry).
- Staff with an email or mobile on file: self-service reset link/OTP.
- Staff with **no email or mobile**: self-service is impossible by definition. The reset becomes admin-initiated
  (admin issues a one-time temporary password, user must change on next login). **I recommend requiring email or
  mobile when the admin creates a user, with admin-reset as the fallback.**

**Change password:** any logged-in user; requires the current password; revokes other sessions on success.

**Rules for all accounts:** Argon2id hashing, minimum length + breached-password check, login rate limiting and
lockout with backoff, no password ever visible to admins, forced change on first login of an admin-issued password,
audit events for every login, reset, and change, optional TOTP for admins (mandatory on paid plans, to decide in Phase 9).

**Authorization:** roles (Owner, Admin, Estimator, Project Manager, Engineer, Accounts, Store, Viewer, custom) with
permissions of the form `module.resource.action` and optional project scope. Single-user tenant = a tenant with only
the Owner. Seat limits come from entitlements.

**Self-hosted mode:** the identity and licence-verification services ship inside the deployment, so logins work with
no internet. Licence file is verified offline (see §10).

## 7. Cross-cutting building blocks (Wave 0)

Approval/workflow engine, document numbering series (financial-year aware), audit log, attachments, notifications
(email/WhatsApp/in-app), custom fields, import/export (Excel), i18n (en-IN first, Hindi later), money as integer
paise with explicit rounding rules, FY (Apr-Mar) handling, soft delete with retention.

## 8. India-specific constraints that shape the design now

GST (CGST/SGST/IGST, HSN/SAC, place of supply), TDS (194C/194J etc. on sub-contractor bills), retention money and
security deposits, RA (running account) bills with measurement sheets, e-invoice IRN and e-way bill hooks,
RERA project accounts, data residency in India, DPDP Act consent and erasure.
These are modelled in the finance core from the start. Retrofitting them is expensive.

## 9. Desktop vs browser

Same SPA bundle. The **Electron** shell adds native file access (drawings, bulk upload), print/PDF, auto-update,
deep links, and the OS keychain (via `safeStorage`) for refresh tokens. Security posture: context isolation on,
node integration off, strict IPC allowlist, signed and notarised builds. All business logic stays on the server, so
there is no divergence between browser and desktop.

## 10. Licensing and trial

- Website signup creates a tenant in `trial` (14-30 days, module and data caps). Licence key issued and emailed.
- Browser access: admin signs in with email + password + licence key, staff with username + password. Desktop is identical after device activation.
- Entitlements (plan, modules, seats, expiry, state) are checked server-side on every request and cached for seconds.
- Self-hosted: Ed25519-signed licence file (tenant, seats, modules, expiry, grace). Verified offline with an embedded public key. It deters casual piracy and does not stop a determined one.

## 11. Key decisions and trade-offs

| Decision | Chosen | Cost accepted |
|----------|--------|---------------|
| Database per tenant for all | Yes (your call) | Fleet ops: migrations, backups, pooling. Mitigated by orchestrator and connection manager. |
| Modular monolith | Yes | Needs discipline on module boundaries (lint rules, no cross-module table access) |
| Electron, online-only desktop | Yes | Poor-signal sites can't use it. Revisit with an offline-capable mobile/PWA in Wave 4. |
| Admin identity in control plane, staff identity in tenant DB | Yes | Login must resolve tenant first (licence key/tenant code). Staff without email need admin-reset. |
| Typed SQL data layer, no ORM on hot paths | Yes | More hand-written SQL |

## 12. Open questions for Phase 4+

1. Which accounting depth: accounts-lite with Tally export, or full double-entry GL inside the app?
2. Do you need WhatsApp notifications at MVP (Meta Business API cost and approval time)?
3. Will you host for tenants' BYO-DB inside India only?
4. Who is the pilot customer, and which of their workflows is the acceptance test?

## 13. Performance architecture (requirement: 1M+ BOQ lines, multiple BOQs, 50+ pages of micro/macro schedules)

[Certain] This requirement is a design constraint now. It cannot be added after the UI exists.

**Data model**
- Line items in one partitioned table keyed by (boq_id, ...); hierarchy by materialized path/ltree plus a stored sort key.
- Parent totals come from **incrementally maintained rollups** (delta updates on edit), never from summing 1M rows on read.
- Narrow hot rows, wide cold data (notes, attachments) in side tables. Covering indexes for the grid's sort/filter columns.
- Edits are written as batched, versioned changes. Optimistic concurrency per row, conflict surfaced to the user.

**API**
- Grid reads use a **server-side row model**: the client asks for a window (rows N..N+200, sort, filter, expanded groups); the server answers with keyset pagination. The client never holds the full BOQ.
- Bulk import via streamed upload, validated in chunks, loaded with `COPY` into staging, then merged. Bulk export via streamed writers.
- Long operations (import, recalculation, revision compare) run as background jobs with progress events over WebSocket.

**Scheduling (micro and macro plans)**
- Activities, links, calendars, resources in normalised tables; macro plans are **rollups** of micro plans via WBS.
- CPM/forward-backward pass in a worker (Rust/WASM if profiling requires), **incremental recalculation** from changed nodes.
- Gantt renders only visible rows and time range on canvas. 50+ pages is a viewport problem, not a data problem.

**Client**
- Canvas virtual grid, row virtualization, column virtualization, web workers for parsing and local filtering of the visible window, debounced saves, undo/redo as a local command stack.

**Targets (starting hypotheses, to be validated in the Wave 0 benchmark spike)** [Guessing]

| Operation | Target |
|-----------|--------|
| Open a 1M-line BOQ (first window painted) | < 1.5 s |
| Scroll/page a window | < 100 ms p95 |
| Filter or sort on an indexed column | < 500 ms |
| Edit a quantity and see ancestor totals update | < 300 ms |
| Import 1M lines from Excel/CSV | < 5 min |
| Full CPM recalculation, 50k activities | < 3 s |

**Benchmark spike (Wave 0, before any module UI):** generate a synthetic tenant with 5 BOQs x 200k lines and a
50k-activity schedule, then measure every row in the table above on a mid-range laptop and on the cheapest hosting tier.
If a target fails, the stack changes before module work starts.
