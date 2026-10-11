# Wave 3 Build Plan: Operations and Finance

Scope: docs/04-features.md W3 (F1-F13). docs/01-mvp.md: "Client RA billing, subcontractor/vendor bills,
accounts-lite (GST/TDS), equipment, HR/payroll, labour contractors, quality, safety". Exit criterion: **money flows
end to end**.

**Planned before Wave 2b is finished, and before any wave has been tried by a pilot.** [Likely] Parts of this plan
will change once a contractor bills a client on Wave 2a's measurement book or receives goods on 2b. Each step is
re-read with you before it starts, as Wave 2b's steps were.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Read this first

- **[Certain] Wave 3 is three products.** A finance core (ledger, billing, payables, GST/TDS, bank, Tally), a
  resources product (assets, equipment, HR, payroll, labour) and site quality and safety. As with Wave 2, it ships in
  parts: **3a Money**, **3b People and equipment**, **3c Quality and safety**. Each part is sellable on its own.
- **[Certain] The source documents disagree on accounting depth.** docs/01-mvp.md says "accounts-lite (GST/TDS)";
  docs/04-features.md F1 says "full double entry"; docs/03-architecture.md §14 decided three accounts modes, one of
  which is Tally holding the books. **Proposal:** build the full double-entry ledger (F1), because every bill,
  receipt and payment has to post somewhere, and offer mode (c) for firms that keep Tally. **Decide before 3a step 1.**
- **[Likely] A practising chartered accountant must review 3a** before any tenant relies on it: the chart of
  accounts, posting rules, GST and TDS treatment, the financial statement formats. I can build to the rules; I am not
  a substitute for their sign-off. Budget for this review.
- **[Certain] Statutory rates and thresholds change.** GST rates, TDS sections and thresholds, PF/ESI ceilings,
  professional tax slabs, minimum wages and BOCW cess are **data with effective dates**, kept in a compliance-rules
  layer, never constants in code (docs/04-features.md risk 4). Every rate quoted below is [Guessing] until checked
  against the current notification when the step is built.
- **[Certain] No paid services.** e-invoice IRN and e-way bills are generated as the government's JSON files for the
  tenant to upload on the portal; direct API filing needs a GSP or ASP, which is paid, so it stays an adapter with no
  default (docs/licensing-policy.md). Live bank connections stay off (docs/03-architecture.md §14).
- **[Likely] The Joineries Production module** (docs/04-features.md §V, placed "with W3") is a manufacturing system
  (job cards, routing, cutting lists, workshop stages). **Proposal:** scope it as its own wave after 3c, not inside
  3a-3c. Say if Joineries customers are your first sale and it must come sooner.

## Decisions proposed at the start (change any you disagree with)

- **[Likely] Every document posts through posting rules.** A bill, receipt, payment, issue or payroll run does not
  write journal lines itself: it produces a posting (document, date, lines by account role such as "GST input
  CGST", "Retention payable", "Material consumption") and the tenant's **account map** turns roles into ledger
  accounts. Changing the chart of accounts then changes nothing in billing code.
- **[Certain] Cost centres are projects and sites**, from Wave 2a; cost codes (Wave 2a step 3) are the analysis
  dimension on expense lines. A journal line can carry entity, project, site, cost code and party.
- **[Certain] Multi-entity:** each legal entity (P1) keeps its own books, GSTIN(s) and numbering; inter-entity
  transfers post on both sides.
- **[Likely] Periods lock monthly.** Posting into a locked month is refused; reopening needs the admin and is audited.
- **[Likely] Approvals reuse Wave 2b's engine** (document types `client_bill`, `vendor_bill`, `payment_run`,
  `journal`, `payroll_run` and more), with no rules meaning no approval, as now.
- **[Certain] Money stays exact** (`numeric`, explicit rounding per docs/05-database.md §1); tax is rounded per
  line as an invoice shows it (Wave 2b step 4's rule), totals rounded to the rupee only where the law requires.

## Step 1 in detail (planned before building)

**Goal:** books for each company (legal entity): a chart of accounts, vouchers that always balance, locked months,
opening balances, and the day book, ledger and trial balance. Every later money step posts here.

- **Companies.** The tenant has one entity today ("Main entity", no GSTIN). Step 1 adds a Companies screen for the
  admin: name, legal name, GSTIN, PAN, TAN, state, address, and the date its books start. Projects and tenders
  already name their entity.
- **One chart of accounts per tenant,** shared by its companies; balances are kept by company. [Likely] Firms with
  several companies want the same chart; a ledger used by only one company is still allowed.
  - A tree of groups and ledgers under five fixed roots: Equity, Liabilities, Assets, Income, Expenses. Each ledger:
    code, name, group, kind (ordinary, bank, cash, party, tax), whether lines need a project (cost centre).
  - Seeded with a construction contractor's chart in Schedule III order. The tenant adds, renames and moves
    ledgers; a ledger with postings is never deleted, only closed.
  - **Party ledgers:** each client, vendor or subcontractor gets one ledger when first posted to (under Sundry
    debtors or Sundry creditors), so a party can be both.
- **Account map:** the roles later steps post to (sales works contract, output and input CGST/SGST/IGST, TDS
  receivable, TDS payable by section, retention receivable and payable, mobilisation advance received, advances to
  suppliers, stock, GRN clearing, material consumption, subcontract cost, round off) mapped to ledgers per company,
  seeded to the seeded chart and changed by the admin.
- **Vouchers:** journal, payment, receipt, contra, sales, purchase, debit note, credit note and opening. Numbered per
  type, company and financial year. Each line: ledger, debit or credit, and optionally project, site, cost code and a
  line note.
  - **The database refuses a voucher that does not balance** (checked at commit) and any edit or delete of a posted
    voucher. A mistake is put right by **reversing** the voucher: a new voucher, dated when the reversal is made,
    with every line the other way round.
  - Bank and cash ledgers appear only in payment, receipt and contra vouchers' bank side, as Tally does. [Likely]
- **Periods:** financial years April to March. The admin locks a month per company; a voucher dated in a locked month
  is refused (by the database too). Reopening is the admin's, audited.
- **Opening balances:** one opening voucher per company dated the day before its books start, typed in or imported
  from Excel (ledger code or name, debit, credit), parties included. It must balance. [Likely] Bill-by-bill open
  items for parties come with receivables and payables (steps 3 and 4).
- **Reports:** day book (vouchers between two dates), ledger (opening, each line with its running balance, closing),
  trial balance as at a date (group totals and ledgers, optionally for one project), each as Excel.
- **Rights:** new `accounts.view` (read the books; managers by default) and `accounts.post` (vouchers; managers by
  default). The chart, the account map, companies, locks and opening balances are the admin's.
- **Tests:** an unbalanced voucher refused by the API and by the database; a posted voucher cannot be changed;
  reversal; a locked month; numbering per type and year; opening balances imported; a trial balance of a worked set
  of vouchers by hand, and for one project.
- **Not in this step:** documents posting automatically (each money step adds its own posting), bill-wise party
  balances, multi-currency vouchers, cost-centre allocation percentages.

## Steps

| # | Part | Step | Features | Depends on |
|---|------|------|----------|------------|
| 1 | 3a | **Ledger core** | Chart of accounts, account map, journals and vouchers, cost centres, periods, trial balance, opening balances | P1 |
| 2 | 3a | **Client RA bills** | Bills from the measurement book, cumulative and this-bill, deductions, escalation, GST invoice, client certification | Wave 2a step 6, step 1 |
| 3 | 3a | **Receivables** | Client receipts, allocation, TDS deducted by the client, retention held and released, ageing | step 2 |
| 4 | 3a | **Vendor bills and payables** | Bills against orders, three-way match, advances, retention, debit notes, payment runs, bank upload files | Wave 2b steps 4-6, step 1 |
| 5 | 3a | **Subcontract bills** | Work order measurement, subcontractor RA bills, back-charges, materials issued, retention release | Wave 2b step 4, step 4 |
| 6 | 3a | **GST and TDS** | Registers, credit/debit notes, GSTR-1/3B data, e-invoice and e-way bill JSON, TDS challans and 26Q data | steps 2-5 |
| 7 | 3a | **Bank and reconciliation** | Statement import, matching, reconciliation, payment advices | step 4 |
| 8 | 3a | **Tally export and statements** | Tally XML export, accounts modes, P&L, balance sheet, cash flow, project P&L, year end | steps 1-7 |
| 9 | 3b | **Fixed assets** | Register, depreciation (Companies Act and Income Tax), disposal | step 4 |
| 10 | 3b | **Equipment and fleet** | Register, allocation, log sheets, fuel, maintenance, costing to projects, hire bills | step 9, Wave 2b step 6 |
| 11 | 3b | **HR** | Employees, designations and custom roles, attendance, leave, site deployment | P2 |
| 12 | 3b | **Payroll** | Salary structures, PF, ESI, PT, LWF, TDS on salary, payslips, full and final, bank file | step 11 |
| 13 | 3b | **Labour contractors** | Contract labour muster, wage sheets, statutory registers, BOCW cess | step 5, step 11 |
| 14 | 3c | **Quality** | Inspection requests, checklists, test records, NCRs, snags, material approvals | Wave 2b step 5 |
| 15 | 3c | **Safety** | Incidents, permits to work, toolbox talks, inspections, statistics | Wave 2b step 7 |

Each step ships with API integration tests (amounts worked by hand) and a browser test of the main journey.

## 3a Money

### Step 1: Ledger core (F1)

- **Chart of accounts:** groups and ledgers in a tree (Assets, Liabilities, Income, Expenses, Equity at the top),
  seeded with a construction contractor's chart in Schedule III order; the tenant edits it. Each ledger: code, name,
  group, type (bank, cash, party, tax, ordinary), whether it takes cost centres.
- **Account map:** the roles posting rules use (Sales works contract, Output CGST/SGST/IGST, Input CGST/SGST/IGST,
  TDS receivable, TDS payable 194C, Retention receivable, Retention payable, Mobilisation advance received, Material
  consumption, Stock, GRN clearing, and so on) mapped to ledgers, per entity.
- **Vouchers:** journal, payment, receipt, contra, sales, purchase, debit note, credit note; numbered per type, entity
  and financial year (P7). A voucher balances or is refused; posted vouchers are reversed, never edited.
- **Party ledgers:** every party (Wave 1's master) gets a sub-ledger; a party can be both customer and supplier.
- **Periods:** financial years April to March, months lockable.
- **Opening balances** by import (Excel, P9) for firms moving from Tally or spreadsheets: trial balance and party-wise
  open items.
- **Reports in this step:** day book, ledger, trial balance (by entity, as at a date, with cost-centre filter).
- **Tests:** a voucher that does not balance refused; reversal; locked period; trial balance of a worked set.

### Step 2: Client RA bills (F3)

- **From the measurement book** (Wave 2a step 6): an RA (running account) bill takes measured quantities **up to
  date**, less the **previous bill**, at contract rates; extra items and variations come with Wave 4 (C3), so until
  then only contract BOQ lines are billed.
- **Deductions and additions** per contract, set once on the project: retention (a percentage, capped at a limit),
  mobilisation and machinery advance recovery (a percentage per bill until recovered), security deposit, materials
  supplied by the client (recovered at the agreed rate), water and electricity, other recoveries, and **price
  variation / escalation** by a formula (for example a CPWD-style clause: components for materials, labour, fuel
  against index values entered per month). [Guessing] The formula set needs your contracts as examples.
- **GST invoice:** works contract at the contract's GST rate on the taxable value, place of supply from the site,
  the client's GSTIN; on top of the bill (your decision: tax is always added to the contract value). A bill is a
  tax invoice with the required particulars (supplier, recipient, HSN/SAC, place of supply, rate, amounts).
- **Client certification:** a submitted bill comes back certified, often for less; the certified quantities and
  amounts are recorded as a revision, and the difference is reported (disallowed this bill, carried forward).
- **Approval** before submission to the client (`client_bill`); posting on certification (or on submission, a
  tenant setting).
- **Output:** the bill in the client's usual format (abstract, measurement detail, deductions), PDF and Excel.
- **Tests:** three successive bills with cumulative quantities, retention capped, advance recovered over bills,
  escalation by formula, GST, a certification for less.

### Step 3: Receivables

- Client receipts entered against bills (one receipt across several bills, part payments), with **TDS deducted by
  the client** (recorded as TDS receivable, to be matched to Form 26AS later) and other deductions the client makes.
- **Retention:** held per bill, released per contract (on completion, on defects liability end), each release a
  receipt.
- Ageing by client and project; outstanding by bill; interest on delayed payment is not calculated.
- **Tests:** receipt allocation across bills; TDS receivable; retention release.

### Step 4: Vendor bills and payables (F2)

- **Bills against orders:** the supplier's invoice entered against a purchase order; **three-way match** of order
  (rate, GST), receipt (accepted quantity, Wave 2b step 5) and invoice (quantity, rate, tax). Differences within a
  tenant tolerance pass; beyond, the bill is held with the reason. Bills without an order (services, rent) are
  entered against an expense ledger with a cost centre.
- **GRN clearing:** a receipt posts stock (Wave 2b step 6) against "goods received not invoiced"; the bill clears it.
  [Likely] This is the standard way to keep stock value and payables consistent when bills come late.
- **Input GST:** claimed only on a valid tax invoice; the GSTIN state decides CGST/SGST or IGST, as on the order.
- **TDS** on payments to contractors and professionals (sections by party type, thresholds per year, lower-deduction
  certificates with limits and validity); TDS on purchase of goods (194Q) where the tenant's turnover crosses the
  threshold. [Guessing] Section list and rates checked when built.
- **Advances** to suppliers, adjusted against bills; **retention** held on subcontract bills.
- **Debit notes** from returns to supplier (Wave 2b step 5) and rate differences.
- **Payment runs:** choose bills due, approve (`payment_run`), produce the bank's bulk upload file (formats per bank,
  free text formats; no live bank), mark paid when the bank confirms, payment advice to the supplier as PDF.
- **Tests:** match within and beyond tolerance; GRN clearing; TDS with a threshold crossed mid-year; a payment run.

### Step 5: Subcontract bills (F4)

- **Work orders** (Wave 2b step 4) are measured: a subcontractor measurement book on the same engine as the client
  measurement book, by work order line.
- **Subcontractor RA bills:** cumulative and this-bill as in step 2, with retention, advance recovery, **back-charges**
  (materials issued to the subcontractor from stores, Wave 2b step 6, at the agreed rate; debris clearance; damages),
  labour cess, TDS.
- **Retention release** at the end of defects liability.
- **Tests:** a subcontractor billed three times with materials issued and recovered; retention release.

### Step 6: GST and TDS (F5)

- **Registers:** outward (sales) and inward (purchases) by GSTIN and month; input credit available and blocked.
- **Credit and debit notes** with the original invoice reference.
- **Return data:** GSTR-1 (outward, by invoice and summary) and GSTR-3B (summary) as Excel and the portal's JSON
  where a schema is published; reconciliation of inward supplies with the supplier-filed data imported from the
  portal's download (2B) file.
- **e-invoice:** the IRP JSON for each invoice (for tenants above the threshold, [Guessing] the turnover limit is
  checked when built), uploaded by the tenant; the returned IRN and QR are imported and printed on the invoice.
  **e-way bills:** the JSON for goods movements (transfers between sites, Wave 2b step 6) over the value limit.
- **TDS:** deducted per section, challans (deposit details entered), 26Q quarterly return data in the government's
  utility format, Form 16A data; for TDS receivable, matching with 26AS / AIS downloads.
- **Tests:** a month's registers against hand-worked sums; a credit note; the JSON files validated against published
  schemas.

### Step 7: Bank and reconciliation (F6)

- Statement import: CSV and Excel per bank layout (mappings saved), OFX, MT940.
- Matching: by amount, date window, cheque or UTR number; suggested matches, confirmed by hand; unmatched items
  become vouchers (bank charges, interest) in one click.
- Bank reconciliation statement as at a date.
- `BankAdapter` interface with a mock adapter only (docs/03-architecture.md §14).
- **Tests:** a statement month reconciled; duplicate import refused.

### Step 8: Tally export and financial statements (F7)

- **Tally XML export** of masters (ledgers, groups, parties, stock items) and vouchers for a period, importable into
  Tally Prime; accounts modes per tenant: (a) native books, (b) native books plus Tally export, (c) Tally holds the
  books and the app only pushes vouchers (its ledger screens become read-only). The live Tally link (connector agent)
  is Wave 6 (G6).
- **Statements:** profit and loss and balance sheet in Schedule III format, cash flow (indirect method), by entity;
  **project P&L** (contract revenue billed and certified, costs by cost code) for every project.
- **Year end:** closing entries, carry forward, the year locked.
- **Exit check for 3a:** a project billed to a client and paid, its supplier and subcontractor bills matched and paid,
  GST and TDS data produced, bank reconciled, trial balance and statements agree, Tally import accepted.

## 3b People and equipment

### Step 9: Fixed assets (F8)

- Register from vendor bills (capitalised lines) or opening balances; asset class, location (site), custodian.
- Depreciation: **Companies Act** (useful lives, straight line or written-down value) and **Income Tax** (block of
  assets, WDV rates, half rate for assets used under 180 days in the year), both kept, posting the books' figure.
- Transfer between sites and projects, disposal with gain or loss.

### Step 10: Equipment and fleet (F9)

- Equipment register: own (linked to the fixed asset) or hired (supplier, hire rate per hour, day or month, minimum
  hours, operator and fuel terms).
- Allocation to projects and sites over time; **log sheets** (hours or km per day, idle with reason, breakdown),
  which also feed the daily site report (Wave 2b step 7).
- Fuel issued from stores (Wave 2b step 6) against equipment; consumption per hour and alerts on outliers.
- Maintenance schedules (by hours or date), breakdown records, spare parts from stores.
- Costing: own equipment charged to projects at an internal rate (covering depreciation, operator, maintenance);
  hired equipment's hire bill computed from log sheets, entered as a vendor bill (step 4).

### Step 11: HR (F10, part one)

- Employees: personal, statutory IDs (PAN, Aadhaar reference handled under the DPDP Act with consent and minimal
  storage, UAN, ESI number), bank, joining, grade, designation, department, reporting manager.
- **Custom roles and designations** (P2, never built): this is where "Purchase head" or "Site engineer" become
  roles, and approval rules can name them instead of a person.
- Attendance by site (from a register, an import from a biometric device's export, or the phone with location),
  leave types and balances, holidays per site calendar (Wave 2a's calendars), site deployment history.

### Step 12: Payroll (F10, part two)

- Salary structures (components, formulas), monthly run with arrears and loss of pay.
- **Statutory:** PF (employee and employer, wage ceiling), ESI (gross ceiling), professional tax (slabs by state),
  labour welfare fund (by state), TDS on salary (old and new regime, declarations and proofs). All rates from the
  compliance-rules layer with effective dates. [Guessing] each one checked when built.
- Payslips (PDF), bank transfer file, statutory return data (PF ECR file, ESI return data), Form 16 data, full and
  final settlement (gratuity, leave encashment, notice recovery).
- Payroll posts to the ledger by cost centre (site deployment decides the split).
- **Exit check for 3b:** a site's staff paid for a month with correct statutory deductions, reviewed by a payroll
  practitioner.

### Step 13: Labour contractors (F11)

- Labour contractor master (licence numbers, validity), workers they deploy (name, ID, trade, wage rate).
- Daily muster by site (feeds the daily site report's manpower), wage sheets, verification that the contractor paid
  at least the minimum wage, registers required for contract labour and building workers. [Guessing] The exact
  registers and forms vary by state and are checked against current rules in the step.
- **BOCW cess** on the cost of construction, computed and tracked for payment.
- Payments to the labour contractor through their bill (step 5).

## 3c Quality and safety

### Step 14: Quality (F12)

- **Inspection requests:** the site asks the client or consultant to inspect work (BOQ line, location, activity);
  approved, approved with comments, rejected; linked to the measurement book so unapproved work can be held from
  billing (a tenant setting).
- **Checklists:** templates per work type (formwork before concreting, reinforcement, waterproofing), filled on the
  phone with photos.
- **Test records:** concrete cubes (7 and 28 day, against the grade), slump, steel, soil, bricks; results against
  acceptance criteria; failures raise an NCR.
- **NCRs:** non-conformance, root cause, corrective action, closure and verification.
- **Snag lists** by room or area (Interiors pack), with photos and closure.
- **Material approvals:** samples and make approvals before ordering; an order line can require an approved make.

### Step 15: Safety (F13)

- Incidents (near miss, first aid, lost time, fatal), investigation and actions; permits to work (height, hot work,
  confined space, excavation, electrical), with validity and closure; toolbox talks with attendance; safety
  inspections with checklists.
- Statistics: man-hours from the daily site reports and payroll, lost-time injury frequency and severity rates.
- **Exit check for Wave 3:** money flows end to end (3a), a site paid and its labour compliance recorded (3b), and a
  month of quality and safety records on a pilot site (3c).

## Risks

1. [Certain] 3a is the largest piece of work in the product. A wrong posting rule found after a tenant has a year of
   books is expensive to repair; the CA review is the mitigation.
2. [Likely] Every client writes its RA bill format differently (government departments, private developers); the bill
   output needs templates, and the first pilot's format should be the first template.
3. [Likely] Payroll statutory rules are the most volatile area; without the compliance-rules layer the product will
   be wrong within a year.
4. [Guessing] Tenants on Tally may only want 3a's billing and payables (mode c), not the ledger; the pilot decides
   which is built first in depth.

## Questions for you before Wave 3 starts (answered: the recommended choices, taken when the build started)

You asked for the build to go ahead on the recommended choices without waiting. Each one stays open to change:

1. **Full double-entry ledger in the app,** with accounts mode (c) for firms that keep Tally (step 8).
2. **A generic RA bill format** (abstract, measurement detail, deductions) until a real client bill is shared; the
   first pilot's format becomes the first template.
3. **Payroll in-house for site staff** (step 12) and labour contractors' wage compliance (step 13): both.
4. **Joineries Production is its own wave after 3c.**
5. **The CA and payroll practitioner reviews are open items.** Each money step records what needs their sign-off;
   nothing in 3a is to be relied on for filing until that review is done.

The original questions:

1. Full double-entry ledger in the app (recommended) or accounts-lite with Tally holding the books?
2. Which client RA bill formats must be supported first (please share one or two real bills)?
3. Payroll in-house for site staff, or only labour contractors' wage compliance?
4. Joineries Production module: its own wave after 3c (recommended), or sooner?
5. Which CA or payroll practitioner reviews 3a and step 12?

## Step 1 delivered: ledger core

**Journey:**
- **Companies** (admin settings): name, legal name, GSTIN (the state and PAN are taken from it, and refused when they
  disagree), TAN, address, and the date the books start. The tenant's "Main entity" is the first company.
- **Chart of accounts** (Accounts menu): the seeded construction chart under Equity, Liabilities, Assets, Income and
  Expenses. The admin adds groups and ledgers (bank, cash, tax or ordinary; a ledger can require a project on every
  line), renames, moves within the same top group, and closes ledgers. A party gets its ledger the first time it is
  posted to, under Sundry debtors (clients) or Sundry creditors.
- **Account map** (under the chart): every role later steps post to, per company, mapped to the seeded ledgers; the
  admin points a role at another ledger.
- **Vouchers:** journal, payment, receipt, contra, sales, purchase, debit note, credit note; lines by ledger or party,
  with a project and a note; the totals and the difference shown as you type; numbered per type, company and year
  ("RV/2026-27/0001"). **Reverse** posts a new voucher, dated when you choose, with every line the other way round.
- **Trial balance** as at a date, for the company or one project (each ledger opens its ledger); **ledger** between two
  dates with opening, running and closing balances; **day book**; each as Excel.
- **Books setup:** months of a financial year, locked and reopened (with a reason) by the admin; **opening balances**
  from an Excel sheet of Ledger, Debit and Credit (ledger by code or name, or a party by name), checked first and
  posted only when every row is understood and the sides agree. Posting again replaces them (the old voucher
  reversed).

**Who does what:** new `accounts.view` and `accounts.post` rights (managers by default; workers neither). Companies,
the chart, the account map, locks and opening balances are the admin's.

**What the database enforces** (so no bug or script can break the books): a voucher balances, with two lines or more,
at commit; vouchers and lines are never updated or deleted; no voucher is dated in a locked month; a line posts to an
open ledger, not a group, with a project when the ledger needs one.

**Decisions made while building (change any you disagree with):**
- **[Likely] One chart for all companies.** Balances, numbering, locks and the account map are per company.
- **[Likely] Bank and cash go only in payments, receipts and contras,** as in Tally; journals refuse them.
- **[Certain] A reversal is dated when it is made,** not on the original's date, so a locked month stays untouched.
- **[Likely] Income and expense balances run on until year-end closing** (step 8): a trial balance late in a second
  year still includes the first year's income and expenses.
- **[Likely] Opening balances are by ledger;** bill-by-bill open items for parties come with receivables and payables.

**API** (under `/api/tenant`):
- `GET|POST /companies`, `POST /companies/:id`.
- `GET|POST /accounts/chart`, `POST /accounts/chart/:id`; `GET|POST /accounts/map?entityId`.
- `GET|POST /accounts/vouchers` (`{entityId, type, date, narration, reference, lines}`), `GET /accounts/vouchers/:id`,
  `POST /accounts/vouchers/:id/reverse` (`{date, reason}`).
- `GET /accounts/periods?entityId&fy`, `POST /accounts/periods/lock|reopen`.
- `GET|POST /companies/:id/opening`, `POST /companies/:id/opening/import?post` (multipart).
- `GET /accounts/day-book`, `/accounts/ledgers/:id`, `/accounts/trial-balance`, each with `?format=xlsx`.

Migration `0036_ledger.sql`.

**Tests:**
- 5 API integration tests, every balance by hand:
  - Companies (the state and PAN from the GSTIN, a mismatch refused, a second company); a bank ledger added; opening
    balances of ₹10,50,000 a side imported (an unknown ledger reported by row; managers refused); the books' start
    fixed once there are openings.
  - A receipt, a payment and a journal numbered per type; a project required by the ledger; refused: unbalanced, bank
    in a journal, a payment not out of bank or cash, a worker, before the books, a group. The database refusing an
    unbalanced voucher at commit, and any update or delete. The payment reversed; reversing it again, or the reversal,
    refused.
  - October locked: refused by the API and by the database; reopened with a reason; the second company numbering its
    own vouchers.
  - Trial balance as at 31 October, ₹12,98,100.00 a side, with group totals; as at 30 September (the openings only);
    for one project; the bank's ledger (6,00,000 → 8,36,000 → 7,86,000 → 8,36,000); the day book (₹3,48,000); as Excel.
  - The account map seeded and changed; a mapped ledger cannot be closed; opening balances replaced.
- A browser test: the company and its GSTIN; a bank ledger; opening balances from Excel; a receipt with the difference
  shown until it balances; the receipt reversed; the trial balance and the bank's running balance; October locked and
  a voucher in it refused.

**For the CA review:** the seeded chart and its Schedule III grouping, the account map's roles, and whether journals
should be allowed to touch bank and cash.
