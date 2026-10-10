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
- **[Likely] Material demand will come from the tender's rate analyses** (step 2): the contract BOQ was copied as
  values (2a step 2), but each line keeps the tender line's key, so its analysis (cement, steel, labour per unit) can
  be followed back. Decide before step 2 whether that is how you budget materials, or whether you keep a separate
  material budget.
- **[Guessing] GST on purchase orders** (step 4) waits on the open question from 2a step 2: whether contract values
  are entered with or without GST. Purchase GST itself is clear (CGST + SGST within the state, IGST across states,
  from the site's state and the vendor's GSTIN).

## Steps

| # | Step | Features | Notes |
|---|------|----------|-------|
| 1 | **Approvals + purchase requisitions** (P5, R1) | Approval rules by document type, levels by amount, approvers (project lead, managers, admins, a named person), delegation while away, comments, withdraw, "waiting on me"; requisitions for a project (materials from the rate library or typed in, quantities, needed-by dates, BOQ line and WBS element) as its first user | **Done** (see below) |
| 2 | **Material budget and demand** (R1) | Resource quantities from the tender's rate analyses through line keys; requisitions from BOQ items and the look-ahead; requisitioned against budget | |
| 3 | **Vendor enquiries for a project** (R2) | Wave 1's RFQs and comparative statements for requisitioned materials | |
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
