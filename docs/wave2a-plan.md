# Wave 2a Build Plan: Projects + Scheduling

Scope: docs/04-features.md W2a (J1-J6). docs/01-mvp.md split Wave 2 in two; this is **2a**. 2b (procurement,
inventory, daily site reports) follows.

**Started without Wave 1's exit criterion met** (a pilot pricing and submitting a real tender). [Likely] Wave 2a starts
from Wave 1's data: a won tender's priced BOQ becomes the project's contract BOQ. Wave 1 choices a pilot would have
tested (revised-BOQ matching, provisional sums taking no markups, import speed over the internet) carry into it.
Keep looking for the pilot; their first won tender is Wave 2a's real test.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Decisions taken at the start (change any you disagree with)

- **[Certain] A project's BOQs are ordinary BOQs, owned by the project instead of a tender.** `est.boq` gets a
  `project_id` beside `tender_id`, exactly one of them set. The 1M-line grid, import/export, revisions, templates and
  bulk edit then work for projects unchanged. The alternative, a second BOQ engine for projects, would double the
  hardest code in the product. Tender-only features (bid pricing, RFQs into the estimate) stay tender-only.
- **[Likely] Two BOQs come from a won tender:** the **contract BOQ** at the *quoted* rates (what the client pays: the
  estimate with the bid's markups loaded, as exported in Wave 1 step 6) and the **budget** (cost BOQ) at the
  *estimate* rates (what it should cost us). Both from the BOQ version that was submitted. Budget minus contract is
  the planned margin. If you price differently (e.g. the contract at a negotiated discount), say so before step 2.
- **[Certain] The tender programme is not copied** (your Wave 1 decision, docs/04-features.md): a project's
  schedule starts from scratch or from an imported file.
- **[Likely] Projects are visible to their team only.** A user sees a project they are a member of; admins, and
  roles given the new "see every project" permission, see all. Project roles: **lead** (edits the project and its
  team), **member** (works on it), **viewer** (reads). This is P2's "project scope".
- **[Certain] The basic approval engine (P5) promised for Wave 0 does not exist.** 2a does not need it; 2b's
  requisitions and purchase orders do. It becomes 2b's first step, not an assumption.

## Steps

| # | Step | Features | Notes |
|---|------|----------|-------|
| 1 | **Projects** (J1) | `proj` schema; project register and numbering; client, legal entity, dates, contract value, status flow; sites (with state, for GST place of supply); team with project roles; project-scoped visibility; **create a project from a won tender** | **Done** (see below) |
| 2 | **Contract BOQ + budget** (J2) | BOQs owned by a project; from the won tender's submitted BOQ: contract BOQ at quoted rates, budget at estimate rates (a background copy for large BOQs); versions; budget against contract | **Done** (see below) |
| 3 | **WBS + cost codes** (J3) | WBS tree per project; company cost-code master; BOQ items mapped to WBS and cost codes (one by one and in bulk by range) | **Done** (see below) |
| 4 | **Project schedules** (J4) | The Wave 1 engine for project plans: constraints, resources and assignments, multiple baselines, progress updates (data date, actuals, remaining duration), look-ahead; 50k activities | **Done** (see below) |
| 5 | **Macro plans** (J5) | Roll-up of micro plans through the WBS, milestones, summary views by package, trade and zone | **Done** (see below) |
| 6 | **Progress measurement** (J6) | Physical % per BOQ item and activity, measurement-based progress, progress value against the contract BOQ | **Done** (see below) |
| 7 | **Project dashboard and reports** | Progress, schedule variance, budget against contract, look-ahead | **Done** (see below) |

Each step ships with API tests and a browser test of the main journey, as in Wave 1.

## Step 1 delivered: projects

**Journey:** a won tender's page offers **Make it a project**: the project takes the tender's title, client, location
and our bid value (as read out at the opening, else as submitted, else the estimate), numbered `PRJ/2026-27/0001`.
**Projects** in the menu lists them (live first; filters by status; "only projects I am on"; search). A project's page
shows its details, status buttons, **sites** (with their GST state code), **team** and activity. Projects can also be
started directly (**New project**) for work that did not come through a tender here.

**Who sees and changes what:**
- A project is visible to its **team**. Admins, and roles with the new **See every project** permission (managers by
  default), see all. To everyone else a project they are not on does not exist; a won tender's page says only that
  it became project PRJ/..., without a link.
- The project's **lead**, admins, and roles with **Create and edit projects** (managers by default) change its
  details, status, sites and team. Members and viewers read it (members will work in it from step 2 on).
- Whoever makes a project leads it; a tender's estimator joins as a member. **A project always keeps a lead**: the
  last lead cannot be removed or demoted until someone else leads.

**Status:** planned → active → completed → closed, with on hold (from planned or active, back to active) and
cancelled (from planned, active or on hold; back to planned). On hold and cancelled ask for a reason, shown on the
page. Completing records today as the finish date, and is refused while the start date is still in the future.

**Decisions made while building (change any you disagree with):**
- **[Likely] Our bid value is the contract value** until someone edits it. Negotiated reductions after the opening
  are common; edit the project's contract value, and step 2 will price the contract BOQ to match.
- **[Certain] One project per tender**, enforced by the database. A tender won in packages would need several;
  start the others directly.
- **Sites carry only a GST state code**, not a full address model: Wave 3's invoicing decides place of supply from
  it. Sites are marked finished rather than deleted.

**API** (under `/api/tenant`): `GET /projects?status=&q=&mine=`, `POST /projects`, `GET /projects/:id`,
`POST /projects/:id` (details), `POST /projects/:id/status`, `POST /projects/:id/sites`, `POST /sites/:id`,
`POST /projects/:id/team` (`{userId, role}`, `null` removes), `GET /tenders/:id/project`,
`POST /tenders/:id/project`. Permissions `projects.edit`, `projects.all`. Migration `0022_projects.sql`.

**Tests:** 5 API integration tests (only a won tender, once, at our bid value and in the numbering series; a worker
sees only projects they are on and only leads and editors change them; a lead always remains; status moves, reasons
and the finish date; sites unique by name with their state code; the activity log append-only). A browser test wins
a tender, makes it a project, adds a site and a teammate, starts it and puts it on hold.

## Step 2 delivered: contract BOQ and budget

**Journey:** a project made from a won tender shows **Contract BOQ and budget**: each live BOQ of the tender, the
version that will be copied (the last one submitted), its total at the quoted rates and at the estimate rates, and
the project's contract value. **Make the contract BOQ and budget** turns each tender BOQ into two BOQs of the project:
- **Civil (contract)**: the quoted rates, i.e. the estimate rate × the bid's markup factor, rounded to paise as
  exported for an item-rate submission (Wave 1 step 6). Provisional sums are copied unchanged; rate-only items and
  alternates get quoted rates but no amount, as before.
- **Civil (budget)**: the estimate rates, i.e. what the work should cost us.

If the contract value is below the quoted total (the price was negotiated down), a tick box prices the contract BOQ
to it: every quoted rate except provisional sums is multiplied by the same factor (e.g. 96.00%), and the few rupees
that rounding leaves are recorded. The project page then lists its **BOQs** and sets the **budget against the contract**:
totals, planned margin and its percentage, and each top-level section side by side. The BOQs are ordinary BOQs. The
grid, import (including a revised BOQ), export, versions, bulk edit and reports work on them. Their page leads back
to the project, and bid pricing is not offered. A team can also add an empty contract BOQ or budget (**New BOQ**)
for work that came without a tender or for later packages.

**Who sees and changes what:**
- A project's BOQs are visible to the project's team only (and to admins and roles that see every project), on every
  BOQ route: lines, search, export, reports, versions, import jobs. Everyone else gets "not found". A tender's BOQs
  stay visible to everyone signed in, as in Wave 1.
- Changing them needs **Create BOQs and edit their lines** *and* a place on the team as lead or member (or the right
  to edit projects). Viewers read. Making the copies from the tender needs the lead (or someone who edits projects).

**Decisions made while building (change any you disagree with):**
- **[Certain] One copy per project.** Made once; later changes are revisions of the project's BOQs. The tender's BOQ
  is never changed, and its later drafts do not reach the project.
- **[Likely] A tender BOQ never frozen as submitted is copied as it is now**, at its selected scenario's factor, and
  the project marks it "never submitted". Refusing would block a team that skipped freezing.
- **[Certain] The contract value is compared before GST.** The submission form suggests the bid *with* GST, so a
  contract value taken from it is above the quoted total. Rates are then not scaled up: the page asks whether the
  value includes GST, and the contract BOQ stays at the quoted rates until the value is corrected. Scaling is refused
  below half of the quoted total too (a typo, not a negotiation).
- **[Likely] Lines keep their identity:** a contract line, its budget line and the tender line share one line key, so
  later steps (progress, cost codes) and the margin by section can pair them even after renumbering.
- **[Likely] The planned margin is visible to the project's team**, although bid markups are behind **See and change
  bid pricing** for tenders: managing a project needs its budget. Say if only some roles should see it.
- **Measurement sheets, rate analyses and foreign-currency rates are not copied:** quantities and rates come across
  as values. The tender keeps the working.
- **The copy runs in the background, in one transaction:** all of it or none. A 200,000-line BOQ took 42 s here
  for both copies (the search indexes are most of it, as for imports); a million lines will take about four minutes.
  A copy cut short by a server restart is shown as failed and can be started again.

**API** (under `/api/tenant`): `GET /projects/:id/boqs`, `POST /projects/:id/boqs` (`{name, kind}`),
`GET /projects/:id/boqs/from-tender` (what the copy gives, and how the last one went),
`POST /projects/:id/boqs/from-tender` (`{matchContractValue}`), `GET /projects/:id/boq-summary`. A BOQ's header now
carries `projectId`, `kind` (`estimate`, `contract`, `budget`) and `project`. Migration `0023_project_boqs.sql`.

**Tests:** 6 API integration tests:
- the preview, and the submitted version used rather than the later draft;
- quoted rates scaled to a negotiated value, with provisional sums and rate-only items handled, the budget at
  estimate rates, line keys shared, and the copy made once only;
- the margin by section, and an empty BOQ added;
- the team-only visibility and edit rules on BOQ routes, bid pricing refused, the project's log and the report and
  export;
- a project without a tender refused;
- a copy that died with its server shown as failed.

A browser test prices, submits and wins a tender, negotiates the contract value down, makes the contract BOQ and
budget, checks the margin, and opens the contract BOQ.

## Step 3 delivered: WBS and cost codes

**Journey:**
- **Cost codes** (new in the menu) are the company's codes for costs: groups and codes, each of a kind (material,
  labour, plant and equipment, subcontract, overhead, other). **Load the standard list** gives 23 to start from
  (materials, labour, plant, subcontracts and site overheads, with the usual codes under each). Codes are added,
  renamed, moved under another group, and **retired** rather than deleted.
- A project's **WBS and cost codes** page (from the project's page) shows the WBS tree. **Make the WBS** from a BOQ
  (normally the contract BOQ): each section down to the levels chosen becomes an element, numbered 1, 1.1, 1.2…,
  and every item is mapped to the element of its section. Elements can then be added, renamed, re-coded, moved under
  another element, reordered, and removed if nothing is under them.
- In a project's BOQ, the grid shows each item's **WBS** and **Cost code**. **Map** maps the selected lines
  (Shift+click; a section brings everything under it), or the line in hand, to a WBS element and/or a cost code. Each
  side can be left as it is, set or cleared. Mapping works on frozen versions too: it describes the line and is not
  part of the BOQ's content.
- The WBS page breaks the **contract and budget down** by WBS element (each with everything under it: contract,
  budget, margin, items) and by cost code (groups with their codes), with what is still **not mapped**. The project
  page sums up how much of the contract is mapped.

**Who does what:**
- Everyone signed in reads the cost codes; the new permission **Edit the company's cost codes** (managers by
  default) changes them.
- A project's WBS is shaped by its lead or someone who edits projects. Its BOQ lines are mapped by its team's leads
  and members. Viewers read. Others do not see the project at all.

**Decisions made while building (change any you disagree with):**
- **[Likely] One mapping per line of the project, not per BOQ.** A contract line and its budget line share their
  line key (step 2), so mapping one maps both, and the budget is broken down exactly like the contract. The mapping
  also survives revisions: a revised contract BOQ keeps its lines' WBS and cost codes. A line added only to the
  budget, or only in a later revision, is mapped on its own.
- **[Likely] Items only.** Sections and notes are not mapped. Selecting a section maps the items under it.
- **[Certain] Cost codes are company-wide master data** (P10), shared by all projects, so procurement (2b) and
  accounts (Wave 3) can book to the same codes. Codes are unique regardless of case and go four levels deep at most.
  A retired code stays on the lines already mapped to it but is no longer offered.
- **WBS codes are free text** (letters, digits, `. _ / -`), unique in the project. The WBS goes ten levels deep at
  most. The tree made from a BOQ is numbered by position; re-code it as you like.
- **The tender's programme is still not used** (Wave 1 decision). Step 4's project schedule will hang its activities
  on this WBS.

**Speed** (200,000-line BOQ, this machine): making the WBS from its sections and mapping every item took 4.6 s;
mapping all 200,000 lines to a cost code 3.7 s; the breakdown 0.7 s; a page of the grid with its mapping 13 ms.
A million lines would take about five times as long for the first three, which is still within a request.

**API** (under `/api/tenant`):
- Cost codes: `GET /cost-codes`, `POST /cost-codes`, `POST /cost-codes/:id`, `POST /cost-codes/standard`.
- WBS: `GET /projects/:id/wbs`, `POST /projects/:id/wbs`, `POST /projects/:id/wbs/from-boq` (`{boqId, depth}`),
  `POST /wbs/:id`, `POST /wbs/:id/move` (`{direction}`), `POST /wbs/:id/delete`.
- Mapping and breakdown: `POST /boqs/:id/mapping` (`{from, to, wbsId?, costCodeId?}`, where `null` clears),
  `GET /projects/:id/breakdown`. Grid rows carry `map: {wbs, costCode}`.
- Permission `costcodes.edit`. Migration `0024_wbs_cost_codes.sql`.

**Tests:** 6 API integration tests:
- the standard list, unique codes, retiring codes and cycles refused;
- the WBS made from the contract's sections with items mapped, on the contract and its budget;
- a range mapped to a cost code and a line to a WBS element; clearing; refusals (retired code, a tender's BOQ, a
  viewer); mapping kept through freezing and revising;
- the breakdown by WBS and by cost code with what is unmapped;
- hand editing: add, duplicate refused, reorder, move, cycle refused, removal only when empty; and the project hidden
  from a worker off the team.

A browser test loads the standard cost codes, wins a tender with a two-section BOQ, makes the contract BOQ, makes
the WBS from it, adds and removes an element, maps a section to a cost code from the grid, and reads the breakdown.

## Step 4 delivered: project schedules

**Journey:**
- A project's page lists its **Schedules**. **New schedule** starts one, by default laid out on the project's WBS:
  each element becomes a summary (with elements under it) or an activity of five days, carrying the element's code,
  name and link. **Import file** brings one in from MS Project (XML) or Primavera (XER). The tender's programme is
  still not copied (Wave 1 decision).
- A schedule opens in the programme editor of Wave 1: activities and links typed in the grid, calendars, constraints,
  summaries, the bar chart, recalculated on every change, MS Project, Primavera and Excel exports, the A3 print. On a
  project schedule it adds the following:
  - **Data date** (Settings): progress is as of that day.
  - **Progress** (the activity panel): actual start, actual finish, or the working days still to do.
    - A started activity carries on by its days left from the data date (blank: its duration less the working days
      since it started).
    - A finished one sits on its actual dates.
    - Nothing not done is planned before the data date.
    - Actual dates after the data date are refused.
    - Rows show ◐ in progress and ✓ finished. The bar chart darkens the work done up to the data date and greys
      finished work.
  - **Baselines** (Settings): *Take a baseline* freezes the dates as they are, kept for good. The first one is shown
    at once; any other can be chosen. With a baseline shown, the header gives the finish against it ("+2 days"), the
    grid adds a **Var** column (each activity's finish against its baseline finish, late in red), and the chart
    draws the baseline as a thin bar under each activity.
  - **WBS element** per activity (the activity panel).
  - **Resources a working day** per activity, from the rate library (labour, materials, equipment…).
    **Resources** shows what the schedule needs week by week from the data date, shaded by load, with what comes
    later and the total.
  - **Look-ahead**: activities on or due to start in the next 1 to 12 weeks from the data date, by start, with what
    they sit under, their WBS, days left and float, critical ones in red. It is a page of its own, printed or saved
    as PDF from the browser (A4 landscape) for the weekly site meeting.
- A project schedule holds up to **50,000 activities** (a tender programme stays at 20,000).

**Who does what:** a project's schedules are seen by its team only (and admins and those who see every project), on
every schedule route, as for its BOQs. Changing one needs **Create and edit tender programmes** and a lead or member
place on the team (or the right to edit projects). Viewers read.

**Decisions made while building (change any you disagree with):**
- **[Likely] Progress override, not retained logic.** The rest of a started activity goes on from the data date even
  if one of its predecessors is not finished. That is what site teams report, and what most tools do by default. P6's
  retained logic (the remainder waits for its predecessors) can be an option later.
- **[Certain] Progress is reported in days (dates and days left), not in percent.** Physical percent complete,
  measured against BOQ quantities, is step 6. A percent typed by hand would compete with it.
- **[Certain] Baselines are kept for good** (never edited or deleted), like frozen BOQ versions. A baseline keeps
  each activity's dates as they were; activities added later have no baseline dates.
- **[Likely] Resources are per working day**, with no levelling. The weekly view shows overloads; moving work to
  smooth them stays with the planner.
- **Imports carry no progress yet.** A file's actual dates are dropped with a warning, as for tender programmes. The
  exports do not include progress either.
- **WBS elements with schedule activities on them cannot be removed** until the activities are moved to another
  element.

**Speed** at 50,000 activities (50 summaries of 999 chained tasks), on this machine:
- **[Certain]** Opening the schedule took 0.9 s, about 28 MB of JSON before compression (production compresses
  through Caddy).
- **[Certain]** One edit that moves the finish took 3.2–3.6 s: reading 0.4 s, scheduling 0.5 s, writing the dates
  and float of every activity 1.2 s, and sending the whole plan back about 0.9 s.
- **[Likely]** A typical 5,000-activity schedule edits in well under a second.
- **[Guessing]** Sending back only what changed would save most of that last 0.9 s; it needs the editor to merge
  changes, and is left for when a pilot's schedule shows it matters.

**API** (under `/api/tenant`):
- Schedules: `GET /projects/:id/schedules`, `POST /projects/:id/schedules` (`{name, startOn, fromWbs}`),
  `POST /projects/:id/schedules/import`.
- `POST /programmes/:id` takes `dataDate` and `baselineId`. Activity edits take `wbsId` and
  `progress: {actualStart, actualFinish, remaining}`.
- Baselines and resources: `POST /programmes/:id/baselines` (`{name}`),
  `GET /programmes/:id/activities/:activityId/resources`,
  `POST /programmes/:id/assignments` (`{activityId, resourceId, unitsPerDay}`, where `null` removes),
  `GET /programmes/:id/resources?weeks=`.
- Look-ahead: `GET /programmes/:id/lookahead?weeks=`.
- Migration `0025_project_schedules.sql`. The engine (`packages/shared/src/schedule.ts`) takes a data date and each
  activity's progress.

**Tests:**
- 4 engine tests worked by hand on the site calendar: days left from the data date, a finished activity on its
  actual dates, nothing before the data date, a milestone reached, constraints ignored once started, summaries
  rolled up.
- 6 API integration tests: a schedule laid out on the WBS and kept to the team; scheduling and a baseline; progress
  and the slip against the baseline, actuals after the data date refused, none on a tender's programme; the
  look-ahead; resources and their weekly load; a WBS element kept while activities are on it.
- A browser test: a resource, a won tender made a project with a two-element WBS, a schedule on it, a link, a
  baseline, the data date and progress (+2 days against the baseline), masons on an activity and their weekly load,
  and the look-ahead.

## Step 5 delivered: macro plans

**Journey:**
- Activities of a project schedule get a **package** (a contract or subcontract package: Civil, MEP…), a **trade**
  (Masonry, Electrical…) and a **zone** (block, floor, area) in the activity panel. Each is free text, suggested
  from the values the project already uses.
- The project's **Macro plan** (from its Schedules card) rolls up every live schedule (the micro plans; archived
  ones are left out):
  - **By WBS:** each element with the activities on it and under it. It shows the span (start, finish), a bar to
    one time scale with the baseline span under it, progress, the slip of its finish against the baselines shown,
    and activities done out of all (critical ones counted). Activities on no WBS element come last.
  - **Milestones:** every milestone of the schedules, with its schedule, WBS element, date (actual once reached),
    baseline date and slip.
  - **By package, by trade, by zone:** the same roll-up for each value, "not set" last.
  - The project's totals on top, and each schedule with its data date, finish and baseline.
- It prints from the browser.

**Decisions made while building (change any you disagree with):**
- **[Certain] The macro plan is computed, not kept.** It is always the live schedules as they are. A frozen
  "macro baseline" is each schedule's own baselines rolled up the same way.
- **[Likely] Progress is by working days:** for each activity, its duration less the days still to do, over all the
  durations. Milestones weigh nothing. Physical progress against the BOQ (step 6) may replace it as the measure.
- **[Likely] Three fixed groupings (package, trade, zone)** rather than Primavera-style activity codes of any
  number and kind. They are what Indian sites plan by. More kinds can be added if pilots need them.
- **[Certain] Slip is in calendar days** (finish against baseline finish), as people say "two days late". Float
  stays in working days in the schedules.
- **Groups do not come in from imported files yet.** P6 activity codes and MS Project text fields could be mapped to
  them later.

**API** (under `/api/tenant`):
- `GET /projects/:id/macro`: schedules, project totals, WBS roll-up, unassigned, milestones, by package, trade and
  zone.
- `GET /projects/:id/activity-groups`: the values in use.
- Activity edits take `package`, `trade` and `zone` (blank clears).
- Migration `0026_macro_plans.sql`.

**Tests:**
- 3 API integration tests, with every figure worked by hand on the site calendar:
  - two schedules rolled up through a two-level WBS: spans, slip against a baseline, progress by days at 20%,
    12.5% and 7.1%, an unassigned activity, the milestone's slip;
  - the roll-ups by package, trade and zone (blank as not set), and the values offered;
  - archived schedules left out, the team only, and no groups on a tender's programme.
- A browser test: a schedule on the WBS, a package and trade on an activity, a milestone, a baseline, and the
  macro plan's WBS, milestone, package and trade views.

## Step 6 delivered: progress measurement

**Journey:**
- In a project's **contract BOQ**, the grid shows each item's quantity **Done** and its percent of the BOQ quantity
  (red when beyond it). The budget shows the same quantities, since its lines are the same work.
- Choosing an item and pressing **Work done** opens its **measurement book**:
  - the entries so far (date, quantity, description, who), and what is done of the BOQ quantity at the contract rate;
  - a new entry on a day (not in the future, by India's date), from **dimensions** (rows of nos × length × breadth
    × height, deductions, worked out as they are typed) or as one **quantity**.
  - A wrong entry is **reversed** with a reason: an entry of the opposite quantity is added, and the wrong one stays
    on the record, crossed out. Entries are never changed or deleted, by the app or in the database.
- The project's **Progress** (from its page) reports the work done to a day and in a period (from the first of the
  month by default):
  - **physical progress**: the work done within each item's BOQ quantity, by contract value;
  - the **value done** at contract rates (all of it, excesses included, as it will be billed);
  - **this period's** value;
  - the **same work at budget rates**;
  - items started and items beyond their quantity.
  - It breaks down by contract BOQ and its top-level sections, and by WBS element (through the step 3 mapping,
    rolled up the tree).
- A schedule activity's **BOQ items** (its activity panel): link an item by its code, or a section by its code with
  every item under it; unlink one. The activity's **physical progress** is theirs, by contract value within their
  quantities.

**Who does what:** the project's team records, reverses and links: its leads, members and those who edit projects.
No BOQ rights are needed, so a site engineer on the team can keep the book. Viewers read; others do not see the
project.

**Decisions made while building (change any you disagree with):**
- **[Certain] Measured against the contract BOQ, by line.** Entries follow the line through revisions of the
  contract BOQ, and the budget's same line is valued from them. An item added only to the budget has nothing
  measured against it.
- **[Certain] The book is append-only.** That is how a paper measurement book works and what a bill can be checked
  against. The database refuses changes and deletes, not only the screens.
- **[Likely] Two figures, on purpose:**
  - **physical progress** stops at each item's BOQ quantity, so an excess on one item does not hide work not done
    on another;
  - **value done** counts everything, because deviations are paid (Wave 3 bills from it).
- **[Likely] No approval of entries yet.** The approval engine (P5) is Wave 2b's first step. Entries can be
  approved then, before they are billed.
- **[Likely] The schedule's progress is still entered by hand** (actual dates, days left; step 4). An activity's
  physical progress is shown beside it, not used to move its dates: one is when, the other is how much. Step 7's
  dashboard shows both.
- **Measured quantities are not imported from files yet**, and the measurement book does not print yet.

**API** (under `/api/tenant`):
- Measurement book: `GET /boqs/:id/lines/:lineId/progress`, `POST /boqs/:id/lines/:lineId/progress`
  (`{measuredOn, qty | dims[], description}`), `POST /boqs/:id/progress/:entryId/reverse` (`{reason}`).
- Report: `GET /projects/:id/progress?from=&to=`.
- Activity items: `GET|POST /programmes/:id/activities/:activityId/lines` (`{boqId, code}`), `POST …/lines/remove`
  (`{lineKey}`).
- Grid rows carry `done`. Migration `0027_progress_measurement.sql`.

**Tests:**
- 4 API integration tests, with every figure worked by hand:
  - entries from dimensions with a deduction (48 cum), figures, an excess (120%), a wrong entry reversed once only,
    and the done quantity in the grid;
  - refusals: a future date, a section, a tender's BOQ, a viewer, a zero quantity; a member without BOQ rights
    records; the database refuses changes and deletes;
  - the report: value 49,000, done 27,280, physical 51.2%, this period 3,300, budget value 24,800, by section
    (89% and 20.4%) and by WBS element;
  - an activity's physical progress from a section's items (89%), and after one is unlinked (78%).
- A browser test: a contract BOQ item measured from dimensions, a wrong figure reversed with a reason, the done
  column, and the progress report at 50%.

## Step 7 delivered: project dashboard and reports

**Journey:** a project's page has a **Dashboard** button. The dashboard is one printable page, worked out when it is
opened:
- **Money**: the contract (its BOQ total, and the contract value if different), the planned margin, the work done
  at contract rates with its physical progress, this month's work, and the margin on the work done (its value at
  contract rates less the same work at budget rates).
- **Schedules**: each live schedule's data date, its finish against its baseline (the slip in days), the activities
  done, going, late against the baseline and critical, and its progress **three ways, side by side**:
  - **planned**: where the baseline says the work should be by the data date (baseline working days elapsed);
  - **scheduled**: what the planners report done (step 4, by working days);
  - **measured**: the physical progress of the BOQ items its activities carry out (step 6, by contract value).
  When two of them are more than 10 points apart, the page says so in words ("the planners report 80% done, the
  measurements show 30%"; "40% done against 60% planned").
- **S-curve**, month by month: **planned** (the value of the BOQ items linked to activities, spread over the
  activities' baseline working days), **forecast** (the same over the current schedule), **earned** (all work
  measured, at contract rates, to the end of each month). It says how much of the contract is linked to activities;
  the figures are in a table under the chart.
- The **next 14 days** across the live schedules (from each one's data date), with a link to a schedule's full
  look-ahead; the **next milestones** against their baseline dates.
- **Budget against contract** by contract BOQ, and the work done by section, with a link to the progress report.

The **progress report** (step 6) downloads as **Excel**: by contract BOQ and its sections, and by WBS element, as
numbers that sum.

**Who sees it:** the project's team (and those who see every project), as for the rest of the project; viewers too.

**Decisions made while building (change any you disagree with):**
- **[Certain] Three progress figures, never blended into one.** Step 6 left the schedule's progress typed by hand
  beside the measured progress. A single "true" percentage would need a rule for which wins, and either choice hides
  a mistake: a planner's optimism, or a measurement book not kept up. Shown side by side, a gap is visible and named.
- **[Certain] Working days, on each activity's calendar, holidays included**, for planned progress and both
  curves. Calendar days were tried first; the API test caught them giving 68.8% planned instead of 75% across
  Gandhi Jayanti.
- **[Likely] The curves cover only the linked work.** Planned and forecast need dates, which only an activity gives;
  an item carried out by two activities is shared equally between them. Earned counts all measured work, linked or
  not, because that is what will be billed. Link the BOQ to the schedule (a section code links all of it) for the
  curves to mean anything.
- **[Likely] Months, not weeks**, on the curve: a project of one to three years reads well by month; a ten-day job
  does not need an S-curve.
- **No portfolio view across projects yet** (each project's dashboard only); and nothing is stored: the dashboard is
  worked out from the live data each time it opens.

**API** (under `/api/tenant`): `GET /projects/:id/dashboard`, `GET /projects/:id/progress/export?from=&to=` (Excel).

**Tests:**
- 2 API integration tests, with every figure worked by hand on the site calendar:
  - an empty project; then a schedule with a baseline, progress as of 1 October and two activities carrying out the
    contract's items: contract 49,000, budget 45,000, margin 8.16%; planned 75% (concrete's span crosses the
    2 October holiday), scheduled 66.7%, measured 62.5%; a slip of one day; the S-curve's planned (0, 33,000,
    44,000), forecast (0, 31,428.57, 44,000) and earned (4,400, 24,200, 29,700) by month; the look-ahead and the
    milestone;
  - the progress report as Excel (section and project totals, the period), and the team only.
- A browser test: a won tender's item measured (40%), a schedule with the item linked to its activity, a baseline
  and progress as of a data date; the dashboard's figures (planned 60%, scheduled 40%, measured 40%, two days late,
  the gap said in words), the S-curve, the look-ahead, and the progress report downloaded as Excel.
