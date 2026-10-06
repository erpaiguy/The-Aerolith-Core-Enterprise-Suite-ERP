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
 Desktop (Tauri)─▶ API Gateway ─▶ Tenant Resolver ─▶ Connection Manager (LRU pools + PgBouncer)
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
`users` (global identity), `memberships` (user ↔ tenant ↔ role), `plans`, `entitlements`, `subscriptions`,
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

## 6. Multi-user model

- **Identity** is global (one email can belong to several tenants, which matters for consultants and auditors).
- **Membership** gives a role in a tenant: Owner, Admin, Project Manager, Engineer, Accounts, Store, Viewer, plus custom roles.
- **Permissions** are `module.resource.action` (e.g. `procurement.po.approve`) with optional **project scope** (a site engineer sees only assigned projects).
- **Single-user** tenants are just a tenant with one Owner membership. No separate code path.
- Seat limits enforced from entitlements.

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

Same SPA bundle. Tauri shell adds: native file access (drawings, bulk upload), print/PDF, auto-update, deep links,
OS keychain for refresh tokens. All business logic stays on the server, so there is no divergence.

## 10. Licensing and trial

- Website signup creates a tenant in `trial` (14-30 days, module and data caps). The download or browser app both log in to that tenant.
- Entitlements are checked server-side on every request (cached for seconds).
- Self-hosted: Ed25519-signed licence file (tenant, seats, modules, expiry, grace period). The server verifies it offline with an embedded public key. It is a deterrent against casual piracy, not a guarantee.

## 11. Key decisions and trade-offs

| Decision | Chosen | Cost accepted |
|----------|--------|---------------|
| Database per tenant for all | Yes (your call) | Fleet ops: migrations, backups, pooling. Mitigated by orchestrator and connection manager. |
| Modular monolith | Yes | Needs discipline on module boundaries (lint rules, no cross-module table access) |
| Online-only desktop | Yes | Poor-signal sites can't use it. Revisit with an offline-capable mobile/PWA in Wave 4. |
| Global identity with memberships | Yes | Control-plane auth is a critical single dependency, so it needs HA |

## 12. Open questions for Phase 4+

1. Which accounting depth: accounts-lite with Tally export, or full double-entry GL inside the app?
2. Do you need WhatsApp notifications at MVP (Meta Business API cost and approval time)?
3. Will you host for tenants' BYO-DB inside India only?
4. Who is the pilot customer, and which of their workflows is the acceptance test?
