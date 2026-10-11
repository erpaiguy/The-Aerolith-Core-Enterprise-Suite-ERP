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
- **[Certain] GST is always added on top of the contract value (your decision, 11 Oct 2026).** Rates and contract
  values are before GST; the tax is worked out and added. On purchase and work orders: CGST + SGST when the supplier's
  state (the first two digits of its GSTIN) is the site's, IGST across states, none from a supplier without a GSTIN.
  For contract values this confirms 2a step 2's rule (compared before GST). Still open there: a project made from a
  won tender takes the submission's bid value, which the submission form suggests *with* GST; the contract BOQ page
  then asks, but the value itself is not corrected for you.

## Steps

| # | Step | Features | Notes |
|---|------|----------|-------|
| 1 | **Approvals + purchase requisitions** (P5, R1) | Approval rules by document type, levels by amount, approvers (project lead, managers, admins, a named person), delegation while away, comments, withdraw, "waiting on me"; requisitions for a project (materials from the rate library or typed in, quantities, needed-by dates, BOQ line and WBS element) as its first user | **Done** (see below) |
| 2 | **Material budget and demand** (R1) | The project's material budget, copied from the tender's rate analyses and revised under approval; the estimate closed; requisitions against the budget, from BOQ items and from the look-ahead | **Done** (see below) |
| 3 | **Vendor enquiries for a project** (R2) | Wave 1's RFQs and comparative statements for requisitioned materials | **Done** (see below) |
| 4 | **Purchase and work orders** (R3) | Terms, GST, amendments, approvals, supplier acknowledgement | **Done** (see below) |
| 5 | **Goods receipt and inspection** (R4) | Partial receipts, quality hold, returns | **Done** (see below) |
| 6 | **Inventory** (R5) | Stores, issues to WBS, transfers, returns, stock ledger, valuation, reorder levels, stock take | **Done** (see below) |
| 7 | **Daily site reports** (R6) | Manpower, equipment, materials, weather, work done, delays, safety, photos; phone first | **Done** (see below) |
| 8 | **Project documents** (R7) | The project's vault and drawings register with revisions (Wave 1's documents) | **Done** (see below) |
| 9 | **Procurement reports** | Requisition to order to receipt, open orders, stock, consumption against budget | **Done** (see below) |

Each step ships with API tests and a browser test of the main journey, as in Waves 1 and 2a.

## Steps 6-9 in detail (planned before building)

Written before step 6 starts, so each step is agreed before code. "Delivered" sections below replace these as steps
ship; anything changed while building is recorded there.

### Step 6: Inventory (R5)

(Built: see "Step 6 delivered" at the end for what changed.)

**Goal:** what is in each store, where it came from, where it went, and what it is worth.

**Model:**
- **Stores** belong to a project's site (`proc.store`: project, site, name, active). [Likely] One store per site is
  the common case; a second (a cement godown, a steel yard) is allowed. **Bins** (`proc.store_bin`) are optional
  locations inside a store, for those who track racks or yards; most sites will not.
- **One stock ledger** (`proc.stock_move`): every movement is a row with store, bin, resource, quantity (+ in,
  − out), unit cost, value, the document that caused it (receipt line, issue, transfer, return, adjustment) and date.
  Balances are sums of the ledger; a materialised balance per store and resource (`proc.stock_balance`) is kept in the
  same transaction for speed and checked against the ledger by a test.
- **Only library resources are stocked.** A typed-in order line (no resource) is received but not stocked; the receipt
  says so. [Likely] This pushes teams to pick materials from the library, which the budget (step 2) needs anyway.
- **Valuation:** weighted average per store and resource by default; FIFO as a tenant setting chosen before the first
  movement and fixed after (switching method mid-stream rewrites history). [Certain] Values come from the order rate
  **before GST** (input credit is not cost for a registered contractor); an unregistered supplier's line is costed
  with its GST, since nothing is claimed back.

**Movements:**
- **Receipts in:** every accepted receipt line (step 5) posts into the receipt's site store, at the order rate. Held
  goods post when accepted. A cancelled receipt reverses its moves, refused if the stock has since been issued below
  what it would take back (issue first, then cancel is not allowed to make stock negative).
- **Issues** to work: to a **WBS element** (and optionally a BOQ line), with who took it and for what; issue slips
  numbered ISS/2026-27/…. Issues cost at the store's current average (or FIFO layers).
- **Returns from site** to the store (unused material back), against the issue.
- **Transfers** between stores of the same project, or to another project's store (a transfer note, TRN/…; in
  transit until received at the other end, so the stock is never in two places).
- **Stock take:** a count sheet per store; differences post as adjustments with a reason, under the approval rules
  (document type `stock_adjustment`) above an amount.
- **Reorder levels** per store and resource: below it, the store shows it, and a requisition can be raised for the
  shortfall.
- **No negative stock**, ever: an issue beyond the balance is refused. [Likely] Sites will ask to "issue now, receive
  the paperwork later"; the answer is to record the receipt first.

**Screens:** Stores (per project, and in the menu, replacing "Stores — soon"); a store's stock (resource, quantity,
value, average rate, below reorder); a resource's ledger in a store; issue, return, transfer and count forms; the
receipt shows its stock moves.

**Reports in this step:** stock by store and value; ledger for a period; issues by WBS element (consumption) against
the material budget.

**Permissions:** `stores.receive` (step 5) also covers issues and returns; transfers out and stock take adjustments
need the new `stores.manage` (managers by default).

**Tests:** hand-worked weighted average across three receipts and two issues; FIFO across the same; a transfer in
transit; a stock take with a loss approved; negative stock refused; a receipt cancel refused after issue; ledger equals
balance; a browser test receiving, issuing to a WBS element and seeing the balance and value.

**Open questions for you before step 6:** (1) weighted average as the default; (2) whether issues need a BOQ line or a
WBS element is enough; (3) whether a site engineer (worker) may issue, or only the storekeeper.

### Step 7: Daily site reports (R6)

(Built: see "Step 7 delivered" at the end for what changed.)

**Goal:** what happened on site today, recorded on site from a phone.

- One report per site per day (`proj.daily_report`): weather (morning/afternoon, rain hours), manpower by trade and
  by labour contractor (headcount, own or contractor), equipment (owned/hired, hours worked, idle with reason),
  materials received (pulled from the day's receipts) and consumed (pulled from the day's issues), work done (BOQ
  line or activity with quantity, which **does not** replace the measurement book: it is the site's daily claim),
  hindrances and delays (cause, hours, whose account: client, us, weather), safety remarks, visitors, photos.
- Drafted through the day, **submitted** by the site in-charge, **acknowledged** by the project lead; a submitted
  report is changed only by a correction with a reason.
- **Phone first:** the screens work at 360 px wide, large touch targets, photo capture from the camera, and save as
  you go so a dropped signal loses nothing typed. [Certain] Not offline: the app stays online-only until Wave 6's
  mobile work (docs/01-mvp.md non-goals). Photos are compressed in the browser before upload.
- Missing reports: a project's page shows days without a report; a reminder to the in-charge in the evening.
- Reports: a day's report printable as PDF; manpower and equipment histograms by week; delays by cause.
- **Permissions:** the team writes; `dsr.acknowledge` for leads.
- **Tests:** a day built up over several saves, submitted, corrected; histograms worked by hand; a browser test at a
  phone viewport.

### Step 8: Project documents (R7)

**Goal:** a project's documents and drawings, reusing Wave 1's document store.

- A project gets its own folder tree in `doc` (as a tender has), created with the project; tender documents stay with
  the tender and can be **linked** (not copied) into the project.
- **Drawings register:** drawing number, title, discipline, revision, status (for information, for approval, for
  construction, superseded), received from and on; uploading a new revision supersedes the old one, which stays
  readable and marked. Transmittals and formal review cycles are Wave 5 (D1, D3); this step is the register.
- Attachments from procurement land here: quote documents for a project's enquiries (closing the step 3 gap),
  challan photos and test certificates on receipts (step 5).
- **Tests:** register with three revisions; superseded marking; a receipt's challan photo; access kept to the team.

### Step 9: Procurement reports

- **Requisition to order to receipt:** per requisition line, what was ordered, received and is outstanding, with
  ageing.
- **Open orders:** what is owed, by supplier and by promised date (late deliveries highlighted).
- **Material reconciliation:** budget (step 2) vs requisitioned vs ordered vs received vs issued vs in stock, by
  resource, with the theoretical consumption from measured work (norms × measured quantities) against actual issues:
  [Certain] the wastage figure every contractor asks for.
- **Supplier performance:** on-time delivery, rejection rate, price against the enquiry's L1.
- Each exportable to Excel and printable; added to the dashboards picker.
- **Exit criterion for Wave 2b:** a pilot site runs a month of purchasing and stores on it.

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
- **[Certain] Quote documents on a project's enquiry** were missing here; step 8 files them in the project's documents.

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

## Step 4 delivered: purchase and work orders

**Journey:**
- An enquiry's comparative statement (a project's) has **Make purchase orders** (or work orders): a **draft order for
  each supplier chosen**, with the lines chosen for them at the rate **before GST** and the GST rate they quoted,
  delivered to the requisitions' site. Lines already on a live order are left out, so pressing it twice orders
  nothing twice; once an order is cancelled its lines can be ordered again.
- A project's page has **Orders**: the list, and **New order** (purchase or work, to a vendor or subcontractor from
  the party master) for one written directly.
- On the order: the site it is delivered to (the **place of supply**), deliver-by date, payment, delivery and other
  terms, and lines (from the rate library or typed in) with HSN/SAC, unit, quantity, rate before GST and GST %. The
  page shows **before GST, CGST + SGST or IGST, and the total with GST** as you type, worked out the same way as the
  server. Buyer and supplier with their GSTINs head the page; **Print** prints it.
- **Submit for approval** sends it under the approval rules for **purchase_order** (Settings → Approval rules), for its
  total with GST. With no rule for that amount it is in force at once; either way it is then **Issued** (PO/2026-27/…,
  work orders WO/2026-27/…, per company and financial year).
- **Acknowledged**: the supplier's acceptance (date, their reference) is recorded.
- **Amend** (with a reason): a copy of the revision in force to change and submit; it is approved for **what it adds**
  to the order in force (an amendment that takes away is approved for ₹0 where a rule applies from ₹0). Until then
  the earlier revision stays in force; once in force, the earlier one is superseded and the supplier is to
  acknowledge again. An amendment can be thrown away.
- **Cancel** (with a reason, at any stage: a revision waiting for approval is withdrawn) or **Close** when done.
- **Orders** in the menu: the register across the projects you are on, by status. "Stores" stays coming (steps 5-6).
- The approver sees the order, the supplier and GSTIN, the place of supply and GST basis, the lines with tax, and for
  an amendment the total in force against the new one.

**Who does what:** the project's team reads its orders; others do not see them. Writing, amending, acknowledging,
cancelling and closing need the new **`purchase.edit`** right (managers yes, workers no by default, as for `rfq.edit`)
and a place on the team as lead or member (or the right to edit projects).

**Decisions made while building (change any you disagree with):**
- **[Certain] GST is added on top**, per line and rounded to the paisa as an invoice shows it; within a state the rate
  is split in half for CGST and SGST, each half rounded (3 × ₹33.33 at 5% is ₹2.50 + ₹2.50).
- **[Certain] No place of supply, no order**: an order cannot be submitted without a site, or with a site that has no
  GST state code (set it on the project's page). A supplier without a GSTIN charges no GST, whatever rate was typed.
- **[Likely] The buyer's GSTIN is the company entity's**: a contractor registered in more than one state (one GSTIN
  per state) would order for a site in another state from that state's registration; per-state registrations wait
  until someone needs them.
- **[Likely] Revision 0 is never thrown away**: a draft order that is not wanted is cancelled, so its number stays on
  the record with a reason (no gaps in the series).
- **[Likely] Orders are not checked against the material budget** yet: the requisition is (step 2), and the
  procurement reports (step 9) compare ordered and received against it.
- **[Guessing] Supplier acknowledgement is recorded, not collected**: the app does not email (docs/03-architecture.md
  §6), so it is typed in from their letter or email.

**API** (under `/api/tenant`): `GET /orders?projectId&status` (`open` = draft, issued, acknowledged);
`POST /projects/:id/orders` (`{kind, partyId, siteId, deliverBy, paymentTerms, deliveryTerms, otherTerms, lines}`);
`POST /rfqs/:id/orders` (from the vendors chosen); `GET /orders/:id`; `GET /order-revisions/:id` (the order of a
revision, for an approval's link); `POST /order-revisions/:id` (change a draft or rejected revision, with
`rowVersion`), `/submit`, `/discard`; `POST /orders/:id/amend` (`{reason}`), `/acknowledge` (`{on, reference}`),
`/cancel`, `/close` (`{reason}`). Approval document type `purchase_order`. Migration `0031_purchase_orders.sql`.

**Tests:**
- 5 API integration tests, the GST worked by hand: a purchase order within Maharashtra (cement 100 × ₹390.50 and steel
  1.235 t × ₹62,000 at 18%: ₹1,15,620.00 + CGST ₹10,405.80 + SGST ₹10,405.80 = ₹1,36,431.60), refused without a site
  and with a site without a state code, a worker without `purchase.edit` refused, approved under a ₹1 lakh rule for
  its total; acknowledged (not for a future date); amended to 120 bags (₹1,45,647.40, adding ₹9,215.80, in force at
  once, to be acknowledged again), an amendment discarded, revision 0 not discardable, closed; a Gujarat
  subcontractor's work order (WO series) with IGST ₹8,100 on ₹45,000, paisa rounding, an unregistered supplier with
  no GST, a cancelled order, the open register; orders made from an enquiry (cement at 28% within the state, sand at
  5% from Gujarat, both to the requisition's site), nothing ordered twice, re-ordered after a cancel; kept to the
  team, the project's activity.
- A browser test: a supplier with a Maharashtra GSTIN, a project with a site in state 27, a new order: 100 bags at
  ₹390.50 shows ₹39,050.00 + CGST ₹3,514.50 + SGST ₹3,514.50 = ₹46,079.00 as typed; submitted and issued, the same
  totals on the order; acknowledged; amended to 120 bags (₹55,294.80), in force, the acknowledgement cleared, the
  earlier revision superseded; in the orders register.

## Step 5 delivered: goods receipt and inspection

**Journey:**
- An issued purchase order has **Receipts**: each line ordered, accepted, on hold, rejected (and whether it went
  back) and **still owed**; its receipts; and **Receive goods**.
- A receipt (GRN/2026-27/…) records the date, the site (the order's by default), the supplier's **delivery challan**
  (number and date), vehicle and invoice numbers, and for each line what came. A line is **accepted at the gate**
  (less anything rejected there, with why: burst bags) or **held for inspection** (steel for a bend test, cubes for
  concrete). **Everything still owed** fills in the rest of the order.
- On the receipt, a held line is **inspected**: accepted and rejected (with why), which must add up to what came.
- **Return rejected goods**: what goes back to the supplier (RTV/2026-27/…), with the gate pass or debit note and why;
  no more than was rejected and not yet returned.
- **Rejected goods are still owed**: they do not count against the order, so the supplier sends replacements.
- When every line has come and been accepted (nothing on hold, no amendment being worked on) the order **closes
  itself** ("Received in full"). A receipt made in error is **cancelled** with a reason (not once something from it
  went back): what it recorded is owed again and an order it closed reopens.
- **Goods receipts** in the menu: the register across the projects you are on, or those waiting for inspection.
  Receipts print as the gate record.

**Who does what:** the project's team reads its receipts. Receiving, inspecting, returning and cancelling need the new
**`stores.receive`** right (**managers and workers** by default: the storekeeper on site is usually a worker) and a
place on the team as lead or member.

**Decisions made while building (change any you disagree with):**
- **[Certain] Nothing beyond what is still owed**: receiving more than the order (a lorry with 105 bags, steel over
  by weight) is refused with "amend the order", so an excess is approved like any other change to the order. Say if
  you want a tolerance (say 2% for steel by weight) instead.
- **[Certain] An amendment cannot ask for less than came**, nor drop a line something came for; and an order with
  receipts cannot be cancelled, only closed.
- **[Certain] Order lines keep a key through amendments**, so a receipt stays on "the cement line" whatever the
  amendments did to positions. Lines written in step 4 were given keys by position (migration 0032).
- **[Likely] Work orders are not received**: work is measured and billed (Wave 3), so receiving is for purchase orders.
- **[Likely] A receipt is recorded once, not drafted**: what came is a fact at the gate; a mistake is cancelled with a
  reason and recorded again.
- **[Certain] Accepted goods are not stock yet**: the stock ledger, issues to work and valuation are step 6, which
  takes accepted receipts as its first entries. Challan photos and test certificates wait for project documents
  (step 8).

**API** (under `/api/tenant`): `POST /orders/:id/receipts` (`{receivedOn, siteId, challanNo, challanDate, invoiceNo,
vehicleNo, notes, lines: [{lineKey, qty, rejected, reason, hold}]}`); `GET /receipts?projectId&held`;
`GET /receipts/:id`; `POST /receipts/:id/inspect` (`{lines: [{position, accepted, rejected, reason}]}`),
`/returns` (`{returnedOn, reference, reason, lines: [{position, qty}]}`), `/cancel` (`{reason}`). An order carries
`progress` (by line: ordered, accepted, onHold, rejected, returned, outstanding), `receipts` and `mayReceive`; its
lines carry `lineKey`. Migration `0032_goods_receipts.sql`.

**Tests:**
- 4 API integration tests, worked by hand: 60 bags with 2 burst at the gate and 0.5 t of steel held (cement 58
  accepted, 42 still owed; steel 0.735 owed); refused: off the team, a work order, a rejection without a reason, a line
  twice, more than ordered, a future date, 43 bags when 42 are owed; the steel inspected (0.49 not adding up to 0.5
  refused, then 0.45 + 0.05), its line not held refused; returns (3 bags when 2 were rejected refused, then 2 bags and
  0.05 t), a receipt with returns not cancellable; an amendment to 50 bags or without the steel refused, the order not
  cancellable; the rest received to the store yard, the order closed and further receipts refused; the receipt
  cancelled, 42 bags owed again and the order reopened; the project's activity; a viewer reads but cannot receive.
- The permission lists include `stores.receive`.
- A browser test: an order for 100 bags and 1.235 t; 60 bags (2 burst) and the steel held; inspected (1.2 t passes,
  0.035 t bent); both rejections returned (RTV); the order shows 42 bags and 0.035 t owed; the rest with "Everything
  still owed": the order closes itself; two receipts in the register.

## Step 6 delivered: inventory

**Journey:**
- The first receipt at a site makes its store ("Risod sump store"); a project's page has **Stores** (value, materials,
  how many below their reorder level), **New store** for a second one at a site (the receive form then asks which),
  and **Consumption**. **Stores** in the menu lists them all; it also shows the valuation method, which the admin
  chooses there until the first stock moves.
- **Receipts in:** every accepted line of a library material goes into the receipt's store at the **order rate
  before GST**; held goods go in when accepted on inspection. Typed-in lines are received but **not stocked**, and
  the receipt says so.
- The store page: each material's quantity, average rate, value and reorder level, its **ledger** (every movement
  with the running balance and value, each linked to its document), recent movements, transfers in transit.
- **Issue** (ISS/2026-27/…): to a WBS element (and a contract BOQ item if given), taken by whom and for what, valued
  at the store's cost. An issue slip prints.
- **Back from site:** unused material returns against its issue at what it went out at; never more than is out.
- **Transfer** (TRN/…): out of one store at its cost, **in transit** (in neither store), then received at the other
  end (same project or another) at the same value; cancelled while in transit, it goes back where it came from.
- **Stock take** (STK/…): counts against the book, with why; submitted under the approval rules for
  `stock_adjustment`, for the value of the differences; posted as adjustments once approved.
- **Reorder levels** per store and material; "Requisition for what is short" makes a draft requisition at the store's
  site for each material below its level, up to the level.
- **Consumption** per project: per material the budget in force, received, issued (net of returns) and its value,
  budget left, in its stores; and issued by WBS element.

**Who does what:** the team reads; **`stores.receive`** (managers and workers) also issues and takes returns from site
and receives transfers; the new **`stores.manage`** (managers) sets up stores and reorder levels, sends transfers and
counts stock. Your three questions before step 6 were answered with the plan's defaults (weighted average by default;
a WBS element required and a BOQ item optional; workers may issue). Say if any should change.

**Decisions made while building (change any you disagree with):**
- **[Certain] The ledger is insert-only** for the app (no update or delete), with the balance kept beside it in the
  same transaction; a test checks they agree.
- **[Certain] FIFO** is a tenant-wide choice before the first movement, then fixed; FIFO keeps lots, the average does
  not.
- **[Likely] A cancelled receipt takes out what it brought in** (its own value under the average, its own untouched
  lot under FIFO), so it leaves nothing behind in the store's value; refused if there is not that much left (or,
  under FIFO, if its lot has been used).
- **[Likely] A count's difference is against the book when each line was counted**, and posts as that difference
  once approved, even if stock moved in between (those movements are real). Losses are valued as an issue would be,
  gains at the cost when counted.
- **[Likely] Values come out at posting time:** a back-dated issue is valued at the store's cost when it is entered,
  and the ledger lists movements in the order entered.
- **[Certain] Bins (locations inside a store) are not built.** The plan made them optional; they add a dimension to
  every movement and most sites will not use them. Say if a pilot needs them.
- **[Likely] No table lock when setting the valuation method:** the app's database role cannot lock the insert-only
  ledger, and setting it is a one-time admin action before any stock exists.
- **Not yet:** receipts, issues and counts post to the ledger of accounts in Wave 3 (GRN clearing and material
  consumption); e-way bills for transfers are Wave 3 step 6.

**API** (under `/api/tenant`): `GET|POST /stock/valuation`; `GET /stores?projectId`; `POST /projects/:id/stores`
(`{siteId, name}`); `GET /projects/:id/consumption`; `GET /stores/:id`; `GET /stores/:id/ledger/:resourceId`;
`POST /stores/:id/reorder` (`{resourceId, level}`), `/reorder-requisition`, `/issues` (`{issuedOn, wbsCode, issuedTo,
purpose, lines: [{resourceId, qty, boqCode}]}`), `/transfers` (`{toStoreId, sentOn, note, lines}`), `/counts`
(`{countedOn, notes, lines: [{resourceId, counted, reason}]}`); `GET /issues/:id`, `POST /issues/:id/returns`;
`GET /transfers/:id`, `POST /transfers/:id/receive|cancel`; `GET|POST /stock-counts/:id`, `/submit`, `/discard`.
A receipt takes `storeId` and carries `store` and each line's `stocked`. Approval document type `stock_adjustment`.
Migration `0033_inventory.sql`.

**Tests:**
- 5 API integration tests, every value by hand. Weighted average: 100 bags at ₹390 and 50 at ₹402 (150, ₹59,100); 60
  issued to SUB (₹23,640); 30 at ₹410.50; 45 to SUP (₹17,915.63, rounding 17,915.625 up); 5 back (₹1,990.63); an unknown
  WBS element and 91 bags out of 90 refused; the valuation method refused once stock moved; the typed-in line not
  stocked. The ₹410.50 receipt cancelled (50 bags, ₹19,535); a worker refused a store; a second store; 20 bags in
  transit (₹7,814) then received, received twice refused; 10 sent and cancelled. A count of 28 against 30 (₹781.40),
  approved under a ₹500 rule and posted; a second open count refused; reorder at 40 and a requisition for 12. The
  consumption (received 150, issued 100 for ₹39,565, 48 in stock for ₹18,753.60: 59,100 = 39,565 + 781.40 +
  18,753.60), by WBS; the ledger's eleven movements and running balance; ledger equals balance; off the team, nothing.
  FIFO on a second tenant: 120 out of lots at ₹390 and ₹402 (₹47,040); the partly used lot's receipt not cancellable;
  40 out of the ₹402 and ₹410.50 lots (₹16,165).
- A browser test: cement from the library ordered and received into the site's store (₹39,000); 40 issued to the
  substructure (₹15,600); 5 back (65, ₹25,350); reorder at 80 and a requisition for 15; a stock take of 63 posted
  (−₹780); the ledger; the consumption (35 issued, ₹13,650).

## Step 7 delivered: daily site reports

**Journey:**
- A project's page has **Daily site reports**: "Today at <site>" for each active site (opens today's report, or starts
  it), the days of the last two weeks with no submitted report (each a link to write it), the latest reports, and
  "All reports and weekly figures".
- **The report**, one per site per day (a past day too, never a future one), in one column for a phone:
  weather morning and afternoon and hours of rain; **manpower** by trade, our own or a labour contractor's; **equipment**
  own or hired, hours worked, hours idle and why; **work done** (description, BOQ item, quantity), the site's own
  account (the measurement book stays what is billed); **hindrances** (cause, what happened, hours lost, on whose
  account: the client's, ours, or neither); safety, visitors and notes; **photos**.
- **Started from yesterday:** a new report carries over the site's last crew and plant (hours blank), to change rather
  than type again.
- **Received today** and **Issued to work today** come from the day's goods receipts at the site and issue slips from
  its stores, linked, not typed again.
- **Saved as you go:** each change is kept on the phone at once and saved a moment later; with no signal the page says
  so and saves when the signal returns; changes kept on the phone survive closing the page, and are dropped (with a
  notice) only if someone else saved the report since. A second phone with an old copy is told, never overwrites.
- **Photos** from the camera, shrunk on the phone to at most 1600 px (JPEG) before upload; JPEG, PNG or WebP up to
  8 MB; kept in the tenant's file store.
- **Submit**, then the lead **acknowledges**; a submitted or acknowledged report is changed only by **Correct**, with a
  reason, which puts it back to draft; the history shows each step. Prints as the day's report.
- **Reminder:** submitting a report sets a reminder in the submitter's inbox for 7 pm (India) the next day for the
  same site; submitting the next report before then replaces it.
- **Weekly figures** (last eight weeks, submitted reports only): man-days by trade and equipment hours worked and idle
  as charts, hindrance hours by cause and account as a table.
- **On a phone the main menu folds** behind a "Menu" button (for every screen, not only reports).

**Who does what:** the project's team (lead or member, or those who edit projects) writes, submits and corrects;
acknowledging needs the new **`dsr.acknowledge`** right (managers by default) and the lead's place (or the right to edit
projects). Viewers read.

**Decisions made while building (change any you disagree with):**
- **[Certain] Online only**, as planned: kept on the phone and saved when the signal returns, but the page must have
  been opened with a signal. Offline-first is Wave 6.
- **[Likely] The day's materials are read live** from receipts and issues, not copied into the report: a receipt
  cancelled later disappears from that day's report.
- **[Likely] Work done names a BOQ item, not a schedule activity.** Activities live in a project's several
  schedules; linking to them waits until a pilot shows how sites name their work.
- **[Likely] Missing days count every calendar day** from the site's first day on the project (Sundays and holidays
  too), for the last two weeks; site calendars can narrow this later.
- **[Certain] Photos are hidden, not deleted,** when removed from a draft; the documents' clean-up now also keeps any
  file a photo uses.
- **[Guessing] The reminder is to the person who submitted the last report** for the site, as the nearest thing to a
  site in-charge (the app has no such role yet).

**API** (under `/api/tenant`): `GET /projects/:id/daily-reports?siteId` (reports, missing days, mayWrite);
`GET /projects/:id/daily-reports/summary?from&to`; `POST /projects/:id/daily-reports` (`{siteId, reportDate}`; an
existing one answers `report_exists` with its id); `GET|POST /daily-reports/:id` (the sections with `rowVersion`);
`POST /daily-reports/:id/submit|acknowledge|correct`; `POST /daily-reports/:id/photos?caption` (multipart),
`GET /daily-reports/:id/photos/:photoId`, `POST /daily-reports/:id/photos/:photoId/remove`. Migration
`0034_daily_reports.sql`.

**Tests:**
- 5 API integration tests: a day's report built over saves (an old copy refused as stale), refused for a future day and
  for a viewer, the same site and day answering with the existing one, the day's receipt (100 bags) and issue (10 to
  SUB) on it; a photo stored and read back byte for byte, a text file refused; submitted, editing and photos refused,
  acknowledging refused to a worker and done by the lead, corrected without a reason refused, then with one, changed
  and resubmitted (four history entries); Tuesday carried forward from Monday; the missing days (today only, then
  none); tomorrow's 7 pm reminder; weekly figures by hand (masons 4, then 6 + 8; helpers 10 + 10; the mixer 6 + 5 hours
  worked, 2 idle; drawings 4 h on the client, rain 3 h, power 2 h); kept to the team.
- A browser test at a phone's size: the menu folded; today's report built section by section and saved; the signal cut
  while typing ("No signal") and restored ("Saved"), the notes still there after a reload; a photo; submitted,
  acknowledged, corrected with a reason and resubmitted; the reports and weekly figures.

## Step 8 delivered: project documents

**Journey:**
- A project's page has **Documents and drawings**, kept to its team. Two tabs:
  - **Drawings register:** add a drawing (number, title, discipline). Each revision is uploaded with its label ("P1",
    "R0"), purpose (for information, for approval, good for construction), who it came from and when. The register
    shows each drawing's current revision. A drawing's card lists every revision, newest first, the earlier ones marked
    **Superseded** and each still downloadable.
  - **All documents:** Wave 1's vault, for the project: folders, uploads with versions, preview, tags, trash, ZIP.
    For a project made from a won tender, a note links to the tender's documents, which stay with the tender.
- **Each drawing is one document** in the vault, under "Drawings/<Discipline>", named "<number> <title>". Each
  revision is a new version of it, so the vault's own version history is the revision history.
- **A goods receipt** has **Challan and certificates**: files attached there are kept under "Receipts/<GRN number>" and
  linked to the receipt.
- **A project's enquiry** now takes vendors' quote documents, as a tender's does. They are kept in the project's
  documents, in the quotes folder when it has one. This closes the step 3 gap.
- **Search** (the Documents page) finds project documents too, for the projects the user sees, and each result says
  whether it belongs to a tender or a project.

**Who does what:** the project's team reads its documents. Uploading, foldering and the drawings register need the
team's lead or member place (or the right to edit projects) and `documents.edit`. Viewers read. Restricted folders work
as in Wave 1.

**Decisions made while building (change any you disagree with):**
- **[Likely] No folder tree is made with the project.** "Add the standard folders" on the vault does it, as for a
  tender; the drawings and receipts folders are made when first needed.
- **[Certain] Tender documents are linked, not copied:** the project's vault shows a link to the tender's documents.
- **[Likely] A revision's status is its purpose plus superseded.** "Superseded" is not a purpose that can be chosen; it
  is set when the next revision arrives. Transmittals and review cycles stay Wave 5.
- **[Likely] A revision whose file is the same as the current one is refused** (`same_file`), as is a revision label
  used before on the drawing (`revision_exists`) and a date in the future.

**API** (under `/api/tenant`): the tender vault's routes for a project:
- `GET /projects/:id/documents`, `GET /projects/:id/documents/trash`.
- `POST /projects/:id/folders`, `POST /projects/:id/folders/standard`.
- `POST /projects/:id/documents/upload` (multipart; `folderId`, `documentId`, `path`).
- `POST /projects/:id/documents/zip`, `POST /projects/:id/documents/trash/empty`.
- `GET /documents?projectId`.

Drawings:
- `GET|POST /projects/:id/drawings` (`{number, title, discipline}`), `GET /drawings/:id`.
- `POST /drawings/:id/revisions?revision&purpose&receivedFrom&receivedOn&note` (multipart).

Links take the kind `goods_receipt`. A receipt returns its `documents` and `mayAttach`. Migration
`0035_project_documents.sql`: folders, documents, links and purged documents belong to a tender or a project (exactly
one), plus `proj.drawing` and `proj.drawing_revision`.

**Tests:**
- 4 API integration tests:
  - A project's vault kept to its team: folders, uploads, versions, search scoped to the projects the user sees.
  - The drawings register. P1, then R0 good for construction: one document under "Drawings/Structural" with two
    versions, P1 superseded and still readable. A repeated label, the same file and a future date are refused, and the
    register is refused to someone off the team.
  - A challan linked to a goods receipt and a quote to the project's enquiry; a link across owners is refused.
  - A project document purged from the trash for good.
- A browser test (with step 9): a challan attached to a receipt; drawing A-101 with R0 for approval, then R1 good for
  construction (R0 superseded and downloadable); the vault holding the drawing and the challan in its folders.

## Step 9 delivered: procurement reports

**Journey:**
- A project's page has **Procurement reports**, each on screen and as **Excel**:
  - **Requisition to order to receipt:** each line of the approved requisitions shows what was asked of vendors, what
    was ordered and received against it, and what is still to come. It also shows the stage (not asked, asked, partly
    ordered, ordered, partly received, received), the enquiries and orders, the needed-by date with "Late" past it,
    and the days open since approval. When one enquiry line asks for several requisitions' lines, what was ordered and
    received against it is shared among them in requisition order.
  - **Open orders:** what suppliers still owe on issued purchase orders, line by line, valued at the order rate before
    GST, with the days late past the delivery date, and totals by supplier.
  - **Material reconciliation:** material by material, from the approved material budget through requisitioned,
    ordered, received, issued (less returns from site) to in stock. Against the issued quantity it sets what the
    measured work should have taken: each BOQ item's measured quantity times the budget's norm per unit. Issued minus
    that is the **wastage**, as a quantity and a percentage.
  - **Supplier performance:** orders and their value with GST, receipt lines, **on time** (receipts on or before the
    order's date), **rejected** (by value at the order rate) and **above the lowest quote** (what was paid against the
    lowest rate quoted before GST on the same enquiry lines; a GST-included quote is divided out).
- **Procurement reports** in the main menu: open orders and supplier performance across the projects the user sees
  (every project for admins and those who see all projects).

**Decisions made while building (change any you disagree with):**
- **[Likely] Not added to the dashboards picker.** The dashboards are built for tenders and estimates: financial year,
  vertical and owner filters, with KPI tiles over tenders. A procurement dashboard needs its own filters (project,
  supplier, period) and is better shaped by a month of pilot data. The reports are on screen and in Excel; the browser
  prints them.
- **[Certain] Rejection counts the gate and inspection**, by value, and goods held for inspection count as received
  for what is owed (they are on site), not as accepted.
- **[Likely] Wastage needs norms and measurement:** a material with no norm on a measured item shows no wastage rather
  than 100%. Typed-in order lines (no library resource) are not in the reconciliation.
- **[Likely] Lowest quote means every quote on the enquiry line,** including vendors not chosen, so the figure shows
  what choosing another supplier cost.

**API** (under `/api/tenant`), each with `?format=xlsx` for Excel:
- `GET /projects/:id/reports/requisitions`
- `GET /reports/open-orders?projectId`
- `GET /projects/:id/reports/materials`
- `GET /reports/suppliers?projectId`

No migration.

**Tests:**
- 2 API integration tests, every figure worked by hand:
  - Raft (200 bags needed by 1 October) and Columns (100 bags) share one enquiry line. 300 bags are ordered and 145
    accepted, so Raft takes 200 ordered and all 145 received (partly received, late) and Columns takes 100 ordered
    (ordered). The sand has all come.
  - 155 bags still owed, ₹59,675.00, late since 3 October.
  - Materials: 300 requisitioned and ordered, 145 received, 110 issued (120 less 10 back), 35 in stock. Measured: 50 at
    1.8 and 20 at 0.5, so 100 bags should have gone and 10 were wasted (10.0%).
  - Suppliers: Vidarbha ₹1,47,840.00, one of two receipts on time (50.0%), 5 of 150 bags rejected (3.3%), and 1.3%
    above Akola's GST-included lowest quote (₹448.40 / 1.18 = ₹380). Surat: ₹17,850.00, all on time, at the lowest.
  - The same as Excel, numbers as numbers.
  - Access: a worker off the team gets no project reports and empty company-wide ones; on the team, they see them; the
    admin sees every project's.
- The browser test (with step 8): 40 bags still owed, ₹15,600.00; downloaded as Excel; company-wide from the menu.

**Wave 2b exit criterion:** a pilot site runs a month of purchasing and stores on it. All nine steps are built; the
pilot has not run yet, so the criterion is not met.
