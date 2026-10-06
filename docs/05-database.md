# Phase 5: Database (draft v0)

Two kinds of database, never mixed:

| | Control plane | Tenant database |
|---|---|---|
| Count | One (ours) | **One Supabase project per tenant** (owner decision), or the tenant's own Postgres |
| Holds | Tenants, licences, seats, trials, purchases, downloads, releases, owner notices | Everything the tenant does inside the app: users, BOQs, tenders, schedules, documents, accounts |
| Exposed via Supabase Data API | **No.** Tables live in schema `core`, which is not exposed | **No.** Module schemas are not exposed; Supabase Auth/REST are unused for tenant data |
| Retention | 3-5 years (owner decision) | Tenant's own project. We keep none of it |

## 1. Conventions (all databases)

| Topic | Rule |
|-------|------|
| Naming | `snake_case`, singular table names, one schema per module (`platform`, `est`, `tender`, `doc`, `sched`, `proj`, `proc`, `inv`, `fin`, ...) |
| Primary keys | **UUIDv7** (time-ordered, generated in the app) for entities. **`bigint` identity** for high-volume line tables (BOQ nodes, activities, journal lines): half the index size of UUIDs |
| Cross-version identity | High-volume lines also carry a stable `line_key uuid` so the same line can be matched across revisions |
| Money and quantities | `numeric`, never float. Amounts `numeric(20,2)`, rates `numeric(20,4)`, quantities `numeric(20,4)`. Rounding rules live in one shared function. **Replaces the "integer paise" rule in 03 §7**, because rates and quantities need more than two decimals |
| Time | `timestamptz` stored in UTC; business dates as `date`; financial year Apr-Mar derived from entity settings |
| Standard columns | `id, created_at, created_by, updated_at, updated_by, row_version` (optimistic concurrency) |
| Deletion | Masters: soft delete (`deleted_at`). Transactions: never deleted, only **cancelled or reversed** |
| Enumerations | `text` with a `CHECK` constraint or a lookup table. No Postgres `ENUM` (painful to migrate across many tenant databases) |
| Foreign keys | Always declared, always indexed |
| Custom fields | `custom jsonb` column on entities that allow them, with tenant-defined field definitions in `platform.custom_field_def` |
| Multi-entity | Business rows carry `entity_id` (legal entity/branch inside one tenant) |

## 2. Control plane schema (`core`, on our Supabase)

| Table | Purpose / key columns |
|-------|----------------------|
| `owner_account` | Tenant admin identity: email, password hash (or Supabase Auth user id), status, verified_at |
| `tenant` | Company name, GSTIN (optional), status (trial/active/suspended/closed), region |
| `tenant_db` | `supabase_project_ref`, owning org (ours or tenant's), region, **encrypted connection secret reference**, status (provisioning/ready/paused/full/unreachable), `schema_version`, `last_seen_at` |
| `tier` | Name, seat cap, modules, price (Phase 6). Trial tier = 3 named seats |
| `licence` | Tenant, tier, **key HMAC** (lookup), last 4 characters for display, seats, status, `trial_ends_at`, `issued_at` |
| `licence_event` | **Append-only:** issued, emailed, resent, activated, rotated, revoked, extended, shortened (with old/new dates, reason, actor) |
| `device_activation` | Licence, device fingerprint hash, platform, first/last seen, revoked_at |
| `trial_change` | Owner extends/shortens a trial: new end date, notice sent (email + in-app) timestamps |
| `owner_notice` | Owner-to-tenant broadcasts (trial changes, updates, maintenance), delivery state per tenant |
| `app_release` | Version, channel, platform, GitHub release URL, mandatory flag, notes |
| `download_event` | **Append-only:** email, chosen seats, trial/paid, platform, version, timestamp |
| `subscription`, `payment_event`, `invoice` | Phase 7. `payment_event` stores raw verified webhooks, append-only |
| `email_outbox` | Queued emails with template, status, provider message id, bounces |
| `migration_run`, `migration_run_tenant` | Orchestrator rollouts and per-tenant results |
| `owner_audit` | Every owner-console action |

## 3. Tenant database: platform schema (`platform`)

`entity`, `setting`, `user` (username unique, password hash, role, status, `must_change_password`), `role`,
`role_permission`, `user_project_scope`, `session`, `password_reset_request` (from staff, actioned by admin),
`approval_rule`, `approval_request`, `approval_step`, `notification`, `reminder`, `numbering_series`,
`custom_field_def`, `import_job`, `export_job`, `attachment_link`, `schema_migration`, `audit_log` (partitioned by month).

**Audit mechanism:** a generic trigger writes changed columns to `platform.audit_log`, reading the acting user from
`set_config('app.user_id', ..., true)`. The `true` (transaction-local) is mandatory because tenant connections go through a
transaction-mode pooler, where session-level settings leak between requests.

## 4. Estimation and BOQ (the 1M-line design)

```
est.boq            (id uuid, tender_id, name, version_no, status: draft/locked/submitted, currency, totals)
est.boq_node       (id bigint, boq_id, line_key uuid, parent_id, path ltree, sort_key text, depth,
                    node_type: section/item/note, code, unit_id, qty, rate, amount, subtotal,
                    rate_analysis_id, flags, row_version)      PARTITION BY HASH (boq_id), 16 partitions
est.boq_node_text  (node_id, description, spec, notes)         wide, cold text kept out of the hot row
est.measurement    (id, node_id, seq, description, nos, length, breadth, height, qty)
est.resource, est.resource_rate (effective_from/to), est.rate_analysis, est.rate_analysis_line
est.markup         (boq_id, kind, basis, percent/amount)
```

How it meets the targets in 03 §13:

| Need | Mechanism |
|------|-----------|
| Show rows N..N+200 in tree order | `sort_key` is a hierarchical fractional key, so `ORDER BY sort_key` is depth-first order. Keyset paging on index `(boq_id, sort_key)` |
| Collapsed sections | Server excludes descendants with `NOT (path <@ ANY(:collapsed))` using a GiST index on `path` |
| Insert a row between two rows | New fractional key between neighbours. **No renumbering of 1M rows** |
| Section totals | Stored `subtotal` on section nodes. An edit applies the **delta to its ancestors only** (depth ~5-8 rows) in the same transaction |
| Search descriptions | `pg_trgm` GIN index on `boq_node_text.description` |
| Bulk import | `COPY` into an unlogged staging table, validate, then one `INSERT ... SELECT` |
| Revision | New `boq` version copies nodes with one `INSERT ... SELECT` (same `line_key`). Compare = join on `line_key` |
| Concurrent editing | `row_version` check per row; conflicts returned to the user |

## 5. Tender (`tender`)

`tender`, `bid_decision` (scores), `tender_event` (calendar), `query`, `addendum`, `security_instrument` (EMD/BG: amount,
bank, expiry, return status), `checklist_item`, `submission`, `competitor_bid`, `rfq`, `rfq_vendor`, `rfq_quote`,
`rfq_quote_line`, `comparative_statement`.

## 6. Scheduling (`sched`), shared by the tender programme and projects

```
sched.plan         (id, kind: tender_programme/micro/macro, tender_id NULL, project_id NULL, data_date, calendar_id)
                    CHECK: tender_programme => tender_id set AND project_id NULL   (enforces "no link to live projects")
sched.activity     (id bigint, plan_id, line_key, wbs_path ltree, sort_key, code, name, duration, calendar_id,
                    constraint_type/date, early/late start/finish, total/free float, percent, actual dates)
                    PARTITION BY HASH (plan_id)
sched.relation     (pred_id, succ_id, type FS/SS/FF/SF, lag)
sched.calendar, sched.calendar_exception, sched.baseline, sched.baseline_activity, sched.resource, sched.assignment
```

CPM runs in a worker that loads activities and relations for one plan, computes, and writes dates back in one batched
`UPDATE ... FROM (VALUES ...)`. Macro plans roll up micro plans through `wbs_path`.

## 7. Documents (`doc`)

`folder` (ltree path), `document`, `document_version` (storage key, SHA-256, size, mime, uploaded_by), `document_acl`, `tag`.
**File bytes live in the tenant's own Supabase Storage bucket** (same project, private bucket, access only via short-lived
signed URLs issued by our server). [Likely] The free tier's storage allowance is about 1 GB, and tender drawings fill that
quickly. Heavy tenants move up a tier, which matches your "heavy load pays" rule.

## 8. Later waves (outline only, detailed when each wave starts)

- `proj`, `proc`, `inv`: projects, contract BOQ (copied from the won tender's priced BOQ), PR/PO/GRN, stock ledger (append-only movements, balances by snapshot).
- `fin`: chart of accounts, `journal`, `journal_line` with a **deferred constraint trigger enforcing debit = credit per journal**. Posted journals are immutable; corrections are reversals. GST/TDS detail tables, bank statement lines, Tally export batches.
- `hr`, `eqp`, `qa`, `hse`, `ctl`, `crm`: per Phase 4.

## 9. Supabase-specific rules for every tenant project

1. Created in region Mumbai at provisioning. Our module schemas are **not** in the Data API's exposed schemas, and `anon`/`authenticated` have no grants on them.
2. The app connects as a dedicated **least-privilege role** (no superuser, no `postgres` role at runtime). A separate migration role is used only by the orchestrator.
3. Connections go through Supabase's pooler in **transaction mode**: no session state, transaction-local settings only, prepared statements disabled or pool-aware in the driver.
4. RLS enabled on all tables with no policies for `anon`/`authenticated` (defence in depth if the API is ever exposed by mistake).
5. Provisioning script is idempotent: create project, wait ready, create roles, run migrations, create storage bucket, record in `core.tenant_db`.

## 10. Migrations

- Plain SQL files, ordered and checksummed, tracked in `platform.schema_migration` in every tenant project.
- Expand/contract: a release never breaks the previous app version's queries.
- Orchestrator (03 §5) runs per tenant with bounded concurrency, records results in `core.migration_run_tenant`, pauses the rollout when failures pass a threshold. Paused projects (free-tier inactivity) are retried when they resume.

## 11. Sizing reality check

[Guessing] One million BOQ nodes with indexes and description text is roughly 0.5-1 GB. [Likely] The free Supabase database size
is around 500 MB. **A tenant who actually uses the 1M-line capability will exceed the free tier.** This is consistent with
your rule that heavy-load tenants pay, but the app must warn before the limit (`tenant_db.status = full`) rather than fail
at it. The Wave 0 benchmark will replace these guesses with measured numbers.

## 12. Open questions

1. **Whose Supabase organisation owns each tenant project, ours or the tenant's?** (See the README and infra-existing-stack.md §5.)
2. Do any tenants need more than one legal entity in v1, or can `entity` stay single for now (keeping the column)?
