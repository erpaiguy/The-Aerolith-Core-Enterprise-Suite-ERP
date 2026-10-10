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
| 2 | **Contract BOQ + budget** (J2) | BOQs owned by a project; from the won tender's submitted BOQ: contract BOQ at quoted rates, budget at estimate rates (a background copy for large BOQs); versions; budget against contract | |
| 3 | **WBS + cost codes** (J3) | WBS tree per project; company cost-code master; BOQ items mapped to WBS and cost codes (one by one and in bulk by range) | |
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
