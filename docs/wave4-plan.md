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
