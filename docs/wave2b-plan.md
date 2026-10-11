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
