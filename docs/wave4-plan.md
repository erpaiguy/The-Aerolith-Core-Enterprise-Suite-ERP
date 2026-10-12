# Wave 4 Build Plan: Control

Scope: docs/04-features.md W4 (C1-C6). docs/01-mvp.md exit criterion: **planned vs actual vs forecast per project**.

**Planned before Waves 2b and 3 are built.** [Likely] Control is only as good as the actuals feeding it: committed
cost from orders (Wave 2b), actual cost from bills, issues, payroll and equipment (Wave 3), progress from the
measurement book (Wave 2a). If those are thin on a pilot, Wave 4's numbers are thin too. Each step is re-read with you
before it starts.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Read this first

- **[Certain] Wave 4 mostly computes from data other waves record.** Its new records are variations, contracts and
  claims, risks and forecasts; everything else is reporting over budget, commitments, actuals and progress.
- **[Certain] One cost breakdown everywhere:** the WBS and cost codes from Wave 2a step 3. Budget lines, order lines,
  bill lines, issues, payroll and equipment costs all carry a WBS element and cost code, or they cannot be
  controlled. Waves 2b and 3 are built to record them; Wave 4 refuses to guess.
- **[Certain] The documents disagree on offline:** docs/03-architecture.md §11 says "revisit an offline-capable
  mobile/PWA in Wave 4"; docs/04-features.md puts the mobile app (G4) in Wave 6. **Proposal:** keep it in Wave 6;
  Wave 4 stays online-only. Say if site connectivity on the pilot forces it earlier.
- **[Likely] The MEP vertical pack** (docs/04-features.md §V placed it in W4) is configuration (system-wise BOQ
  templates, equipment schedules, testing and commissioning checklists on Wave 3's quality module); it is step 7.

## Decisions proposed at the start (change any you disagree with)

- **[Certain] Committed cost** = approved orders and work orders not yet billed, plus approved bills; **actual cost**
  = posted bills, stock issues, payroll and equipment charges. Nothing is counted twice: an order's value moves from
  committed to actual as it is billed.
- **[Likely] The control budget is the cost BOQ from Wave 2a step 2 plus approved variations' cost**, revised by a
  budget revision under approval (as the material budget is, Wave 2b step 2). The material budget is a part of it.
- **[Likely] Earned value uses the measurement book**, not a percentage typed by hand: EV = measured quantity ×
  budget rate, per WBS element; PV comes from the baseline schedule with cost loaded from the budget.
- **[Certain] Variations change the contract BOQ by a new revision** (Wave 1's revisions on project BOQs, Wave 2a),
  so billing (Wave 3 step 2) bills approved extra items and changed quantities without special cases.

## Steps

| # | Step | Features | Depends on |
|---|------|----------|------------|
| 1 | **Cost control** | Budget vs committed vs actual by WBS and cost code, cost-to-complete, cost forecast | Waves 2b, 3a |
| 2 | **Cash flow** | Planned and forecast inflow (billing plan) and outflow (commitments, payroll, plant), actual from the ledger | step 1, Wave 3 step 8 |
| 3 | **Earned value** | PV, EV, AC, SPI, CPI, EAC by method, S-curves | step 1, Wave 2a steps 4-6 |
| 4 | **Variations and change orders** | Requests, pricing, client approval, contract BOQ and budget revision, schedule impact | Wave 2a, step 1 |
| 5 | **Contracts and claims** | Contract register, clauses and obligations calendar, notices, extension of time, claims | Wave 2b step 7 |
| 6 | **Risk register** | Risks with probability and impact, owners, mitigation, contingency drawdown | step 1 |
| 7 | **Portfolio dashboards and MEP pack** | Company-wide planned vs actual vs forecast; MEP templates | steps 1-6 |

## Step 1: Cost control (C1)

- Per project, by WBS element and cost code: **original budget, approved changes, current budget, committed,
  actual, cost to complete, forecast at completion, variance**. Cost to complete is entered per element by the
  project team (with a default of remaining budget, or remaining quantity × current rate) and kept as a monthly
  snapshot, so forecasts can be compared month to month.
- Drill-down from any figure to the documents behind it (orders, bills, issues, payroll lines).
- Alerts: commitment beyond budget on a cost code; actual rate above budget rate on a resource.
- **Tests:** a worked project with orders, bills and issues across three cost codes; the order-to-bill move between
  committed and actual; monthly snapshots.

## Step 2: Cash flow (C1)

- **Inflow:** a billing plan from the schedule's measured progress forecast and the contract's payment terms
  (certification and payment delays, retention), against actual receipts.
- **Outflow:** commitments by their payment terms, payroll, equipment hire, overheads; against actual payments.
- Company-level cash flow across projects, by week and month, for the next months.
- **Tests:** a project's cash flow worked by hand for six months.

## Step 3: Earned value (C2)

- PV from the baseline schedule (Wave 2a step 4) cost-loaded by the budget; EV from measured quantities × budget
  rates; AC from step 1's actuals; all by WBS element and rolled up.
- SPI, CPI, schedule and cost variance; EAC by the usual methods (budget at completion / CPI, AC + remaining at
  budget, AC + remaining / (CPI × SPI)) shown side by side, the team choosing one as the forecast.
- S-curves of PV, EV and AC (ECharts, as Wave 2a step 7).
- **Tests:** a worked example with known SPI and CPI; a re-baselined schedule.

## Step 4: Variations and change orders (C3)

- A **variation request**: from a client instruction, a site condition, a design change (Wave 5 transmittals and
  RFIs link here later), with the reason and evidence.
- **Pricing:** new items priced with rate analyses (Wave 1), changed quantities at contract rates or new rates;
  cost impact (budget) and value impact (contract) separately, and the schedule impact (activities added or
  extended, Wave 2a).
- Internal approval (`variation`), then the **client's approval** recorded (reference, date, approved value, often
  different); approved variations make a new **contract BOQ revision** and a **budget revision**, and can be billed.
- Register: requested, priced, submitted, approved, rejected, executed but not approved (the risky ones).
- **Tests:** a variation with a new item and a changed quantity, approved for less; the contract BOQ revision and the
  next RA bill.

## Step 5: Contracts and claims (C4)

- **Contract register:** client contract and major subcontracts, key dates, value, securities (performance bank
  guarantee, retention bond, insurance policies) with expiry reminders (Wave 1's tender securities extended),
  liquidated damages terms, defects liability period, payment terms.
- **Obligations calendar:** dated duties from clauses (notices within N days of an event, insurance renewals,
  guarantee extensions), with reminders.
- **Notices:** sent and received, with dates and deadlines for response.
- **Extension of time:** an EOT claim built from hindrances recorded in the daily site reports (Wave 2b step 7) by
  cause, linked to schedule activities; granted and rejected days recorded.
- **Claims:** for cost (idle resources, prolongation, escalation beyond the clause), with evidence from the records;
  status through negotiation and settlement.
- **Tests:** a guarantee expiry reminder; an EOT from three hindrances; a claim settled for less.

## Step 6: Risk register (C5)

- Risks per project and company: cause, event, effect; probability and impact (cost and time) on scales the tenant
  sets; owner; mitigation actions with due dates; status.
- Link to WBS elements, schedule activities and cost codes; contingency held in the budget and drawn down against
  risks that occur.
- Heat map and top risks on the project dashboard.

## Step 7: Portfolio dashboards and MEP pack (C6)

- Company dashboard across projects: margin forecast vs tender margin, SPI/CPI, cash position, overdue bills and
  receivables, open variations and claims; project tiles with drill-down (Wave 1 step 12's dashboard framework).
- **MEP pack:** system-wise BOQ templates (HVAC, electrical, plumbing, fire, ELV), equipment schedules,
  coordination and clash log, testing and commissioning checklists using Wave 3's quality checklists.
- **Exit check for Wave 4:** a pilot project's monthly review run from the app: planned vs actual vs forecast, cash
  flow, variations and the risk register.

## Step 1 in detail (planned before building)

**What was found first.** [Certain] The plan above says Waves 2b and 3 record a WBS element and cost code on every
cost. They do not:
- Orders, bills and ledger lines carry no WBS element.
- Every automatic posting leaves the ledger's cost code empty. Only manual journals carry one.
- WBS reaches procurement only through requisition lines, which reach orders through the RFQ line.

So step 1 decides where each cost belongs (**its charge**) by a fixed order of rules, and shows what it cannot place
instead of guessing:
1. An **allocation** made on the cost control screen, for an order line or a ledger line (`cost.forecast`).
2. A cost code typed on a manual voucher line.
3. For an order line, and for the bill lines and debit notes against it: the **requisition line** behind its RFQ line.
   That gives the line's WBS element, and the cost code its BOQ item is mapped to.
4. A **company default by source**:
   - For an order line, the kind of its resource (material, labour, equipment, subcontract, other). A work order
     counts as subcontract.
   - Payroll, equipment costing, BOCW cess, depreciation, and bills without an order each have their own default.
5. Otherwise the cost is **unallocated**. It is its own row, with its documents behind it.

**The figures**, per project, by WBS element and cost code, rolled up both ways:
- **Budget:** the project's live budget BOQs, line by line, through the BOQ line map.
  - The **original budget** is a baseline taken once: explicitly, or on the first month close.
  - The current budget less the original is **approved changes** (variations add to it in step 4).
- **Committed:** what is still open on approved orders. That is the approved revision's amount before GST, less
  what is billed on each line, never below zero. Closed and cancelled orders commit nothing more.
- **Actual:** the ledger, that is the project's lines on expense ledgers. Year-end and closing-stock entries are left
  out, so the total agrees with the project P&L (Wave 3 step 8) for the same dates. GST credit is not cost.
- **Cost to complete (CTC):** entered per row by planning (`cost.forecast`), with a note. Where nothing is
  entered, it is computed as the remaining budget or the open commitment, whichever is larger. A computed CTC is
  marked as computed.
- **Forecast at completion** = actual + CTC. **Variance** = current budget − forecast.
- **Month close** (`cost.forecast`) stores every row as it stands, and any past month can be compared with now.

**Alerts:**
- A cost code where actual plus committed is over its current budget.
- A resource billed at an average rate above its rate in the approved material budget.

**Drill-down:** any row lists the open order lines behind its commitment and the ledger lines behind its actual,
each with its document.

**Export:** the report as Excel.

**Rights:**
- Project members see the report.
- `cost.forecast` (new; managers on by default) enters CTC, allocates, sets the company defaults and closes months.

**Tests:**
- Unit tests:
  - The CTC default and the forecast.
  - The roll-up.
- An integration test, worked by hand. A project with budget lines mapped to three cost codes, plus:
  - Orders from requisitions.
  - A bill moving cost from committed to actual.
  - Payroll falling to the staff default.
  - A manual voucher with its cost code.
  - An unallocated bill line, then allocated.
  - CTC entered, the month closed, and compared.
  - Both alerts.
  - The total agreeing with the project P&L.
- A browser test: CTC entered, a line allocated, the month closed.

## Step 2 in detail (planned before building)

**What was found first.** [Certain] Nothing records when money is expected:
- No payment days or credit period, for clients or suppliers.
- Order payment terms are free text.
- No billing plan.

So step 2 adds **cash terms per project**, with defaults, and builds every expected date from them:
- Client certifies a bill 30 days after it is raised, and pays 30 days after certifying.
- Client deducts TDS at 2%.
- Suppliers are paid 30 days after delivery.
- Cost not yet ordered is paid 30 days after the work.

**Inflow, per project:**
- **Certified bills not fully received:** what is still owed, due at the invoice date plus the payment days. Anything
  already overdue counts as due now.
- **A submitted bill:** certified after the certification days, then paid after the payment days.
- **Work done but not billed** (earned at contract rates less what bills have claimed): billed at the end of this
  month, then certified and paid after the same delays.
- **Work still to do**, by month:
  - From the schedule's forecast dates (the S-curve of Wave 2a step 7) where activities are linked to the contract
    BOQ.
  - Otherwise, the remaining contract value spread evenly to the planned finish.
  - Each month's work is billed at the month end.
- **What a bill brings in:** value plus GST, less retention, advance recovery and the client's TDS, at the
  project's bill terms.

**Outflow, per project:**
- **Posted supplier bills not fully paid:** due on their due date. Anything already overdue counts as due now.
- **Open order balances** (step 1's committed) plus their GST: paid at delivery (the order's deliver-by date, or now
  if passed) plus the supplier days.
- **Cost not yet ordered:** step 1's cost to complete less the commitment, spread like the remaining work and paid
  after the cost days.

**Actual cash, per project:**
- **In:** client receipts, the cash share of each project's allocations.
- **Out:**
  - Payment runs paid.
  - Payroll paid, by each person's project days.
  - Labour wage sheets paid.
  - Manual payments with a project.

**Company view:**
- **Opening position:** the bank and cash balance as at the date.
- **Actual:** the bank and cash ledgers' movement, contras left out.
- **Forecast:**
  - Every project's flows.
  - Company overheads per month (a company setting, nothing by default).
  - **GST to the government:** output tax on expected bills less input tax on expected payments, paid on the 20th
    of the next month, with a credit carried forward.

**Periods:**
- By month: six months back, twelve ahead.
- By week: eight weeks back, thirteen ahead.
- An **as-of date** (today unless given), so a forecast can be read as it stood.

**Rights:**
- A project's cash flow: its team.
- The company's cash flow: `accounts.view`.
- Cash terms and the overheads: `cost.forecast`.

**Tests:**
- Unit tests:
  - Periods.
  - Dates moved by the terms.
  - Overdue becoming due now.
  - GST netted with a credit carried.
- An integration test: a project's cash flow worked by hand for six months, in and out. It covers:
  - A certified bill.
  - Unbilled work.
  - Remaining work spread to the finish.
  - A supplier bill.
  - An open order.
  - Uncommitted cost.
  - Actual receipts and payments.
  - The company view with the bank balance and GST.
- A browser test: cash terms changed and the forecast moving.

**[Guessing]** Retention release at the end of the defects liability period, and escalation, are left out of the
forecast for now. A finance person should say whether the defaults match the company's experience.

## Step 3 in detail (planned before building)

**Goal:** a project's schedule and cost performance from what is recorded, by month and WBS element, with forecasts
by the usual methods side by side.

**The three curves, cumulative, at budget value:**
- **EV (earned value):** the measurement book's quantities × each item's **budget rate**, the rate its budget line
  shares the contract line's key with, as the progress report's budget value (Wave 2a step 6) already works it.
  - [Likely] An item with no budget line falls back to its contract rate × the project's budget ÷ contract ratio.
- **PV (planned value):** the same budget value of each linked contract item, spread evenly over the **baseline**
  dates of the activities that carry it (Wave 2a steps 4 and 7), shared equally when several do.
  - Re-baselining moves PV, never EV or AC.
  - No baseline: PV is not shown and the indices are blank.
- **AC (actual cost):** step 1's actual, from the ledger, by date. By WBS element through step 1's charges; what is
  not on a WBS element stays at project level.

**At a date** (today unless given):
- BAC (the current budget).
- PV, EV and AC.
- Schedule and cost variance (SV = EV − PV, CV = EV − AC).
- SPI = EV ÷ PV and CPI = EV ÷ AC.
- Percent planned, done and spent.

The same figures are given by WBS element.

**EAC, side by side:**
- The CPI method (BAC ÷ CPI): the default chosen at the start of Wave 4.
- Remaining at budget (AC + BAC − EV).
- CPI × SPI (AC + (BAC − EV) ÷ (CPI × SPI)).
- Step 1's bottom-up forecast (actual + cost to complete).

The project chooses one (`cost.forecast`). ETC = EAC − AC; VAC = BAC − EAC.

**S-curves:** PV, EV and AC by month from the first date to the baseline finish, drawn with ECharts as the project
dashboard does.

**Rights:** the project's team sees it; `cost.forecast` chooses the method.

**Tests:**
- Unit tests:
  - Indices and the four EACs on a worked example (SPI 0.8, CPI 0.9).
  - Division by nothing blank.
- An integration test:
  - A budget, a schedule with a baseline and two activities linked to the contract BOQ, measurements and costs.
  - PV, EV and AC worked by hand at a date.
  - The project re-baselined and PV moving.
  - The chosen method.
- A browser test: the curves drawn and the method changed.

## Step 4 in detail (planned before building)

**What was found first.** [Certain] Contract BOQs are never locked once billed, nothing caps billing at the contract
quantity, and a new BOQ line cannot be given the key its budget line shares. So a variation changes the contract
BOQ and its budget in one transaction, keyed together, and the register shows work executed beyond what the client
has approved.

**A variation** (VO-001… per project):
- The title, the source (client instruction, site condition, design change, other), the client's instruction
  reference and the reason.
- The time it needs, in days, and the activities it extends.
- **Lines:**
  - **New items:** code, description, unit, quantity. Priced by a rate analysis (its cost rate on the date), or a
    typed cost rate. The contract rate defaults to the cost rate × the project's contract ÷ budget ratio (its
    markup), and can be typed.
  - **Changed quantities:** a contract BOQ line, plus or minus a quantity, at its contract rate and its budget rate.
  - Each line carries a **value** (contract) and a **cost** (budget) impact.
- **Statuses:**
  - Draft.
  - Pending (internal approval through the approval engine, as `variation`).
  - Submitted to the client.
  - Approved by the client, recorded with the reference, date and value. The client can approve lines at lower
    quantities or rates, so for less.
  - Rejected by the client.
  - Withdrawn.

**When the client approves:**
- **The contract BOQ:** new items are added under a "Variations" section, and changed quantities move. If the contract
  BOQ is frozen, this is a new revision: revised, changed, and frozen as an internal version labelled VO-001.
- **The budget BOQ:** the same lines at cost, sharing their keys, so cost control (step 1) shows the budget as
  approved changes.
- **The schedule:** the named activities are extended by the variation's days.
- The next **RA bill** then bills measured quantities of the new items and the moved quantities with no special
  case.

**Billing before approval:**
- A project setting allows billing variations while the client's approval is pending (some contracts permit it).
- With it on, lines go into the BOQs when the variation is submitted to the client. The client bill marks those lines
  as pending.
- If the client then rejects the variation:
  - Changed quantities go back.
  - New items with nothing measured are removed.
  - New items that were measured stay, flagged for a credit note.

**The register:**
- Every variation with its value, cost and approved value.
- Totals by status.
- **"Executed, not approved":** variations not yet approved by the client whose work has started. Work has started
  when it is marked started on site, or when measurements on a changed line exceed its contract quantity. Each is
  shown with the value at risk.

**Rights:**
- The project's team raises, prices and submits variations.
- `billing.edit` records the client's decision and the billing setting.

**Tests:**
- A variation with a new item priced from a rate analysis and a changed quantity:
  - Approved internally (no rules) and submitted.
  - Approved by the client for less.
  - The contract BOQ revised and frozen as VO-001.
  - The budget moved, and cost control's changes showing it.
  - The next RA bill billing the new item and the moved quantity.
- A second variation executed and not approved.
- A third rejected, with billing while pending on, and its lines reverted.
- A browser test: a variation raised, priced, submitted and approved.

## Risks

1. [Likely] Cost to complete entered per element is work site teams avoid; if it is not kept, forecasts collapse to
   "budget minus actual", which is wrong for most projects.
2. [Certain] EV depends on measured progress being current; a measurement book updated only at billing time gives
   monthly, not weekly, control.
3. [Guessing] Contract and claims management is often done by a separate commercial team with its own tools; the
   pilot will show whether this step is used.

## Questions for you before Wave 4 starts

1. Is cost to complete entered by the site team, the planning team, or computed only?
2. Which EAC method does your management use today?
3. Do variations need the client's approval before billing in all your contracts, or are some billed pending?

## Answers taken (2026-10-12: "start wave 4 with your recommended defaults")

1. **Cost to complete** is entered by the planning team (permission `cost.forecast`) per WBS element and cost code.
   Where nothing is entered, it is computed: remaining budget, floored at zero. A computed figure is marked as such
   on every screen, so nobody mistakes it for a judgement.
2. **EAC:** the forecast defaults to the CPI method (AC + (BAC − EV) ÷ CPI). The other methods are shown beside it,
   and a project can choose a different one as its forecast.
3. **Variations** are billed only once the client has approved them. A contract setting allows billing while
   approval is pending, for the contracts that permit it; such lines are marked pending on the bill.

## Step 1 delivered: cost control

**Journey:**
- **Cost control** (Projects menu), for a project:
  - **Totals:** original budget, approved changes, current budget, committed, actual, cost to complete, forecast and
    variance.
  - **The report** three ways: by cost code and WBS element (one row each), by cost code, and by WBS element, each
    rolled up its tree.
  - **Cost to complete** typed on each row by planning (`cost.forecast`). A row with nothing typed shows the computed
    figure, marked `*`.
  - **Drill-down:** a row's name opens the order lines and ledger lines behind it, each saying how it was placed.
  - **Needs attention:**
    - Cost codes over budget (committed plus spent).
    - Resources billed above their material-budget rate.
    - How many costs are not placed.
    - Defaults not set for sources in use.
  - **Not placed:** each cost with nothing to say where it belongs, placed on a WBS element, a cost code or both.
  - **Month close:** the original budget taken (once), the month closed, and any closed month compared with now.
  - **Excel** of the report.
  - **Company defaults:** a cost code per source (material, labour, equipment and subcontract order lines, payroll,
    own equipment, BOCW cess, depreciation, bills without an order, other entries).

**Decisions made while building (change any you disagree with):**
- **[Certain] Actual is the ledger**, not documents. It always agrees with the project P&L: expense ledgers only,
  year-end and closing stock left out, GST credit not cost.
- **[Likely] Materials count as actual when billed**, as the ledger books them. Store issues place materials on WBS
  elements but are not added again; issued value by WBS can be added later if sites want it.
- **[Likely] A bill's ledger lines are tied to its order lines by order.** The n-th item line of a bill's voucher is
  the n-th bill line with an amount, which is how payables and subcontract bills post. A debit note follows its
  bill's first line.
- **[Likely] Where an enquiry line came from several requisitions,** the first with a WBS element and cost code
  decides.
- **[Likely] Allocations are field by field:** placing a work order on a WBS element keeps its default cost code.
- **[Likely] Committed is the order's open balance before GST:** ordered less billed, line by line. A closed order
  commits nothing more. A debit note does not reopen the commitment.
- **[Likely] The over-budget alert names the most specific cost code over,** not its parents too. Spending with no
  budget at all is over budget.
- **[Guessing] Defaults are never guessed** from a cost code's kind. Until one is set, costs from that source show
  as not placed.

**API** (under `/api/tenant`):
- `GET projects/:id/cost-control?compare=YYYY-MM&format=json|xlsx`
- `GET projects/:id/cost-control/documents?key=|unallocated=true`
- `POST projects/:id/cost-control/allocations`
- `POST projects/:id/cost-control/ctc`
- `POST projects/:id/cost-control/baseline`
- `POST projects/:id/cost-control/months/:month/close`
- `POST cost-control/defaults/:source`

Migration `0053_cost_control.sql` adds schema `ctl` with default charges, allocations, cost to complete, the
baseline and month snapshots. New permission: `cost.forecast`, on for managers.

**Tests:**
- 2 unit tests:
  - The cost-to-complete default: remaining budget or open commitment, whichever is larger, never below zero.
  - The forecast and variance.
  - The roll-up, with what is off the tree kept apart.
- An API integration test, worked by hand:
  - **Budget:** ₹5,10,000 mapped to three cost codes and two WBS elements, then ₹10,000 of changes.
  - **Cement:** ordered from a requisition, 1,14,000 billed (76,000 still committed), with a debit note of 3,800.
  - **Waterproofing work order:** charged by default, then placed on the substructure.
  - **Labour bill without an order:** not placed until allocated.
  - **Payroll:** falls on its default.
  - **Manual journal:** carries its own cost code.
  - **Totals:** actual 1,80,200 (agreeing with the project P&L), committed 1,41,000, forecast 5,40,200, variance
    −20,200.
  - **Alerts:** subcontracts 5,000 over, and cement billed at ₹380 against ₹370.
  - **Month:** September closed and compared after cost to complete changed, a second close refused, and a future
    month refused.
  - **Excel** export.
- A browser test: a labour bill placed on civil labour, cost to complete entered (forecast ₹55,000), the month closed
  and compared.

## Step 2 delivered: cash flow

**Journey:**
- **Cash flow** (Projects menu), for the company or a project, by month or week, as of a date:
  - Rows for each kind of money in and out, totals in and out, net, and the **position**: the bank and cash balance
    for the company, net cash so far for a project.
  - **Actual** periods shaded: six months or eight weeks back, and the current one to date.
  - **Forecast** periods ahead: twelve months or thirteen weeks, then "later".
  - Anything already overdue counts as due now.
- **A project:**
  - Its **cash terms**, defaults until saved (`cost.forecast`): days to certify, days to pay after certifying, the
    client's TDS, supplier days, cost days.
  - Notes say how the work still to do was forecast.
  - "What the forecast is made of" lists every expected receipt and payment with its date.
- **The company:**
  - Bank and cash before the date.
  - Every project's forecast, and the forecast by project.
  - **Company overheads** per month (`cost.forecast`).
  - **GST to the government** on the 20th of the next month, with a credit carried.

**Decisions made while building (change any you disagree with):**
- **[Likely] Work is billed at each month's end.** A month's work brings in value plus GST, less retention, advance
  recovery (while an advance is set) and the client's TDS.
- **[Likely] Work still to do** is spread by the schedule's forecast dates (calendar days) where activities are
  linked to the contract BOQ. Otherwise it is spread evenly to the planned finish. With neither, it is not forecast,
  and a note says so.
- **[Likely] Cost not yet ordered** (step 1's cost to complete less the commitment) is spread like the work.
- **[Likely] Open orders** are paid with their GST, the supplier days after delivery (the order's deliver-by date, or
  the as-of date if that has passed).
- **[Likely] A supplier bill's lines say which projects it is for.** Each project takes its lines' share of what is
  owed and of what was paid on it.
- **[Likely] A client receipt counts the cash only:** each project's allocation less its share of TDS and
  deductions.
- **[Likely] Payroll paid** is split over projects by each person's days, at the payment voucher's date.
- **[Guessing] The company's GST** is output tax on expected bills (in the month certified) less input tax on
  expected supplier payments (in the month delivered or billed). Retention release, escalation and TDS deducted from
  suppliers are not forecast yet.
- **[Certain] The company's actual is its bank and cash ledgers,** contras left out. A project's actual is built
  from documents, since bank lines carry no project.

**API** (under `/api/tenant`):
- `GET projects/:id/cash-flow?by=month|week&asOf=`
- `POST projects/:id/cash-terms`
- `GET accounts/cash-flow?entityId=&by=&asOf=`
- `POST accounts/cash-flow/:entityId/overheads`

Migration `0054_cash_flow.sql` adds `ctl.cash_terms` and `ctl.cash_settings`.

**Tests:**
- 3 unit tests:
  - Periods back and ahead (months and weeks, split at the date).
  - Dates moved by terms, and overdue becoming due now.
  - A bill's cash.
  - Spreads.
  - GST netted with a credit carried.
- An integration test, worked by hand, as of 1 October 2026 with 10-day terms:
  - **In:**
    - A certified bill's 1,39,000 still owed, due now.
    - 2,00,000 measured and not billed, bringing in 2,22,000 in November.
    - 6,00,000 of work spread to March at 1,11,000 a month.
  - **Out:**
    - A 50,000 supplier bill.
    - An order's 2,04,800.
    - 6,00,000 of cost not yet ordered.
  - **Actual:** 1,94,000 received, 30,000 paid in a run, 5,000 paid by voucher.
  - **Position:** month by month.
  - **Weekly view:** the order in the week of 19 October.
  - **Company view:**
    - The bank's 1,59,000.
    - Overheads.
    - GST: 9,200 for November after October's 44,800 credit, then 18,000 a month.
- A browser test:
  - A project's cost not yet ordered moved by its cost days.
  - A supplier bill due.
  - The company's overheads.

## Step 3 delivered: earned value

**Journey:**
- **Earned value** (Projects menu), for a project as of a date:
  - Budget at completion.
  - Planned value, earned value and actual cost, each with its percentage.
  - SV, CV, SPI and CPI, coloured.
  - The estimate at completion, to complete, and the variance at completion.
- **Estimate at completion:** four methods side by side, with the one the project uses marked. That choice is set
  with `cost.forecast`, and the CPI method is the default.
- **S-curves:** PV, EV and AC by month, with the figures beneath.
- **By WBS element:** the same figures for each element, and for what is on none.
- Without a baseline, a warning says so, and PV, SV and SPI are blank.

**Decisions made while building (change any you disagree with):**
- **[Likely] Budget value** is each contract item's quantity at the rate of the budget line sharing its key. An item
  with none takes its contract rate scaled by the project's budget ÷ contract.
- **[Likely] PV** spreads each linked item's budget value evenly over the **calendar** days of its activities'
  baseline spans, shared equally between activities. The project dashboard's S-curve uses working days. The two
  differ only in shape within a span.
- **[Likely] Only the plan's current baseline counts.** A new baseline is used once it is made the current one.
- **[Certain] AC is step 1's actual (the ledger) to the date.** By WBS element, only what is placed on one.
- **[Likely] The bottom-up estimate is step 1's forecast as it stands now,** not as at the date.

**API** (under `/api/tenant`):
- `GET projects/:id/earned-value?asOf=`
- `POST projects/:id/earned-value/method`

Migration `0055_earned_value.sql` adds `ctl.ev_settings`.

**Tests:**
- 2 unit tests:
  - SPI 0.8 and CPI 0.9 with all four estimates worked by hand.
  - Anything that divides by nothing left blank.
- An integration test:
  - A contract of two items with budget lines sharing their keys, and two linked activities baselined.
  - At 16 September: PV 1,31,250, EV 95,000, AC 1,05,000, SPI 0.7238, CPI 0.9048, and the four estimates.
  - The foundations WBS element apart.
  - The S-curve.
  - Re-baselined with the columns activity shortened: PV 1,62,500 and SPI 0.5846.
  - The method chosen by the manager and refused to the worker.
- A browser test: no baseline warned of, and the forecast method changed.

## Step 4 delivered: variations

**Journey:**
- **Variations** (Projects menu), for a project:
  - **The register:** each variation with its status, value, cost and approved value. Totals by status, and
    **executed, not approved** with the value at risk.
  - **The billing setting:** whether this contract lets variations be billed while the client's approval is pending
    (`billing.edit`).
  - **Raise a variation:** the title, source, the client's instruction reference and the reason, then lines.
    - **New items:** code, description, unit, quantity; a rate analysis or a typed cost rate; and a contract rate,
      typed or at the markup.
    - **Changed contract items:** a quantity, plus or minus.
  - **A variation:**
    - Its lines with value and cost.
    - **Submit** for approval inside the company. With no rules it goes straight to the client.
    - The date work started on site.
    - **Withdraw.**
    - With `billing.edit`, the **client's decision**: the reference and date, each line's allowed quantity and rate,
      approved or rejected.
- On approval:
  - **The contract BOQ:** new items under a "VO Variations" section, and changed quantities moved. A frozen contract
    BOQ is revised, changed and frozen again as an internal version named after the variation.
  - **The budget BOQ:** the same lines at cost, sharing their keys.
  - **The schedule:** the activities named are extended by the variation's days.
- A **client bill** marks lines billed from a variation still pending.

**Decisions made while building (change any you disagree with):**
- **[Likely] A new item's contract rate** is its cost rate × the project's contract ÷ budget totals, unless typed. A
  changed item keeps its contract rate. Its budget rate comes from the budget line sharing its key, else the contract
  rate scaled.
- **[Likely] The budget BOQ paired with a contract BOQ** is the one copied from the same tender BOQ, else the
  project's only budget. With neither, only the contract moves.
- **[Likely] The client approves line by line:** quantities and rates. The approved value is their sum.
- **[Likely] Work has started** when it is marked started on site, or when a changed line is measured beyond its
  contract quantity before the client approves.
- **[Likely] Taking back a rejected variation:**
  - Changed quantities return.
  - A new item with nothing measured is removed.
  - A measured one stays, for a credit note.
- **[Guessing] Schedule extension happens after the approval is saved.** If the plan changed meanwhile, it is left
  for the planner rather than failing the approval.

**API** (under `/api/tenant`):
- `GET|POST projects/:id/variations`
- `POST projects/:id/variations/settings`
- `GET|POST variations/:id`
- `POST variations/:id/submit`
- `POST variations/:id/client`
- `POST variations/:id/started`
- `POST variations/:id/withdraw`

Approval document type `variation`. Migration `0056_variations.sql` adds `ctl.variation`, `ctl.variation_line` and
`ctl.variation_settings`. `BoqService.applyInTx` runs BOQ edits in the caller's transaction.

**Tests:**
- An integration test, worked by hand:
  - **VO-001:** waterproofing from an analysis (₹300 cost, ₹375 at the 1.25 markup) and 100 sqm more plaster, value
    1,05,000 and cost 84,000.
    - Straight to the client, who approves ₹350 and 80 sqm: 94,000.
    - The frozen contract BOQ revised as VO-001.
    - The budget moved and keyed together.
    - Cost control's changes at 79,200.
    - The next RA bill at the new rate and quantity.
  - **VO-002:** executed and not approved, with 50,000 at risk.
  - **VO-003:** billed while pending, then rejected and taken out of both BOQs.
  - Rights checked.
- A browser test: a variation raised, submitted, and approved by the client at a lower rate.

