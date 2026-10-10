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
| 4 | **Project schedules** (J4) | The Wave 1 engine for project plans: constraints, resources and assignments, multiple baselines, progress updates (data date, actuals, remaining duration), look-ahead; 50k activities | |
| 5 | **Macro plans** (J5) | Roll-up of micro plans through the WBS, milestones, summary views by package, trade and zone | |
| 6 | **Progress measurement** (J6) | Physical % per BOQ item and activity, measurement-based progress, progress value against the contract BOQ | |
| 7 | **Project dashboard and reports** | Progress, schedule variance, budget against contract, look-ahead | |

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
