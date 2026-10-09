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
| 4 | **Import/export** | Units master, Excel/CSV import wizard with mapping, dry run and error report; Excel/CSV export | **Done** (see below) |
| 5 | **Rate library + rate analysis** | Resources and rates with effective dates; analyses (resources × productivity + wastage + overheads + profit) feeding BOQ rates | **Done** (see below) |
| 6 | **Measurement + pricing** | Measurement sheets; markups, contingency, escalation, GST; scenarios; bid summary | **Done** (see below) |
| 7 | **Revisions** | Copy-on-write versions, compare two versions, lock on submission | **Done** (see below) |
| 8 | Tender management detail | Pre-bid queries, addenda (with importing a revised BOQ into a revision, moved from step 7), EMD/bank guarantees with expiry reminders, document checklist, submission, competitor bids, win/loss | E7 |
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

## Step 4 delivered: import and export

**Journey:** on an empty draft BOQ, **Import** → drop an .xlsx or .csv → check the suggested sheet, header row, columns
and section structure against a preview → **Check file** (every row is read, nothing saved) → see counts, the total,
errors and warnings (all of them as a CSV report) → **Import N lines**. **Export** gives Excel (outline levels, bold
sections, frozen header) or CSV; anyone who can read the BOQ can export, even on a read-only licence.

**What the importer understands** (`apps/api/src/boq/import/builder.ts`, shared by the check and the import, so they
cannot disagree):
- Header row found among the first 30 rows (title rows above it are skipped); Indian headings such as "Sl. No.",
  "Particulars", "UOM", "Rate (₹)", "Amount in Rs.".
- Sections four ways: **item numbers** (1 / 1.1 / 1.1.1, with (a), (b), (iv) placed under the line above), **headings**
  (a row without unit, quantity and rate), a **Level** column (our own export), or **flat**.
- Numbers as written in India: "1,25,000.50", "₹ 350", "Rs. 42". [Certain] "1.200,5" (a European decimal comma) is an
  error, not silently 1.2005. More than 4 decimals are rounded, with a warning.
- Amounts are recomputed as round(qty × rate, 2), exactly as Postgres does (checked to the paisa); a file amount that
  differs by more than ₹1 is a warning.
- Units normalised through the **units master** (`platform.unit`, 18 seeded with aliases: Cu.M, m3 → cum). Unknown
  units are kept and listed. Admins and roles with `boq.edit` can add units (`POST /api/tenant/units`).
- Refused with a clear message: old binary **.xls** (save as .xlsx), PDF, other binaries, files over `IMPORT_MAX_MB`
  (100 MB, about two million lines).

**Decisions made while building (change any you disagree with):**
- **Import only into an empty BOQ.** Merging into an existing BOQ belongs with revisions (moved to step 8, with addenda).
- **Rows with errors block the import** until the user ticks "import without the rows that have errors".
- **[Certain] No `COPY` staging, unlike the plan.** Postgres refuses `COPY FROM` on tables with row-level security
  ("COPY FROM not supported with row-level security"), and every tenant table has it. The upload waits on the API
  server's disk instead (`IMPORT_DIR`, deleted after import or cancel, swept after 24 h), and lines go in as
  2,000-row `INSERT … SELECT FROM jsonb_to_recordset`. This also keeps a half-finished upload from doubling the
  tenant's database size.
- **One transaction per import:** it lands whole or not at all. Sort keys, ids, subtotals and child counts are worked
  out while streaming, so the stored totals meet the same invariants as hand edits (checked by the tests).
- **Edits are refused while an import runs** (`boq_importing`); the grid turns read-only and shows progress.
- **After the import, statistics are refreshed** with `ANALYZE` through the migration login (the app role cannot), best
  effort.
- **Interrupted jobs:** a job that stops reporting for 15 minutes (server restart) shows as failed; start again.
- [Likely] One API instance only: the upload lives on that instance's disk. A second instance needs a shared folder.
- [Certain] **Docker:** uploads sit in the API container's `/tmp`; recreating the container loses unfinished uploads
  (the user uploads again). Nothing else is lost.

**Measured** (sandbox Postgres 16, 993,100-line workbook of 52 MB, as the app role through the HTTP API):

| Stage | Time |
|-------|------|
| Upload | 0.3 s |
| Read the file (sheets, preview, suggestions) | 21 s |
| Check every row | 28 s |
| Import, including subtotals and `ANALYZE` | **162 s** (target < 5 min) |
| Afterwards: first window / end / outline / one edit | 7 / 4 / 63 / 33 ms |
| Afterwards: common / rare search | 35 / 190 ms |
| Export to Excel (63 MB) | 45 s |

The API process grew by about 30 MB during the import. [Guessing] Over the internet to a Supabase project in Mumbai,
the import will take longer (500 round trips); measure on the first pilot's project.

**Bug fixed on the way (grid, step 3):** quick consecutive edits of one line (type, Tab, type) could conflict with
themselves ("Someone else changed this record") when a save took a little longer, because the next save read the row
version before React re-rendered. Save responses now record versions immediately. Real internet latency would have
triggered it for every user.

**API:**
- `POST /api/tenant/boqs/:id/imports` (multipart, field `file`), `GET /api/tenant/boqs/:id/imports/latest`
- `GET /api/tenant/imports/:id`, `POST …/validate` (settings), `GET …/issues` (CSV), `POST …/start`, `POST …/cancel`
- `GET /api/tenant/boqs/:id/export?format=xlsx|csv`
- `GET/POST /api/tenant/units`

**Tests:** 12 builder unit tests; 15 API integration tests (Excel with cover sheet, formulas and sub-items; messy
semicolon CSV with multi-line cells and errors; Excel and CSV round trips; permissions; cancel; interrupted jobs; bad
files; units); a browser test that imports a CSV through the wizard, exports to Excel, and imports that into a second
BOQ with the same total.

## Step 5 delivered: rate library and rate analysis

**Journey:**
1. **Resources** (Pre-construction menu): the tenant's own materials, labour, equipment and subcontract rates. Every
   rate has a **from date**, so "the rate as on 1 April" is always answerable and old estimates stay repeatable.
2. **Import price book**: an Excel/CSV sheet with Code, Name (or Description) and Rate; Unit, Type and Effective from
   when present (Indian dates such as 01-04-2026 work). **Check** shows new, changed and unchanged rows and every
   problem; **Apply** saves them in one transaction. Importing the same sheet twice changes nothing.
3. **Rate analyses**: an item of work built from resource lines (quantity + wastage %), **sub-analyses** (mortar inside
   brickwork) and lump sums, for an output quantity (CPWD-style "for 10 cum"), then percentages applied in order on the
   running total (one click adds water charges 1 % + contractor's profit and overheads 15 %). The editor costs it
   **live, as on any date**, with the split per unit by material, labour, equipment, subcontract and overheads.
4. **In a BOQ**: select an item → **Rate from analysis** → pick. The item takes the analysis' rate (and its unit and
   description when empty) as on the BOQ's **rates-as-on date**. A small calculator icon marks such rates.
   **Refresh rates** re-prices every linked item after resource rates or the date change.

**Decisions made while building (change any you disagree with):**
- **BOQ rates are copied, not live.** A BOQ is a document; a cement price change must not silently move a submitted
  bid. Rates change only on "Rate from analysis" or "Refresh rates".
- **Typing a rate by hand unlinks the item** from its analysis, so a refresh never overwrites a deliberate rate.
- **Missing rates block, never price at zero.** An analysis whose resource has no rate on the date shows "no rate"
  and the BOQ refuses to take or refresh it (`missing_rates`, naming the resources).
- **Units must match.** An analysis per cum cannot price an item measured in sqm (`unit_mismatch`); "Cu.M" and "cum"
  are the same through the units master.
- **Exact arithmetic.** Costing uses integer-scaled decimals (no floating point); the BOQ gets the rate rounded to
  paise (half away from zero), the analysis shows 4 decimals. Checked by hand in the tests (PCC 1:4:8:
  ₹4,896.70 of lines → ₹5,687.52 per cum).
- **No cycles, nesting up to 10.** Saving (or previewing) an analysis that would end up inside itself is refused with
  the path (`MORTAR-16 → BW-16 → MORTAR-16`).
- **Masters are archived, never deleted** (the database refuses deletes to the app role); rate versions can be
  removed.
- **New permission `rates.edit`** (managers yes, workers no by default; the admin can change it on the Users page).
  Everyone can read rates; applying an analysis to a BOQ needs `boq.edit`.
- **No bundled schedules of rates** (CPWD DSR, state SORs): the tenant imports its own price book (licensing, and
  rates differ by region anyway).

**Measured** (sandbox, the 993,100-line BOQ from step 4, every item linked to one analysis):

| Action | Time |
|--------|------|
| Refresh rates, all 990,000 linked items change | **31.5 s** (one request; the BOQ is locked meanwhile) |
| Refresh rates, nothing changed | 0.9 s |
| Editing a line afterwards | 21 ms |

Every stored invariant (subtotals, child counts, BOQ total) held after the refresh. [Likely] 31 s is acceptable for a
rare, deliberate action, but a refresh during a working session makes other users' open rows stale (they reload).
[Guessing] Against Supabase over the internet it is still one set-based statement, so it should stay in the same range;
measure on the pilot's project.

**API:**
- `GET/POST /api/tenant/resources`, `GET/POST /api/tenant/resources/:id`, `POST …/rates`, `POST …/rates/delete`,
  `POST /api/tenant/resources/price-book?dryRun=true|false` (multipart)
- `GET/POST /api/tenant/rate-analyses`, `GET/POST /api/tenant/rate-analyses/:id?asOf=`, `POST …/copy`,
  `POST /api/tenant/rate-analyses/preview` (cost without saving)
- BOQ: `rateAnalysisId` on insert/update ops; `rateDate` on the BOQ header; `POST /api/tenant/boqs/:id/refresh-rates`

**Bug fixed on the way (tender register, step 1):** "due in N days" counted 24-hour periods rounded up, so a tender due
on the 19th at 3 pm showed "in 11 d" on the 9th before 3 pm. It now counts calendar days in the user's time zone (and
the trial banner says "ends today" on the last day). The browser test had only passed because CI ran after 3 pm.

**Tests:** 6 costing unit tests (hand-checked figures, nesting, missing rates, cycles, depth); 13 API integration tests
(dated rates, price-book check/apply/re-apply, analyses with sub-analyses, cycle refusal, preview, copy, BOQ apply,
unit mismatch, unlink, refresh with invariants, missing rates, permissions); a browser test of the whole journey.

## Step 6 delivered: measurement sheets and bid pricing

**Journey:**
1. **Measurement sheet** (ruler button in the BOQ grid, or double-click a measured quantity): rows of description,
   nos × length × breadth × height, blank dimensions skipped, **Deduct** for openings; formulas such as =1.5*2 work and
   rows paste straight from Excel. Saving makes the item's quantity the sheet total; amount and every subtotal follow.
2. **Pricing** (button on the BOQ, for roles allowed to see pricing): **scenarios** of markups on the BOQ total, each
   a % of the BOQ total, a % of the running total, or a fixed amount, in order: overheads, contingency, escalation,
   profit, discount, other. Then GST: **added** (18 % or 12 % for works contracts), **already in the rates**, or
   **exempt**. Live totals as you type; the first scenario becomes the bid; any other can be chosen instead.
3. **Against the estimate**: each scenario shows how far its value before GST is above or below the client's
   estimated value (the tender's figure), the number a tender committee looks at.
4. **Item-rate submission**: the bid's markups are spread over every item rate (rate × factor, rounded to paise) and
   exported to Excel with "Quoted rate" and "Quoted amount" columns. The screen says exactly how far the rounded
   rates land from the bid (usually a few paise).
5. **Bid summary** on the tender page: every BOQ priced by its chosen scenario, the total before GST, GST and bid
   value, against the estimate; BOQs without a scenario or with unpriced items are flagged.

**Decisions made while building (change any you disagree with):**
- **A measured quantity cannot be typed over** (`qty_from_measurements`); clearing the sheet keeps the last total and
  makes the quantity editable again. Rates, units and descriptions stay editable.
- **Markups apply to the whole BOQ**, not per section or per item: that is how Indian bids are built (overheads and
  profit on the estimate) and it keeps the BOQ itself the cost estimate. Per-section bid values are shown as shares.
- **The comparison with the estimate is before GST**, as tender committees compare it.
- **Every amount is rounded to paise at each step** (each markup, GST), with exact decimal arithmetic.
- **New permission `pricing.edit`**: margins are sensitive, so it covers *seeing* pricing as well as changing it
  (screens, summaries, quoted-rate export). Managers yes, workers no by default; the admin can change it.
- Measurement sheets are not in the BOQ export yet (the quantity is); [Likely] needed for the client's measurement
  book in Wave 2 billing, where it belongs.

**Measured** (sandbox, the 993,100-line BOQ from step 4):

| Action | Time |
|--------|------|
| Pricing summary (counts, sections, every scenario, quoted total over 990,000 items) | 0.4 s |
| Saving a measurement sheet | 66 ms |

Every stored invariant held afterwards. Rounding each of the 990,000 loaded rates to paise moved the quoted total by
₹5,692.96 (0.00004 % of that synthetic BOQ); the screen states this difference so nobody is surprised at submission.

**API:**
- `GET/POST /api/tenant/boqs/:id/lines/:lineId/measurements` (POST replaces the sheet, with the line's row version)
- `GET /api/tenant/boqs/:id/pricing`, `POST /api/tenant/boqs/:id/pricing/preview`, `POST /api/tenant/boqs/:id/scenarios`
- `POST /api/tenant/scenarios/:id` (update), `…/select`, `…/copy`, `…/delete`
- `GET /api/tenant/tenders/:id/bid-summary`
- `GET /api/tenant/boqs/:id/export?format=xlsx|csv&scenario=:id` (quoted rates)

**Tests:** 4 pricing and measurement unit tests (hand-worked: ₹10,00,000 with five markups → ₹12,16,190 before GST,
₹14,35,104.20 with GST, 5.76 % above an ₹11,50,000 estimate; 14.007 cum of brickwork less a door); 8 API integration
tests (measured quantities with totals and invariants, refusal of typed quantities, versions, permissions, cascade on
delete; scenarios, selection, copy, delete, preview, quoted-rate export to the paisa, tender summary); a browser test
of the whole journey.


## Step 7 delivered: revisions

**Journey:**
1. **Freeze** (button on a draft BOQ): **submitted to the client** or **internal review**, with a label such as "R0"
   and a note. The BOQ becomes read only: no edits, imports, rate-date changes or pricing-scenario changes. The total,
   line counts, rate date and the chosen pricing scenario with its bid figures are recorded with the version.
2. **Submitting the tender** (moving it to Submitted) freezes every draft BOQ of that tender as "Submitted with the
   tender", in the same transaction.
3. **Start revision N+1** (Versions screen): the BOQ becomes an editable draft again, as version N+1. Version N stays
   exactly as frozen.
4. **Compare** any two versions, including the draft being worked on: counts of added, removed and changed lines, the
   change in value, and the lines themselves (added / removed / changed, old and new quantity, rate, amount and
   description, and whether the line moved), 200 at a time.
5. **Export** any frozen version to Excel or CSV, exactly as it was frozen.
6. **Archive** a BOQ made by mistake (BOQs are never deleted): it becomes read only, is marked "archived" on the tender
   and is left out of the bid summary and of the freeze on submission. **Restore** brings it back.

**How it is stored (copy-on-write, docs/05-database.md §4):** freezing and starting a revision copy nothing. The first
time a line changes in revision V, its state as frozen in V-1 is kept once in `est.boq_node_hist` (its text only if
the text changes or the line is deleted). Version N is rebuilt from each line's earliest kept state frozen at N or
later, otherwise its current row. Compare reads only the lines kept since the older version plus the lines added since,
never the whole BOQ. History is append-only for the app's database role.

**Decisions made while building (change any you disagree with):**
- **Two kinds of freeze, one rule:** "submitted" and "internal review" both lock the BOQ; the kind only records why.
  Unlocking means starting a revision, never editing a frozen version.
- **Submitting a tender freezes its draft BOQs automatically**, so the version the client received can always be
  reproduced, even if nobody pressed Freeze.
- **Only the chosen pricing scenario is recorded with a version** (markups, GST and the bid result). Quoted-rate
  exports are for the current version only (`quoted_current_only`); the frozen bid figures are on the Versions screen.
- **Measurement sheets are not versioned:** an old version keeps its quantities, but its sheet rows are the current
  ones. [Likely] fine for bids; Wave 2 billing (measurement book) needs versioned sheets and will add them there.
- **Importing a revised BOQ into a revision is not built yet.** Step 4 said merging into an existing BOQ belongs with
  revisions; it moves to step 8 with addenda, because the matching rule (by item code, by description, or both) should
  be decided on a pilot contractor's real addendum files. A wrong rule makes every line show as removed and re-added.
- **Compare lists a line as changed only when something visible changed** (code, unit, quantity, rate, amount,
  description, notes, position): text edited and edited back is no change. The counts are exactly the lines listed.
  Section subtotals are not listed; the value change is over items.
- **Archiving, not deleting** (BOQs are documents): a BOQ with a version submitted to the client cannot be archived
  (`boq_submitted`), so what the client received stays on the tender. Archived BOQs refuse every change
  (`boq_archived`) until restored. This was promised for step 7 when step 2 ruled out deleting BOQs.

**Measured** (sandbox, the 993,100-line BOQ from step 4):

| Action | Time | Before (full copy / first design) |
|--------|------|-----------------------------------|
| Freeze version 1 | 14 ms | |
| Start revision 2 | 7 ms | 64 s and ~780 MB for a full copy (Wave 0 benchmark) |
| Edit a line in revision 2 (keeps its frozen state) | 19 ms | |
| Compare 1 → 2, one line changed | 12 ms | 1.4 s (first design) |
| Re-price all 990,000 items from analyses in revision 2 | 39 s, history +253 MB | 142 s (first design) |
| Compare 1 → 2, all 990,000 items changed | 42-45 s | 88 s (first design) |
| Export version 1 (CSV, rebuilt from history) | 39 s, 134 MB | |
| Export the current version (CSV) | 15 s, 132 MB | |

[Certain] The worst case is the last compare row: every line of a million-line BOQ changed. Each page or filter of
that comparison recomputes it, so it takes as long again. [Likely] a 50,000-line BOQ compares in about 2 s even when
every line changed; the usual case (a few hundred lines changed) is milliseconds at any size.

**API:**
- `GET /api/tenant/boqs/:id/versions`
- `POST /api/tenant/boqs/:id/freeze` (kind, label, note), `POST /api/tenant/boqs/:id/revise` (note)
- `GET /api/tenant/boqs/:id/compare?from=&to=&filter=all|added|removed|changed&limit=&offset=`
- `POST /api/tenant/boqs/:id/archive` (`{ archived: true | false }`)
- `GET /api/tenant/boqs/:id/export?format=xlsx|csv&version=N`

**Tests:** 6 API integration tests: freezing copies nothing and blocks edits, scenarios and the rate date; compare of
added, removed, changed and moved lines with the value delta in both directions and by filter; old versions export
byte for byte after later edits, with notes-only changes listed and text edited back not; **randomised** edits over
four revisions (inserts, quantity, rate, text and notes edits, moves, deletes) with every version re-exported byte for
byte, and every compare's counts, listed lines and value change agreeing with each other and with the totals;
submitting a tender freezes its BOQs; archiving (read only, out of the bid and of the freeze, refused for a submitted
BOQ, restore). A browser test of the whole journey, archiving included.
