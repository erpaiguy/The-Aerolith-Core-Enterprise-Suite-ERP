# Wave 1 Build Plan: Estimation + Bid/Tender + Documents

Scope: docs/01-mvp.md "Wave 1 scope" and docs/04-features.md E1-E11.

**Exit criterion:** a pilot contractor prices and submits a real tender on it. **Find the pilot now**, not at the
end. Their real BOQs and tender documents decide priorities better than this list.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Platform gaps that Wave 1 needs first

[Certain] Wave 0 delivered the platform core but not these Phase 4 items, which Wave 1 depends on. They are built inside
the Wave 1 steps that first need them, not as a separate wave:

| Item | Needed by | Built in step |
|------|-----------|---------------|
| P10 party master (clients, vendors, subcontractors) | Tenders, RFQs | 1 |
| P7 numbering series (per type, entity, financial year) | Tender numbers, later every document | 1 |
| P10 units, P9 import/export framework | BOQ import/export | 4 |
| P8 file storage (tenant's Supabase Storage, local folder in testing) | Tender documents | 10 |

**Storage scope:** documents live in the tenant's own Supabase Storage, so the OAuth app needs storage access.
Registering the app is still pending, so add the storage scope at registration; adding it later means every tenant
approves again (supabase-oauth-setup.md Part B).

## Steps

| # | Step | Features | Notes |
|---|------|----------|-------|
| 1 | **Tender register** | Clients (party master), tender numbering, tender register and pipeline, bid/no-bid scoring, status flow, deadline reminders, activity log | **Done** (see below) |
| 2 | BOQ engine (API) | `est` schema, partitioned lines, fractional sort keys, windowed reads with collapsed sections, ancestor total deltas, row-version conflicts | The benchmark design (05-database.md §4) made real |
| 3 | BOQ grid (UI) | Virtualised grid, keyboard editing, insert/indent/move/delete, collapse, search | **Done** (see below) |
| 4 | Import/export | Units master, Excel/CSV import with mapping, dry run and error report, `COPY` staging; Excel/CSV export | Library must pass the licence gate. [Certain] The app role cannot `ANALYZE` (Postgres skips it with a warning), so after a bulk load the import must analyze through the migration role or plans run blind until autovacuum |
| 5 | Rate library + rate analysis | Resources and rates with effective dates; analyses (resources × productivity + wastage + overheads + profit) feeding BOQ rates | E1, E2 |
| 6 | Measurement + pricing | Measurement sheets; markups, contingency, escalation, GST; scenarios; bid summary | E4, E5 |
| 7 | Revisions | Copy-on-write versions, compare two versions, lock on submission | E6. 1M-line copy must not take 64 s again |
| 8 | Tender management detail | Pre-bid queries, addenda, EMD/bank guarantees with expiry reminders, document checklist, submission, competitor bids, win/loss | E7 |
| 9 | RFQs | Enquiry packs to vendors, quotes, comparative statement, price into the estimate | E8 |
| 10 | Tender documents | Storage adapter, per-tender vault, folders, versions, tags, search, bulk upload/download, preview | E10, P8 |
| 11 | Tender programme | CPM engine (shared with Wave 2a), Gantt canvas, calendars, PDF, MSPDI/XER import-export | E9. Second-hardest UI |
| 12 | Reports + dashboard | Cost summary, priced/unpriced BOQ, rate analysis, bid pipeline dashboard; PDF/Excel | E11, 08-dashboard.md §2.3-2.4 |

Each step ships with API tests and a browser test of the main journey, like Wave 0.

## Step 1 decisions (made while building; change any you disagree with)

- **Status flow:** a tender moves through statuses only in these directions:
  - `lead` → `evaluating` → `bidding` → `submitted` → `won` / `lost`
  - Side exits: `no_bid`, `withdrawn`, `cancelled`.
  - Moving to `bidding` (or `no_bid`) happens **only by recording a bid/no-bid decision**, so every bid has a scored reason.
  - `no_bid` can be reopened to `evaluating`; the other end states are final.
- **Bid/no-bid scoring:** eight weighted criteria scored 1-5, giving a 0-100 score. The criteria are:
  - strategic fit
  - client payment record
  - technical capability
  - resource availability
  - competition
  - margin potential
  - contract risk
  - location
  
  The score advises; the person decides. The criteria are stored with each decision, so changing the defaults later
  doesn't rewrite history.
- **Numbers:** `TND/2026-27/0001`, per entity and Indian financial year (April-March). The number is allotted in the same
  transaction as the tender, so a failed save leaves no gap.
- **Reminders:** submission due 3 days and 1 day before, and pre-bid meeting 1 day before, go to the tender's owner
  (estimator) while the tender is open. They are rescheduled when dates change.
- **Who can change what:** admins and managers create and edit tenders and record decisions. Workers can view.

## Step 1 delivered

- **Database:** tenant migration `0003_tender_register.sql`.
  - New tables: `platform.party`, `platform.numbering_series`, and in the `tender` schema `tender`, `bid_decision` and `tender_event`.
  - New column `platform.notification.source`.
  - The app role cannot delete tenders or parties. Decisions and events are append-only, enforced by revoked privileges.
- **Existing tenant databases** get it from the owner console's **Migrations → Start rollout**. New tenants get it at provisioning.
- **API** (under `/api/tenant`). All writes need admin or manager and an active licence.

  | Method | Path | Notes |
  |--------|------|-------|
  | GET/POST | `/parties`, `/parties/:id` | `?q=` and `?kind=client\|vendor\|subcontractor`. GSTIN/PAN are validated. Updates need `rowVersion`; a stale one gets 409 `stale_row` |
  | GET | `/people` | Active users for "owner" pickers |
  | GET | `/tenders` | `?status=open\|closed\|<status>&q=&mine=true`. Returns the items plus counts per status |
  | GET/POST | `/tenders/:id` | Detail with decisions, activity, allowed moves. Updates need `rowVersion` |
  | POST | `/tenders` | Creates with the next `TND/<FY>/nnnn` number |
  | POST | `/tenders/:id/status` | `{to, reason}`. Lost, withdrawn and cancelled need a reason |
  | POST | `/tenders/:id/decision` | `{criteria:[{key, weight, score}], decision, reason}`. Moves the tender to bidding or no-bid |

- **Screens:**
  - **Tenders:** status filters with counts, search, due countdown.
  - **New tender:** add a client inline.
  - **Tender page:** status buttons, bid/no-bid scorer with a live score, details, activity.
  - **Clients and vendors.**
  - Deadline reminders appear on **Home**.
- **Tests:**
  - `apps/api/test/tender-rules.spec.ts`, `apps/api/test/tender.int.spec.ts`
  - `apps/web/src/lib/format.test.ts`
  - `tests/e2e/tests/tenders.spec.ts` (lead → scored bid → submitted → lost)

**Known gaps (later steps):**
- The tenant admin's display name is their email address.
- There is no way to edit the bid/no-bid criteria per company yet.
- There is no tender dashboard yet (step 12).

## Step 2 delivered: BOQ engine (API)

- **Database:** tenant migration `0004_boq.sql` adds `est.boq` and `est.boq_node` / `est.boq_node_text`. Both node tables are
  hash-partitioned 16 ways by BOQ and both have RLS.
- **[Certain] No `ltree`:**
  - A line's ancestors are read from its sort key: each key is its parent's key + `!` + its own segment.
  - So the tenant's Supabase project needs no extension, which our least-privilege migration role could not create anyway.
  - The sort-key code moved from the benchmark into `@aerolith/shared`, so the API and the benchmark share one implementation.
- **Totals:**
  - Every edit adds its amount change to each ancestor section's stored subtotal and to the BOQ total, in the same transaction.
  - Nothing is summed on read.
  - Amount = `round(qty × rate, 2)`, half away from zero.
- **Edits are batches:**
  - Up to 500 operations: insert, update, delete subtree, move subtree.
  - Atomic, and serialised per BOQ, which also rules out deadlocks.
  - A batch can refer to lines it inserted earlier through `tempId`s, so pasting a section with its children is one request.
  - A stale `rowVersion` returns 409 `stale_row` with the failing `opIndex`, and nothing in the batch is applied.
- **Who can edit:** set per role by the tenant admin (owner decision; see "Owner decisions after step 3" below).

| Method | Path (under `/api/tenant`) | Notes |
|--------|----------------------------|-------|
| GET/POST | `/tenders/:id/boqs` | List or create the BOQs of a tender |
| GET/POST | `/boqs/:id` | Header (totals, counts); rename/notes with `rowVersion` |
| GET | `/boqs/:id/rows` | Window: `after=<key>` or `before=<key>` or `end=true`, `limit` ≤ 500, `collapsed=<section ids>`. Returns `{rows, hasMore}` |
| GET | `/boqs/:id/outline?maxDepth=1` | Sections only, for the navigation panel |
| GET | `/boqs/:id/search?q=` | Code or description contains `q`, tree order, paged by `after` |
| POST | `/boqs/:id/changes` | `{ops: [...]}`. Returns fresh touched rows (the line and its ancestors), deleted ids, `idMap` (tempId → id), header, and `reload` when the change was structural |

- **[Certain] Measured** through the real HTTP API on a **1,002,200-line BOQ**. Local Postgres, 4 vCPU, p95:

  | Operation | Target (03 §13) | p95 |
  |-----------|-----------------|-----|
  | Open first window (200 rows) | < 1.5 s | 9 ms |
  | Scroll a window | < 100 ms | 6 ms |
  | Jump to the end | | 4 ms |
  | Window with 60 sections collapsed | | 18 ms |
  | Edit a quantity, all ancestor totals and the BOQ total updated | < 300 ms | 36 ms |
  | Insert a line between two others | | 11 ms |
  | Outline (2,200 sections) | | 35 ms |
  | Search a common word / a word on 1% of lines | < 500 ms | 9 ms / 74 ms |
  | **Search a term that is rare or absent** | < 500 ms | **1.2-1.8 s** |

  **How search works:** it tries a stop-at-first-page plan for 300 ms, then falls back to filtering all text.
  Both plans return identical results; a test forces the fallback to check this.

  **Open decision: the slow rare-term search.** The real fix is a trigram index (`pg_trgm`). It costs about 22% extra
  storage: ~170 MB per million lines on a ~500 MB free Supabase project. A typical 20k-50k-line BOQ scans ~1/20th as
  much, so it is fine without the index. Options are to add the index for every tenant, only on paid tiers, or never.
  `BoqService.searchFallbacks` counts how often the slow path runs.

  **Still unproven: real Supabase.** These numbers are from local Postgres. They must be re-measured on a real free
  Supabase project (network round trips, shared CPU) before relying on them there.
- **Tests (`apps/api/test/boq.int.spec.ts`):**
  - building a tree, totals, inserting between lines without renumbering, moves, deletes;
  - rejected structures, conflicts with rollback, roles, and locked BOQs;
  - windows forward, backward and with collapsed sections over 3,040 lines, plus search and outline;
  - the search fallback returning the same results as the fast plan;
  - a randomised run of 60 batches of mixed edits that checks every stored invariant after each batch.

## Step 3 delivered: BOQ grid

**Where:** Tender page → **BOQs** card → open or create a BOQ (`/boqs/:id`). Code: `apps/web/src/boq/` and
`apps/web/src/screens/Boq.tsx`.

**[Certain] How a 1M-line BOQ is shown:**
- The grid holds a contiguous slice of at most 2,400 lines and renders only the ~30 on screen.
- Scrolling near either end reads the next window and drops the far end, keeping the lines on screen still.
- Large BOQs are navigated with the **outline** (sections), **search**, and **Ctrl+Home/End**.
- A browser test scrolls a 3,000-line BOQ down and back up through the trim point, and checks that every rendered
  line is in order with no gaps.

**Not built: dragging the scrollbar to an arbitrary line of a 1M-line BOQ.**
- That needs row positions, which cost a full count or break on every insert.
- The scrollbar covers the loaded slice; the outline covers the whole BOQ.
- Revisit if the pilot finds this limiting.

**Deviation from 03 §13:** the grid uses DOM virtualisation, not a canvas grid.
- About 30 rows are rendered at a time, which is fast enough.
- It keeps native text, focus, screen-reader roles (`treegrid`, `aria-level`, `aria-expanded`) and copy/paste.
- Canvas stays an option for the Gantt (step 11).

**Editing:**

| Action | How |
|--------|-----|
| Move | Arrows, Tab / Shift+Tab, PageUp/Down, Ctrl+Home/End |
| Edit | Type, Enter or F2; Enter saves and moves down, Tab saves and moves right, Esc cancels. Double-click works too |
| Numbers | `1,250.5` and formulas like `=12*3.5+(2/4)` are accepted; only the result is stored. Bad input is explained and not saved |
| Add | Ctrl+Enter item, Ctrl+Shift+Enter section, toolbar for notes. A new line goes inside an open section, otherwise below the current line |
| Structure | Alt+Shift+→ indent into the section above, ← outdent, ↑/↓ move. The server resolves these, so far-away siblings need not be loaded |
| Delete | Ctrl+Delete or toolbar, with a confirmation that says when a whole section goes |
| Undo | Ctrl+Z undoes cell edits and newly added lines. Moves are reversed with the opposite shortcut; deletes are confirmed instead |
| Fold | Click the arrow or press Space on a section; Collapse/Expand all. Folded sections are remembered per BOQ on this device |
| Paste | Rows copied from Excel/Sheets are added below the current line. Columns map from the current column onward (code, description, unit, qty, rate). Up to 5,000 lines; larger files go through import (step 4) |

**Display:**
- The Amount column stays pinned on the right when the grid scrolls sideways on laptop screens.
- The outline panel can be hidden; it is hidden by default below 1280 px.

**Saving:**
- Each change is saved in order as soon as it is made.
- The BOQ total and section subtotals shown always come from the server after the save.
- If a save fails (for example someone else changed the line), the message is shown and the grid re-reads the lines on screen.

**API additions:**
- `rows?from=<key>` opens a window *at* a line.
- The `shift` operation (`up` / `down` / `in` / `out`) for relative moves.
- Opening at a folded section now shows the section itself. A browser test found this bug; an API test now covers it.

**Tests:**
- `apps/web/src/boq/model.test.ts`: number entry, formulas, formatting, window merge and trim, paste parsing.
- `tests/e2e/tests/boq.spec.ts`:
  - typing sections and items, a formula, a rejected value, undo, and a 300-line paste;
  - jumping to the end, folding, a search jump, outdent, and a reload;
  - the 3,000-line scroll test.
- The API's randomised invariant run now includes shifts.

## Owner decisions after step 3

### 1. Trigram search index for every tenant

- **Migration:** `0006_boq_search_index.sql` creates `pg_trgm` and `btree_gin`.
  - [Certain] Both are *trusted* extensions, so the least-privilege migration role can install them. Tests do exactly that.
  - A project that already has them is reused.
  - Indexes are `(boq_id, description)` and `(boq_id, code)`.
- **Storage:** a database with one 1,002,200-line BOQ now measures **584 MB**. [Likely] A ~500 MB free Supabase
  project therefore holds roughly 800k lines in total.
- **[Certain] Search has two strategies, and the first must not depend on the query planner.**
  - Tenant tables have row-level security. Postgres then refuses to use column statistics to estimate `LIKE`
    (estimates could leak data), so it guesses ~0.5% matches for every term.
  - With real statistics this produced 13 s for a common word.
  - So the tree-order strategy walks the BOQ in 4,000-line chunks, each with one obvious plan, for up to 150 ms.
  - After that, the trigram index filters the rest.
- **Measured** through the HTTP API as the app role, 1,002,200 lines, real statistics:

  | Search | Before the index | Now |
  |--------|------------------|-----|
  | Common word | 9 ms | 34 ms |
  | Word on 1% of lines | 74 ms | 169 ms |
  | Rare code near the end | 1,822 ms | 190 ms |
  | No match | 3,774 ms | 180 ms |

- **Lesson:** the step 2 numbers were taken without table statistics. Measurements from now on gather statistics first,
  as the import does.

### 2. Who may edit: configured by the admin per role

- **Where:** a **"What each role can do"** panel on the Users page. Admins always have every permission.
- **Permissions so far:**
  - `tender.edit`: tenders, clients, status, bid decisions.
  - `boq.edit`: create BOQs and edit lines.
- **Defaults (today's behaviour):** managers yes, workers no. Only the admin's changes are stored
  (`platform.role_permission`), so permissions added later get their defaults without a data migration.
- **[Certain] Enforcement:** the server checks every write.
  - The check is cached per tenant for 30 s and dropped immediately when the admin changes something.
  - Each change is written to the tenant's audit log.
- **API:**
  - `GET /api/tenant/permissions/mine`: what I may do.
  - `GET/POST /api/tenant/permissions`: admin only.
