# Wave 2b Build Plan: Procurement, Inventory, Site Reports

Scope: docs/04-features.md W2b (R1-R7), with the basic approval engine (P5) that Wave 0 promised and never built.
docs/01-mvp.md split Wave 2 in two; this is **2b**, after 2a (projects and scheduling, docs/wave2a-plan.md).

**Started without Wave 2a tried on a real project** (nor Wave 1 on a real tender). [Likely] 2b hangs purchasing off
2a's data: requisitions name contract BOQ lines (by their line key) and WBS elements, and later material demand comes
from the BOQ and the schedule. If a pilot finds those identities wrong, 2b inherits it. Keep looking for the pilot.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Decisions taken at the start (change any you disagree with)

- **[Certain] The approval engine comes first and is generic.** Documents register with it (requisitions in step 1,
  orders in step 4, later measurement certificates and bills); it knows levels, amounts, approvers, delegation and
  comments, not what a requisition is.
- **[Certain] Approvers can only be the project's lead, any manager, any admin, or a named person.** The app has
  three fixed roles (admin, manager, worker); there are no designations such as Purchase head or Director (P2's custom
  roles were never built). A named person covers a designation today; custom roles can replace it later without
  changing requests already made.
- **[Likely] No rules means no approval.** A document type with no rules is approved as soon as it is submitted, so a
  small firm is not blocked until its admin sets rules up. The admin sets rules per document type: levels, each from
  an amount upwards.
- **[Certain] A request keeps the rules it was submitted under.** Changing the rules does not move requests already
  in flight.
- **[Likely] Nobody approves their own request**, not even through a delegation. A level that only the submitter
  could approve goes to the admins instead (recorded as such); submitting is refused if no one else could approve a
  level at all.
- **[Certain] Notifications are in-app only.** Staff accounts have a username and a password but no email address
  (docs/03-architecture.md §6), so the app cannot email them. "Waiting on me" is in the menu with a count.
- **[Certain] The material budget is the project's own copy (your decision, 11 Oct 2026).** Made once from the won
  tender's rate analyses when the project takes its budget; never linked back to estimation; the tender's estimate is
  then closed; the project revises its copy as often as it needs, each revision kept.
- **[Guessing] GST on purchase orders** (step 4) waits on the open question from 2a step 2: whether contract values
  are entered with or without GST. Purchase GST itself is clear (CGST + SGST within the state, IGST across states,
  from the site's state and the vendor's GSTIN).

## Steps

| # | Step | Features | Notes |
|---|------|----------|-------|
| 1 | **Approvals + purchase requisitions** (P5, R1) | Approval rules by document type, levels by amount, approvers (project lead, managers, admins, a named person), delegation while away, comments, withdraw, "waiting on me"; requisitions for a project (materials from the rate library or typed in, quantities, needed-by dates, BOQ line and WBS element) as its first user | **Done** (see below) |
| 2 | **Material budget and demand** (R1) | The project's material budget, copied from the tender's rate analyses and revised under approval; the estimate closed; requisitions against the budget, from BOQ items and from the look-ahead | **Done** (see below) |
| 3 | **Vendor enquiries for a project** (R2) | Wave 1's RFQs and comparative statements for requisitioned materials | **Done** (see below) |
| 4 | **Purchase and work orders** (R3) | Terms, GST, amendments, approvals, supplier acknowledgement | |
| 5 | **Goods receipt and inspection** (R4) | Partial receipts, quality hold, returns | |
| 6 | **Inventory** (R5) | Stores, issues to WBS, transfers, returns, stock ledger, valuation, reorder levels, stock take | |
| 7 | **Daily site reports** (R6) | Manpower, equipment, materials, weather, work done, delays, safety, photos; phone first | |
| 8 | **Project documents** (R7) | The project's vault and drawings register with revisions (Wave 1's documents) | |
| 9 | **Procurement reports** | Requisition to order to receipt, open orders, stock, consumption against budget | |

Each step ships with API tests and a browser test of the main journey, as in Waves 1 and 2a.

## Step 1 delivered: approvals and purchase requisitions

**Journey:**
- The admin sets **Approval rules** (in the menu): for purchase requisitions, up to six levels, each from an amount
  upwards, approved by the project's lead, any manager (or admin), any admin, or a named person, with a name for the
  level ("Purchase head"). With no levels, a requisition is approved when it is submitted.
- On a project's page, the team raises a **requisition**: a title, then on its own page the lines, each a resource
  found in the rate library (its name, unit and today's rate filled in) or typed in, with a quantity, a rate, the
  contract BOQ item and WBS element it is for (by their codes) and a needed-by date; the site and a needed-by date
  for the whole. The estimated total is worked out as it is typed. Numbered PR/2026-27/0001 and so on.
- **Submit for approval**: the requisition waits at its first level. **Approvals** (in the menu, with a count) lists
  what waits on me, what I submitted and what I decided. The approver sees the requisition even if they are not on
  its project, its levels and its history; approves (with a note), rejects (a reason is needed) or comments.
- Rejected, it goes back to its team with the reason; they change it and submit again (a new request, under the
  rules of the day). The submitter can withdraw it while it waits, to change it. Approved, it is locked (and goes to
  purchase orders in step 4). A requisition not waiting can be cancelled with a reason.
- **Standing in while away**: anyone names someone to approve for them between two days (the admin, for anyone).
  The stand-in sees what waits on the person away, and the record shows who acted for whom.
- The submitter is told in the app when a request is approved or rejected; approvers are told when one comes up.

**Who does what:**
- The project's team (leads and members, and those who edit projects) raises, changes, submits and cancels its
  requisitions; viewers read; others do not see the project. No purchasing permission is needed yet, so a site
  engineer on the team can raise them.
- Approvers are whoever the rules name, at each level in turn.

**Decisions made while building (change any you disagree with):**
- **[Certain] Nobody approves their own request, nor two levels of the same one.** The project's lead who approved
  level 1 is not the "any manager" of level 2. A level that only the submitter (or earlier approvers) could approve
  goes to the admins; as a last resort an admin who approved an earlier level may approve that one too, since a small
  company may have one admin. Submitting is refused if no one else at all could approve a level.
- **[Certain] Who may approve is worked out when they act**, from the level kept with the request: a new project
  lead, or a stand-in set up after it was submitted, can act on it. Who was told is worked out when the level comes up.
- **[Likely] A changed requisition is a new request.** The rejected or withdrawn one stays in its history.
- **[Likely] Rates are estimates.** A line's rate is the rate library's on the day it is added (or typed); orders
  carry the agreed price (step 4).
- **No email**: staff have no email address (decided at the start). A purchase permission, and whether requisitions
  should need one, can come with orders in step 4.

**API** (under `/api/tenant`):
- Rules: `GET /approval-rules`, `POST /approval-rules/:docType` (`{rules: [{minAmount, approver, userId, label}]}`,
  the admin).
- Requests: `GET /approvals?view=waiting|mine|decided`, `GET /approvals/:id`, `POST /approvals/:id/approve`
  (`{comment?}`), `…/reject` (`{comment}`), `…/withdraw`, `…/comments` (`{comment}`).
- Stand-ins: `GET /approval-delegations`, `POST /approval-delegations` (`{fromUserId?, toUserId, startsOn, endsOn,
  reason}`), `POST /approval-delegations/:id/cancel`.
- Requisitions: `GET /requisitions?projectId=&status=`, `POST /projects/:id/requisitions`, `GET /requisitions/:id`,
  `POST /requisitions/:id` (all of it, with `rowVersion`), `…/submit` (`{rowVersion}`), `…/cancel` (`{reason}`).
- The inbox's `pending` carries `approvals`, the count waiting on me. Migration `0028_approvals_requisitions.sql`.

**Tests:**
- 4 API integration tests:
  - a requisition from the rate library and typed in (₹42,250), resolved BOQ item and WBS element, viewers and
    outsiders refused, a wrong BOQ code refused; with no rules, approved on submission;
  - three levels by amount (the lead, a manager, Lata by name): amounts out of order and a manager setting rules
    refused; ₹60,000 goes to the lead, then not to the same person again but the admin; the submitter cannot approve;
    rejected with a reason, changed to ₹48,000, now needing one level, approved; the submitter told;
  - a lead's own requisition goes to the admins; withdrawn by its submitter only; cancelled;
  - ₹3,20,000 through all three levels, the named approver not on the project but seeing it, standing in (not by the
    submitter), a comment, approval on her behalf recorded, stand-ins cancelled; the registers; the decision trail
    cannot be changed in the database.
- A browser test: the admin adds a site engineer, cement to the library and the rule; the engineer, in his own
  browser, raises a requisition from the library and a typed line and submits it; the lead finds it waiting (with the
  count), rejects it with a reason; the engineer changes it and submits again; the lead approves; the engineer sees
  it approved and is told.

## Step 2 delivered: material budget and demand

**Your decision:** the material budget comes from the tender's rate analyses, is the project's own (not linked to
estimation), the estimate is closed when the project takes it, and the project revises its copy as often as needed.

**Journey:**
- A project from a won tender, once its contract BOQ is made (2a step 2), has **Make it from the tender** under
  **Material budget**. Each contract BOQ item's rate analysis, as it was in the tender version the contract came from,
  with its sub-analyses (mortar inside brickwork) and wastage worked in, gives what one unit of the item takes of each
  resource: its **norms**. Times the budget's quantities, added up per resource, at the rates on the estimate's rate
  date, they make **revision 0**: cement, steel, sand, labour, equipment, each with quantity, rate and amount.
- The **tender's estimate is closed**: frozen as it is, and no new revision of it can be started ("closed: won, the
  budget of project PRJ/…"). Estimation is never looked at again for this project.
- Revision 0 is checked and changed like any revision, then **submitted**; once approved under the approval rules for
  "Material budget revision" (or at once, with none), it is **in force**.
- **Start a revision** (with a reason): a copy of the budget in force, where the lead changes quantities and rates,
  adds resources from the rate library and removes others. It shows each resource against the revision before it and
  what requisitions already take. Submitted, approved, it is in force and the one before is kept, replaced. A revision
  can be discarded (kept as discarded if it was ever submitted).
- **Requisitions** show, for each line from the library, the budget in force for it and what the project's other
  live requisitions take: "34.68 of 34.68 left: 5.32 over", in red when a line goes past it. The approver sees the
  same. Going over is allowed (the approval is where it is judged), and a resource not in the budget is marked so.
- A requisition's lines can be **worked out**: a BOQ item and a quantity of work ("5 cum of C1": 17.34 bags of cement,
  2.35 cum of sand, half a mason-day), or **the look-ahead**: the work not yet measured on the BOQ items whose activities
  are on or due in the next 1 to 8 weeks, by the norms, with what is already requisitioned; ticked lines are added.

**Who does what:** the project's lead (and those who edit projects) makes and revises the budget; the team reads it
and raises requisitions against it; the approval rules decide who approves a revision.

**Decisions made while building (change any you disagree with):**
- **[Certain] The analyses are taken as they are now, and flagged if changed after the bid.** A BOQ item points to
  its rate analysis in the company's library; the tender's versions keep the pointer, not the analysis, so an analysis
  edited after the tender was frozen gives today's figures, not the bid's. The budget says how many items this affects
  ("1 of 2 BOQ items took their quantities from a rate analysis changed after the tender was frozen") and keeps the
  flag on each item's norms. Freezing the analyses with each submitted tender version would remove the doubt for later
  tenders; that is a change to Wave 1, not made here.
- **[Likely] Quantities from the project's budget BOQ** (the cost copy from 2a step 2), the contract's if there is
  none; **rates as on the estimate's rate date** (the first contract BOQ's, if there are several).
- **[Likely] Lump sums and percentage additions are money, not resources**, so they are not in the material budget.
  The budget BOQ keeps the cost of the work; the material budget keeps the resources. They can drift apart as each is
  revised; that is the price of keeping them separate, as decided.
- **[Likely] The norms are fixed when the budget is made**; revisions change the totals per resource, not the norms.
  Items added to the contract later have no norms until revised by hand.
- **[Likely] A revision is approved for what it adds** to the budget in force (revision 0 for its total), so a rule
  "from ₹50,000" catches large increases; a rule from ₹0 approves every revision.
- **[Likely] The estimate is closed when the material budget is made**, not when the contract BOQ is: that is when
  the project takes the estimate as its budget. Its BOQ page does not say so yet; starting a revision of it is refused
  with the reason.
- **The look-ahead counts all the unmeasured work** on an item whose activity is in the window, not just the part
  falling in it, and nets nothing off for stock or open orders yet (steps 4 to 6 bring those).

**API** (under `/api/tenant`):
- `GET /projects/:id/material-budget` (revisions, in force, open), `POST /projects/:id/material-budget/from-tender`,
  `…/blank`, `…/revise` (`{reason}`).
- `GET /material-budgets/:id`, `POST /material-budgets/:id` (`{rowVersion, reason, lines: [{resourceId, qty, rate,
  note}]}`), `…/submit` (`{rowVersion}`), `…/discard`.
- `GET /projects/:id/material-demand/item?code=&qty=`, `GET /projects/:id/material-demand/lookahead?weeks=`.
- Requisition lines carry `budgetQty`, `budgetUsedElsewhere`, `hasBudget`. A closed estimate refuses
  `POST /boqs/:id/revise` (`boq_closed`). Migration `0029_material_budget.sql`.

**Tests:**
- 3 API integration tests, every figure worked by hand:
  - from the tender: brickwork per 10 cum with 2.5 cum of mortar + 4 % (itself 8 bags and 1.1 cum sand per cum), RCC
    with wastage, an item with no analysis; RCC's steel raised after the bid: cement 267.2 bags, sand 23.3 cum, steel
    1,785 kg, masons 60 days, ₹3,20,780; the norms per item and the changed flag; refused before the contract BOQ and
    for a member; made once; the estimate closed; in force with no rule;
  - requisitions against it (100 bags elsewhere); revision 1 (cement 330 at ₹420, wire added, masons dropped:
    ₹3,00,300) approved by a manager for ₹0; revision 0 replaced; a revision discarded (gone) and one rejected then
    discarded (kept);
  - materials for 10 cum of a BOQ item; the look-ahead for an activity carrying out RCC with 5 of 20 cum measured
    (122.4 bags, 1,338.75 kg, 6.75 cum); an empty budget for a project without a tender; the norms cannot be changed
    in the database.
- A browser test: a price book and a PCC analysis; a tender item priced from it, won, its project's BOQs; the material
  budget from the tender (34.68 bags, ₹23,232) put in force; a requisition for 5 cum of the item, then 40 bags, shown
  5.32 over the budget; the budget revised to 45 bags and in force, revision 0 replaced.

## Step 3 delivered: vendor enquiries for a project

**Journey:**
- An **approved** requisition has **Ask vendors**: it starts the project's enquiry (RFQ/2026-27/…, the same series as a
  tender's) with the requisition's lines. A project's page has **Enquiries**: a new one with any of its approved
  requisitions ticked, and the list (quotes in, lines chosen).
- On the enquiry, lines come **from requisitions** (more can be added later), from the rate library, or typed in. A
  material asked for in several requisitions is **one line with their quantities added up** (cement, 100 + 60 bags);
  each line shows the requisitions it is for, and a requisition shows the enquiries asking for it. Lines already asked
  for are not added twice.
- Everything else is Wave 1's: suppliers from the party master or new, the enquiry workbook per supplier, quotes typed
  in or imported, GST included or extra, negotiation rounds, the comparative statement before GST, the lowest per line
  or a supplier for all, reminders before quotes are due.
- A project's enquiry **changes no estimate**: "Put the chosen rates into the estimate" is a tender's. The suppliers
  chosen are what purchase orders (step 4) are made from.
- The **closed estimate** (step 2) now says so on its BOQ page, and no longer offers to start a revision.

**Who does what:** the project's team reads its enquiries; others do not see them (as for its BOQs and schedules).
Starting and working on one needs `rfq.edit` (managers by default) and a place on the team as lead or member (or the
right to edit projects).

**Decisions made while building (change any you disagree with):**
- **[Certain] One RFQ engine for tenders and projects.** An RFQ belongs to a tender or to a project (exactly one, by
  the database); a project's goes into the project's activity.
- **[Certain] Only approved requisitions go to vendors**, checked before the enquiry is made (a refused one leaves no
  empty RFQ behind, which the first version of this step did).
- **[Likely] Work enquiries for a project are typed lines**: a subcontract package from the contract BOQ waits until
  work orders (step 4) show what they need.
- **[Likely] Quote documents are not attached on a project's enquiry yet**: Wave 1 files them in the tender's
  documents, and project documents are step 8.

**API** (under `/api/tenant`): `GET|POST /projects/:id/rfqs` (`{title, kind, dueOn, terms, requisitionIds}`);
`POST /rfqs/:id/lines` also takes `{requisitionIds}`; an RFQ carries `projectId` and `project`, its lines their
`requisitions`; a requisition its `enquiries`; `POST /rfqs/:id/apply` is refused for a project (`not_for_project`).
A BOQ's header carries `closedAt` and `closedReason`. Migration `0030_project_rfqs.sql`.

**Tests:**
- 2 API integration tests: an enquiry from two approved requisitions (cement 100 + 60 = 160 bags on one line, wire
  and sand as asked, each with its requisitions), a draft requisition refused with nothing left behind, a worker
  without `rfq.edit` refused, nothing added twice, the requisition's enquiries and the project's list; two quotes, the
  lowest chosen per line (₹84,925), "apply" refused, a viewer reads, someone off the team does not see it, the
  project's activity.
- The step 2 test also checks the closed estimate's header.
- A browser test: a requisition from the library and a typed line, approved, sent to vendors with **Ask vendors**;
  two suppliers quote, the lowest per line chosen (₹59,400); no "into the estimate"; the enquiry on the project's
  page and the requisition's.
