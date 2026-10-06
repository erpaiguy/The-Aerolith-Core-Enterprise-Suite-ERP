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

## 3. Control plane data (our DB, never tenant data; today hosted on Supabase, see infra-existing-stack.md)

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

## 6. Identity, login and multi-user model (rev 3)

Two kinds of people, and **two separate gates**: *who you are* (password) and *what the tenant may use* (licence key).

| | Tenant Admin (owner) | Tenant User (staff) |
|---|---|---|
| Created by | Website signup with their email | Tenant Admin, inside the app |
| Login to the app | **Email + password** | **Username + password** |
| Credentials stored | Control plane | **Tenant's own database** (BYO-DB and self-hosted tenants keep their users) |
| Forgot password | Email reset link (single-use, 15 min) | **"Request reset" to the Tenant Admin** (below) |
| Change password | Yes, needs current password | Yes, needs current password |

**Gate 1, login (password):** gets you into the app shell and your account screen. Username/email + password only.

**Gate 2, licence key (feature access):** mandatory to unlock features. The key is entered **once per device/browser
profile** (normally by the admin, who receives it), after which it is remembered and staff on that device just log in
with username + password. Without a valid key the app opens in a locked state: account, licence and data export only.
The key is a tenant locator and entitlement token. It is **not** a secret, so it never replaces the password.

**Licence states and behaviour:**

| State | Behaviour |
|-------|-----------|
| Trial active / Paid active | Full access to licensed modules |
| Expired or payment lapsed | Grace period (to decide in Phase 6), then **read-only + export always allowed** |
| Revoked / device limit exceeded | Features locked; admin can free a device in the portal |
| No key on this device | Locked state (above) |

**Usernames** are unique within a tenant. The tenant context comes from the activated key (desktop) or tenant
subdomain (browser).

**Password-reset request (staff):**
1. User taps "Forgot password" and enters their username. The response is always the same ("request sent if the account exists") so usernames cannot be probed.
2. A request lands in the admin's **Pending** inbox with the username, time, and device. It is rate limited, and repeated requests collapse into one.
3. Admin approves and issues a **one-time temporary password** (shown once, never stored in recoverable form). User must set a new password at next login. Reset is audited.
4. The admin never sees or sets a user's permanent password.

**Sole-Admin recovery (decided):**
1. Self-service: Admin taps "Forgot password" and gets an email link with a time-limited window to set a new password.
2. If they have lost access to that email: they write to the platform's domain support email. Support verifies identity
   (procedure defined in Phase 9, e.g. matching business registration/GST details and a callback) and then issues the same reset window.
3. After the change: all existing sessions are revoked, a notice goes to the registered email, and the licence key, devices, users and data are untouched. The Admin continues exactly as before.
[Likely] Step 2 is the social-engineering target, so it needs a written verification checklist and an audit trail. Never "verify" by reply-to-email alone.

**Rules for all accounts:** Argon2id hashing, minimum length + breached-password check, login rate limiting with
backoff and lockout, audit events for every login/reset/change, sessions revoked on password change, optional TOTP for
admins (decision in Phase 9).

**Authorization:** roles (Owner, Admin, Estimator, Project Manager, Engineer, Accounts, Store, Viewer, custom) with
permissions `module.resource.action` and optional project scope. Single-user tenant = only the Owner. Seat limits from
entitlements.

**Self-hosted mode:** identity and licence verification ship inside the deployment, so logins work offline. The licence
file is verified offline (see §10).

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

## 10. Licensing, trial and key-delivery automation

**Customer side (automatic, no human step):**
1. Visitor chooses **Trial** or **Paid** and clicks Download (or Open in browser).
2. They give an email. We **verify it** (link or OTP) *before* the download or key is released. This stops throwaway-email trial farming and typo'd addresses.
3. The system creates the tenant (trial) or links the paid subscription, generates the key, and **sends it automatically from the website's domain email** to the verified address. The key is also shown in the customer portal.
4. Trial keys expire (14-30 days). Paid keys follow the subscription. Both are checked server-side on every request (cached for seconds).
5. Automatic emails: key delivered, key resent on request, trial expiring (e.g. 7/3/1 days), trial expired, payment succeeded/failed, subscription renewing, key rotated, new device activated.

**Owner side (automation in the platform owner's admin console):**
- Rules and templates for every email above, editable without a deploy; per-plan content.
- Auto-issue, resend, rotate, suspend, revoke and extend keys; bulk actions; every action audited.
- Trial controls: length, module and data caps, one trial per email and per company domain, abuse flags.
- Trial-to-paid nudges, win-back for lapsed, and dunning on failed payments (ties to Phase 7).
- Delivery health: bounce/complaint tracking, resend queue, suppression list.
- Manual override for sales: grant a key or extension to a named tenant.

**Email infrastructure:** transactional provider with SPF, DKIM and DMARC on the sending domain; keys never travel in
URLs. [Likely] An Indian-region provider or self-hosted open-source MTA is needed for volume and residency. Provider choice goes in Phase 10.

**Self-hosted:** an Ed25519-signed licence file (tenant, seats, modules, expiry, grace) is delivered the same way and verified offline against an embedded public key. It deters casual piracy and does not stop a determined one.

## 11. Key decisions and trade-offs

| Decision | Chosen | Cost accepted |
|----------|--------|---------------|
| Database per tenant for all | Yes (your call) | Fleet ops: migrations, backups, pooling. Mitigated by orchestrator and connection manager. |
| Modular monolith | Yes | Needs discipline on module boundaries (lint rules, no cross-module table access) |
| Electron, online-only desktop | Yes | Poor-signal sites can't use it. Revisit with an offline-capable mobile/PWA in Wave 4. |
| Admin identity in control plane, staff identity in tenant DB; licence key gates features, password gates identity | Yes | Staff reset depends on the Admin being reachable. Sole-admin recovery needs a support procedure. |
| Typed SQL data layer, no ORM on hot paths | Yes | More hand-written SQL |

## 12. Open questions for Phase 4+

1. Which accounting depth: accounts-lite with Tally export, or full double-entry GL inside the app?
2. Do you need WhatsApp notifications at MVP (Meta Business API cost and approval time)?
3. Will you host for tenants' BYO-DB inside India only? (Phase 9/10)
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

## 14. Money movement, bank and Tally integration (decided in Phase 4)

- **Live bank transactions are OFF by default and never enabled by us.** A per-tenant setting `bank_live_enabled` (default false) can be turned on only by the tenant Admin through an explicit checkbox with a typed confirmation and an audit entry. A platform-level kill switch can disable it for everyone.
- **Until the whole app is built, tested, debugged and deployed**, the live-bank code path is not shipped enabled. Development and staging use a mock bank adapter only. No real credentials in non-production.
- **v1 without live banking:** bank statement import (CSV/Excel/OFX/MT940), auto-matching and reconciliation, payment advices, and bank-specific bulk payment upload files that the tenant uploads to their own bank portal.
- **Live adapters (optional, tenant-opt-in, later):** read-only statement feeds and payment initiation sit behind a `BankAdapter` interface. [Certain] India's bank APIs need commercial/onboarding agreements with each bank or an aggregator, so they cannot be free. The interface exists in v1, real adapters come when a tenant asks and the cost is agreed.
- **Tally** (decision: export first, link second):
  1. **Export** vouchers and masters as Tally-importable XML files. Works everywhere, offline, no coupling.
  2. **Link** to a running Tally Prime via its local XML-over-HTTP interface. [Certain] Tally listens on the tenant's own machine/LAN, so a cloud browser app cannot reach it. A small **open-source connector agent** (or the Electron app on that LAN) relays it. Tally itself is the tenant's own licensed product and is never bundled.
  3. **Accounts mode per tenant:** (a) native full double-entry GL, (b) native GL + Tally export, (c) Tally holds the books and our app pushes vouchers. In (c) the GL module is read-only reporting.

## 15. Licence compliance

See [licensing-policy.md](licensing-policy.md). Architectural effect: every paid or non-free external service (object store, email, payments, banks) is behind an adapter interface with a free default.
