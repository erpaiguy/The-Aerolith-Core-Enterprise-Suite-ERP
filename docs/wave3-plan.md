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

## Step 2 in detail (planned before building)

**Goal:** a project's running account bills to its client, from the measurement book, as GST tax invoices, with the
contract's deductions; the client's certification recorded; the certified bill posted to the books.

- **Contract terms, per project** (set once, changed later only for new bills; each bill keeps a copy of the terms it
  used): the GST rate (18% by default, [Guessing] to be checked per contract), retention (a percentage of each bill's
  gross value, with an optional cap in rupees), the mobilisation advance paid by the client (an amount) and its
  recovery (a percentage of each bill's gross until recovered), and price variation (escalation).
- **Escalation** by a CPWD 10CC-style formula: for each component (materials, labour, fuel or others, as the contract
  names them), value of work done this bill × factor (0.85 by default) × the component's share × (this period's index −
  base index) ÷ base index. The base indices are on the terms; each bill enters this period's index values. [Guessing]
  Contracts differ: the factor and shares are editable, and a real contract is needed to check the formula.
- **A bill:** "RA 1", "RA 2" per project. Made up to a date from the measurement book: for each priced item of the live
  contract BOQs, the quantity measured up to that date (cumulative), less what the previous **certified** bill
  certified, at the contract rate. The quantity billed can be edited down (billed less than measured). A new bill
  needs the previous one certified or cancelled.
- **The figures:** this bill's gross value (Σ this-bill quantity × rate, each line rounded to the paisa); escalation;
  taxable value = gross + escalation; GST on top (CGST and SGST when the site is in the company's GST state, IGST
  otherwise: works contract supply is where the site is); invoice total. Deductions after tax: retention, advance
  recovery, and other deductions typed on the bill (each with the ledger it goes to: labour cess, water, materials
  supplied by the client). Net payable = invoice total − deductions. Deductions never reduce the taxable value.
- **Submit** (through the approval rules, document type `client_bill`), then **certify**: the client's certificate
  number and date, and each line's certified cumulative quantity (often less). The certified figures are worked again;
  the difference from what was submitted is shown line by line.
- **Tax invoice and posting on certification:** [Likely] the tax invoice number (per company and year,
  "INV/2026-27/0001") is given when the bill is certified, and the bill posts then: client Dr net payable, retention
  receivable Dr, mobilisation advance Dr (its recovery), each other deduction's ledger Dr; contract revenue Cr the
  taxable value (with the project), output tax Cr. A certified bill is not cancelled here; a credit note (step 6)
  corrects it.
- **Output:** the bill on screen and printable (abstract, this bill by item with previous, this and cumulative
  quantities, deductions), and as Excel.
- **Rights:** a new `billing.edit` (prepare, submit and certify client bills; managers by default), within the
  project's team.
- **Tests:** three bills in a row with cumulative quantities by hand; retention capped; the advance recovered over
  the bills; escalation by the formula; CGST and SGST, then IGST; a certification for less; the voucher posted; a bill
  refused while the previous is uncertified.

## Step 3 in detail (planned before building)

**Goal:** money from clients recorded against what it pays: certified bills (part or whole), retention released,
mobilisation advances; with what the client deducted; and what is still owed, aged.

- **A client receipt:** company, client, date, the bank or cash ledger it came into, the amount received, the TDS the
  client deducted (to TDS receivable, matched to Form 26AS later), other deductions with their ledgers, the UTR or
  cheque number. What it settles is the amount received + TDS + other deductions.
- **Allocated** to the client's open items, each up to what is open: a certified bill's net payable (less earlier
  receipts against it), a project's retention held (released), or a project's mobilisation advance (received). Every
  rupee settled must be allocated; "oldest first" fills the bills in invoice order.
- **Posted** as a receipt voucher: bank Dr the amount, TDS receivable Dr, each deduction's ledger Dr; the client Cr what
  went to bills; retention receivable Cr what was released; mobilisation advance received Cr the advance (each with
  its project).
- **Cancelled** with a reason: its voucher reversed, its allocations no longer count.
- **Receivables:** each client's certified bills with what is received and outstanding, retention held, advances
  received and recovered; ageing of what is outstanding (0-30, 31-60, 61-90, over 90 days from the invoice date) as
  at a date; as Excel. A bill shows its receipts.
- **Rights:** `accounts.post` records and cancels receipts; `accounts.view` reads receivables.
- **Not in this step:** interest on late payment (not calculated, as planned), 26AS matching (step 6).
- **Tests:** a receipt across two bills with TDS and a part payment; outstanding and ageing by hand; retention released;
  an advance received; an over-allocation refused; a cancellation reversing the voucher.

## Step 4 in detail (planned before building)

**Goal:** what the company owes its suppliers: their bills matched to the orders and receipts, TDS deducted by rule,
input GST taken, debit notes; then paid in approved runs with a file for the bank.

- **A vendor bill** (the supplier's tax invoice): the supplier, their bill number and date, the due date, and lines.
  - **Against an order** (Wave 2b step 4): each line is an order line with the quantity billed and the rate; GST from
    the order. **Three-way match:** the quantity billed may not exceed what was accepted on receipt (Wave 2b step 5)
    less what earlier bills billed; the rate may not exceed the order's rate by more than the tenant's tolerance (0% by
    default). A bill that does not match is **held** with the reasons; someone with the right to post **passes** it
    with a reason, or cancels it. Work orders bill by quantity done without a receipt.
  - **Without an order** (rent, services, site expenses): lines to an expense ledger, with a project when the ledger
    needs one, and GST.
  - CGST and SGST when the supplier's GSTIN state is the place of supply's (the site's for an order, the company's
    otherwise), else IGST; a supplier without a GSTIN charges none.
- **TDS** by section, kept as data with effective dates ([Guessing] each rate and threshold to be checked by the CA):
  194C contractors (1% individuals and HUFs, 2% others; on a bill over ₹30,000 or once the year's bills pass
  ₹1,00,000), 194J professional or technical fees (10%; over ₹30,000 in the year), 194I rent of land or building (10%;
  over ₹2,40,000 in the year), 194Q purchase of goods (0.1% over ₹50 lakh in the year); 20% without a PAN (5% for
  194Q). The supplier's default section is on the party. When the year's total first crosses the threshold, TDS is
  deducted on the year's bills not taxed so far (catch-up). TDS is on the value before GST.
- **Posted** as a purchase voucher: material consumption Dr (purchase-order lines), subcontract cost Dr (work-order
  lines), or the expense ledger Dr (lines without an order), each with the project; input CGST/SGST/IGST Dr; the
  supplier Cr the payable; TDS payable Cr the TDS. [Likely] Materials are a project's cost when billed (the purchase
  method): stock in the books, goods-received-not-invoiced clearing and closing stock wait until receipts and issues
  post to the books (step 8).
- **Debit notes** against a bill (goods returned, rate differences): a taxable amount and its GST reversed; posted as a
  debit note voucher (supplier Dr; the bill's ledger and input tax Cr).
- **Payment runs:** a company, the bank, the payment date, and the bills due chosen (each up to what is outstanding),
  or advances to a supplier for a project; submitted under the approval rules (`payment_run`); once approved, the
  **bank file** (CSV: beneficiary, account number, IFSC, amount, reference) and **mark paid**, which posts one payment
  voucher per supplier (supplier Dr or advances to suppliers Dr; bank Cr) and a **payment advice** for each, printable.
  Suppliers' bank details are kept on the party.
- **Advances** paid in a run are later **applied** to a bill of the same supplier (a journal: supplier Dr, advances to
  suppliers Cr).
- **Payables:** each supplier's outstanding aged from the due date as at a date, and advances not applied; as Excel.
- **Rights:** `accounts.post` enters, passes and cancels bills and runs; payment runs go through the approval rules.
- **Tests:** a bill matched to an order and receipt; one held for quantity and one for rate beyond tolerance, passed;
  194C crossing the year's threshold with catch-up; a bill without an order; a debit note; a run approved, its bank
  file, marked paid; an advance applied; payables aged by hand.

## Step 5 in detail (planned before building)

**Goal:** subcontractors paid by measurement, like the client pays the company: a measurement book per work order, RA
bills with retention, advance recovery, back-charges, labour cess and TDS; retention released at the end.

- **Terms per work order:** retention % (with an optional cap), advance recovery % per bill, labour cess % (1% by
  default, [Guessing] BOCW cess deducted from the subcontractor where the contract says so), TDS section (194C).
- **The work order's measurement book:** entries by line (date, quantity, what), never changed; a mistake is reversed
  by an entry the other way.
- **A subcontract RA bill** up to a date: each work order line measured to then, less what the previous certified bill
  certified, at the order's rate; quantities can be lowered. **Back-charges** typed on the bill, each to a ledger
  (materials issued from stores at the agreed rate, debris clearance, damages): they recover cost.
- **The figures:** gross value; GST as on the order; deductions: retention (to the cap), advance recovery (up to the
  advances paid to the subcontractor and not yet recovered), back-charges, labour cess on the gross, TDS by the
  supplier rules (step 4's catch-up included); net payable.
- **Certified under the approval rules** (`subcontract_bill`): once approved it posts and becomes a **supplier's bill**
  in payables (so payment runs, ageing and TDS work as in step 4), its advance recovery recorded as an advance applied.
  Posted: subcontract cost Dr the gross (with the project), input tax Dr; the subcontractor Cr, retention payable Cr,
  each back-charge's ledger Cr, labour cess payable Cr, TDS payable Cr; and the advance recovered (subcontractor Dr,
  advances to suppliers Cr).
- **Retention release** for a work order, up to what is held: retention payable Dr, the subcontractor Cr, as a
  supplier's bill to pay in a run.
- **Rights:** `billing.edit` on the project's team makes and submits subcontract bills and measures; `accounts.post`
  releases retention.
- **Tests:** a subcontractor billed three times with a reversal in the book, back-charges and an advance recovered;
  retention to its cap and released; TDS crossing the year's limit; paid in a run.

## Step 6 in detail (planned before building)

**Goal:** what the CA files each month and quarter comes out of the books without retyping: GST registers and return
data, the e-invoice JSON, the supplier-filed 2B matched to the purchase book, and TDS deposited and returned. Built in
two parts: **6a GST**, then **6b TDS**.

**The uncomfortable part first:** [Certain] the government portals change their file layouts without notice, and a
file the portal rejects is worse than no file. So each export is built to a published layout only where one exists and
is stable (the e-invoice JSON, schema 1.1; the GSTR-2B download), and is otherwise **Excel in the layout the free
government offline tools import** (the GST offline tool for GSTR-1, the NSDL Return Preparation Utility for 26Q), which
then make the portal's file. [Likely] e-way bills are left out of this step: goods move between our own sites rarely
above the limit, and the bulk JSON layout should be taken from a pilot's real file; recorded as an open item.

### 6a GST

- **Company and party details the returns need:** the company's PIN code and the client's state, PIN and legal name
  (for the e-invoice); a **SAC/HSN** on the client bill terms (9954, construction services, by default).
- **Credit notes to clients** (the client bill page said "correct it with a credit note"; this builds it): against a
  certified bill's tax invoice, a value and the bill's GST rate; numbered `CN/…` per company and year; posts contract
  revenue and output tax Dr, the client Cr; reduces what the client owes on that bill (receivables honour it).
- **Blocked input tax:** a ledger can be marked "input tax blocked" (section 17(5): motor cars, food and beverages,
  personal use, and so on — [Guessing] the list is the CA's call); a supplier's bill line to such a ledger posts its GST
  into the expense, not input tax.
- **Registers**, for a company and a month (or a range), as screens and Excel:
  - **Outward:** each tax invoice and credit note: number, date, client and GSTIN, place of supply, taxable value,
    CGST, SGST, IGST, total; B2B (client with a GSTIN) or B2C.
  - **Inward:** each posted supplier's bill and debit note: supplier and GSTIN, their bill number and date, taxable,
    taxes, input tax taken or blocked; unregistered suppliers listed apart.
- **GSTR-1 data** (Excel, the offline tool's sheets): `b2b` (by invoice, rate-wise), `b2cl`, `b2cs` (by place of
  supply and rate), `cdnr`, `hsn` (summary by SAC/HSN and rate), `docs` (invoice number ranges). [Guessing] the column
  headings follow the offline tool's template; checked against the tool's own sample before release.
- **GSTR-3B summary** (screen and Excel): 3.1(a) outward taxable supplies and tax; 4(A)(5) input tax from all other
  supplies; 4(B)(1) reversed (debit notes) and blocked shown apart; the net. **The JSON** for 3B is not built (the
  portal's offline route for 3B is manual entry).
- **e-invoice:** for a certified bill (and a credit note), the **IRP JSON, schema 1.1** (`Version`, `TranDtls`,
  `DocDtls`, `SellerDtls`, `BuyerDtls`, `ItemList` one line per bill, `ValDtls`), downloaded, uploaded by the tenant to
  the IRP; the returned **IRN, acknowledgement number and date and the signed QR** typed or pasted back on the bill and
  printed on it, the QR drawn by a free (MIT) library. Refused, with what is missing, when a GSTIN, PIN or state is not
  there. [Guessing] whether a tenant must e-invoice (turnover over ₹5 crore) is the tenant's setting, not worked out.
- **2B reconciliation:** the GSTR-2B JSON downloaded from the portal is uploaded for a month; its B2B invoices
  (supplier GSTIN, invoice number, date, taxable, taxes) are matched against posted supplier's bills by GSTIN and a
  normalised bill number: **matched**, **differs** (amounts off by more than ₹1), **in 2B only** (not in the books),
  **in the books only** (the supplier has not filed: credit at risk). Kept per month; re-uploading replaces it. As
  Excel.
- **Rights:** `accounts.view` sees registers and returns; `accounts.post` raises credit notes, records IRNs, uploads 2B.
- **Tests:** a month with two B2B invoices (one inter-state), a B2C invoice, a credit note, purchases with a blocked
  line and a debit note: the registers, GSTR-1 sheets, 3B figures against hand-worked sums; the e-invoice JSON's every
  field for one bill; a 2B file with a match, a difference, one only in 2B and one only in the books.

### 6b TDS

- **Challans:** a deposit for a month's TDS under a section (BSR code, challan serial number, date, amount, interest
  and fee), posting TDS payable Dr, the bank Cr; the deductions of that month and section **allocated** to it (by
  default, all not yet deposited); a deduction is deposited once.
- **26Q data** for a quarter: the deductor (company TAN, PAN, address), the challans, and each deduction (deductee PAN
  and name, section, date paid or credited, amount, TDS, rate, challan), as Excel in the column order of the RPU's
  import; deductions without a PAN flagged at the higher rate. Form 16A itself is downloaded from TRACES; the app gives
  each supplier's quarterly statement to check it against.
- **TDS receivable:** what clients deducted (from receipts, step 3) by client TAN and quarter, matched against a 26AS
  or AIS extract uploaded as Excel (deductor TAN, amount, TDS): matched, short, missing.
- **Tests:** two months of 194C and 194I deductions deposited in two challans; the quarter's 26Q rows; a receivable
  matched, one short and one missing.

## Step 7 in detail (planned before building)

**Goal:** the bank ledger agrees with the bank's statement, and the difference is explained line by line.

- **Statement import** for a bank ledger: **CSV or Excel** with a column mapping saved per bank ledger (date, narration,
  reference, withdrawal, deposit, or one signed amount; balance; the date format); **OFX** (`STMTTRN`: date, amount,
  FITID, cheque number, name and memo); **MT940** (`:61:` value date, credit or debit, amount, reference; `:86:`
  narration). Each line is kept with a fingerprint (date, amount, reference, narration, balance); a line seen before
  is skipped, and a file whose every line was imported before is refused.
- **Matching:** each statement line against the bank ledger's voucher lines not yet reconciled, the same way round
  (a deposit against a debit to the bank, a withdrawal against a credit). **Suggested:** the same amount within 7 days
  of the voucher date, best first when the cheque or UTR number in the statement appears in the voucher's reference
  or narration; confirmed by hand, one statement line against one or more voucher lines that add up to it. A match
  is undone with a reason (both sides open again).
- **One click for what only the bank knows:** an unmatched statement line becomes a voucher (bank charges, interest,
  any ledger chosen): withdrawal: the ledger Dr, the bank Cr; deposit: the bank Dr, the ledger Cr; dated as on the
  statement and matched at once.
- **Bank reconciliation statement** as at a date: balance per the books; add cheques issued and not yet presented;
  less deposits not yet credited; less charges and add credits on the statement not yet in the books; the balance as
  per the bank, set against the statement's own closing balance on that date where the file carries balances.
- **`BankAdapter`** (docs/03-architecture.md §14): the interface for a live statement feed, with only a mock adapter
  (a bank's API needs a commercial agreement; none is bundled).
- **Rights:** `accounts.view` sees statements, matches and the reconciliation; `accounts.post` imports, matches and
  makes vouchers.
- **Tests:** a month's statement (CSV) for a bank ledger with receipts, payments, a cheque not yet presented, a deposit
  in transit and bank charges: suggestions, matches (one to two vouchers), charges posted in one click, the
  reconciliation statement agreeing with the statement's balance; the same file again refused; OFX and MT940 parsed.

## Step 8 in detail (planned before building)

**Goal:** the books give the statements a CA signs, close a year, and leave in Tally's own format. Built in two parts:
**8a** statements, project P&L and year end; **8b** the Tally export, the accounts mode and the exit check for 3a.

**The uncomfortable part first:** [Certain] the app cannot prove Tally accepts its XML: Tally Prime is a paid product
and is never bundled or used in tests. The export follows Tally's published XML import format and is checked for
shape in tests; the first pilot's import into its own Tally is the real check, recorded as an open item.

### 8a Statements and year end

- **Schedule III mapping:** every top group of the chart maps to a Schedule III line (share capital; other equity;
  long-term borrowings; short-term borrowings; trade payables; other current liabilities (with duties and taxes);
  short-term provisions; property, plant and equipment; inventories; trade receivables; cash and cash equivalents;
  short-term loans and advances; revenue from operations; other income; cost of materials consumed; subcontract and
  labour; employee benefits; finance costs; depreciation and amortisation; other expenses (site and other)). A group the
  admin adds sits under its top group's line.
- **Profit and loss** for a period and **balance sheet** as at a date, by company, each with the previous year
  beside it; the profit not yet closed shown in other equity, so the balance sheet balances before and after the
  year is closed; as Excel.
- **Cash flow (indirect method)** for a period: profit, depreciation added back, the change in working capital
  (inventories, receivables, advances, payables, other liabilities, provisions); investing (fixed assets); financing
  (capital, reserves other than the year's profit, borrowings); the net change equal to the change in cash and bank.
- **Project P&L**, every project of a company for a period: revenue (contract revenue less credit notes, by project),
  costs by group (materials, subcontract, site, other) and by cost code, the margin; and billed (invoiced) against
  certified, received and outstanding.
- **Year end** for a financial year: the closing stock (the stores' valuation as at 31 March offered, typed or
  confirmed) posted as stock Dr, material consumption Cr on 31 March, and reversed on 1 April; then every income and
  expense ledger closed into the profit and loss account (a `year_end` voucher); then the twelve months locked. Done
  once a year; the statements leave the `year_end` voucher out of the year's profit.
- **Rights:** `accounts.view` sees the statements; the admin closes the year.
- **Tests:** a year's books by hand (capital, a loan, a plant bought, depreciation, a client billed and paid, a
  supplier billed and part paid, expenses): P&L, balance sheet balanced, cash flow agreeing with the bank and cash;
  two projects' P&L; the year closed with closing stock, the balance sheet unchanged by the close, the next year
  opening with the stock reversed and the months locked.

### 8b Tally export and the exit check

- **Tally XML** for a company and a period: masters (groups under Tally's own primary groups by Schedule III line,
  ledgers with opening balances, parties with GSTIN, state and address) and vouchers (type, number, date, narration,
  reference, each ledger entry with Tally's sign convention), one file to import into Tally Prime.
- **Accounts mode** per tenant (admin): (a) native books; (b) native books and the Tally export; (c) Tally holds the
  books: typed-in vouchers are refused (bills, receipts and payments still post, to be exported), the export is the
  way out. The live Tally link is Wave 6.
- **Exit check for 3a**, as an integration test: a project billed to a client, certified and paid; a supplier's bill
  and a subcontract bill passed and paid in a run; GST registers and GSTR-1, TDS challan and 26Q produced; the bank
  reconciled; the trial balance, P&L and balance sheet agreeing; the Tally XML well formed with every voucher in it.

## Step 9 in detail (planned before building)

**Goal:** every asset the company owns is on a register, depreciated twice (the books by the Companies Act, tax by
the Income Tax Act's blocks), moved between sites, and sold with its gain or loss.

- **Asset classes**, seeded and editable by the admin: a Schedule II useful life (years), the books' method (straight
  line or written-down value), a residual value (5%), the Income Tax block's rate, and the fixed asset ledger it sits
  in. Seeded [Guessing, for the CA]: buildings 30 years / 10%; plant and machinery 15 years / 15%; construction
  equipment (concreting, crushing, piling, road making) 12 years / 15%; motor vehicles 8 years / 15%; furniture 10
  years / 10%; office equipment 5 years / 15%; computers 3 years / 40%.
- **The register:** an asset number (FA/2026-27/0001), name, class, company, the supplier's bill it came on (a
  posted bill line to a fixed asset ledger) or an opening asset (with its depreciation to date), purchase and
  put-to-use dates, cost, the site and project it stands at, a custodian. Registering posts nothing (the bill or the
  opening balances already did).
- **Depreciation run** for a company up to a date (a month or the year): each asset from where its last run stopped
  (or its put-to-use date) to the date or its disposal, by its class's method and life, day by day (over the days of
  the financial year), never below the residual value; posted as one journal: depreciation Dr (on each asset's project), the asset's
  ledger Cr. A run is undone by reversing its voucher (the assets fall back).
- **Income Tax depreciation** for a financial year, by block: opening written-down value, additions used 180 days or
  more (full rate) and fewer (half rate), sales, depreciation and the closing value; reported, not posted.
- **Transfers** of an asset to another site and project, dated, kept as history; depreciation goes to the project it
  stood at.
- **Disposal:** a date and the proceeds (into a bank or from a buyer); depreciation to that date first; posted: the
  bank or buyer Dr the proceeds, the asset's ledger Cr its book value, the difference to "profit or loss on sale of
  assets".
- **Rights:** `accounts.view` sees the register; `accounts.post` registers, runs, transfers and disposes; the admin
  edits classes.
- **Tests:** a bill's line capitalised and an opening asset; a run for the year (straight line and WDV, a part year, a
  transfer mid-year splitting the charge between projects); a run reversed; the tax blocks with a half-rate addition
  and a sale; a disposal at a gain and one at a loss.

## Step 10 in detail (planned before building)

**Goal:** every machine on every site is known: whose it is, where it is, how many hours it worked or stood idle,
what fuel it drank, when it is due for service, and what it cost each project.

- **Equipment register:** a code, name, category (excavator, crane, mixer, vehicle, pump, other), the meter it is read
  by (hours or km); **own** (linked to its fixed asset, step 9; an internal rate per hour charged to projects) or
  **hired** (the supplier, a rate per hour, day or month, a monthly minimum of hours, whether the operator and the fuel
  are the hirer's or ours); a fuel norm in litres per hour (or per km).
- **Allocation** to a project and site from a date; one place at a time.
- **Log sheets:** a day's opening and closing reading, hours worked (the reading's difference for an hour meter),
  idle hours with the reason, breakdown hours, the operator; one a day per machine, on the project it was allocated to
  that day. The **daily site report** (Wave 2b step 7) shows the day's log sheets of its site beside the hand-typed
  equipment rows.
- **Fuel** issued from stores against a machine (a stock issue names the equipment); consumption per hour (or km) for
  a period against the norm, flagged when more than 20% off.
- **Maintenance:** plans by hours or days (an oil change every 250 hours, an inspection every 90 days) with what is
  due or overdue; service and breakdown records (date, reading, what was done, downtime, cost).
- **Costing:** for a month, **own** machines' hours on each project at their internal rate, posted as one journal
  (equipment charges Dr by project, equipment recovered Cr); **hired** machines' hire bill worked from the log sheets
  (hours, with the monthly minimum; days worked; or the month pro rata to the days allocated), entered as a supplier's
  bill (step 4) with a line for each project.
- **Rights:** whoever may write the project's daily report keeps its log sheets; `accounts.view` sees the
  register; `accounts.post` manages the register, allocations, maintenance and the month's costing.
- **Tests:** an own excavator and a hired crane: allocations, a month's log sheets (one with a breakdown); fuel issued
  and the consumption flagged; a plan falling due by hours; the month's internal charge (by project) and the hire bill
  with the minimum applied; the daily report showing the logs.

## Step 11 in detail (planned before building)

**Goal:** the company knows its people: who they are (with the statutory numbers payroll needs, and no more personal
data than the law allows), what they are called and what that lets them do, where they worked each day, and what
leave they have. Step 12's payroll reads all of it.

- **Designations** (a company-wide list: "Site engineer", "Purchase head"): each may carry **extra permissions** on top
  of its holders' role (a worker who is the store keeper gets `stores.manage`), and approval rules may name a
  designation as the approver: any active user whose employee record holds it (never the submitter). This is the
  "custom roles" of P2: the three sign-in roles stay, and a designation adds to them, never takes away.
- **Employees:** a code, name, gender, date of birth, phone, email, address; the company (entity) that employs them;
  staff or worker; joining (and leaving) date, grade, designation, department, reporting manager; the sign-in user, if
  they have one (one employee per user). **Statutory:** PAN (checked), UAN, ESI number; **Aadhaar** under the DPDP
  Act: only its last four digits, and only with the date the employee consented, never the full number. **Bank:** the
  account number, IFSC (checked) and bank name, for step 12's transfer file.
  - PAN and the bank account are shown in full only to whoever has `hr.edit`; others with `hr.view` see them masked.
- **Holiday calendars:** a company's calendars, each with its working week and named holidays for a year; one is
  the default, and a site may follow another (Wave 2a's sites gain a calendar and, for the phone, a location).
- **Deployment:** where an employee works from a date (a project and site, or the head office), oldest first, one
  place at a time (as equipment's allocation). The day's place decides the attendance site, the calendar, and step
  12's cost split.
- **Attendance**, one row a day per employee: present, half day, absent, or on duty elsewhere, with in and out times
  and where it came from:
  - **Register:** a site's day marked for the employees deployed there, by someone on the project's team with
    `attendance.mark`.
  - **Biometric import:** a device's export (CSV or Excel: employee code, date and time of each punch), first punch
    in and last out; four hours or more is present, less is a half day, a single punch present but flagged.
  - **Phone:** an employee with a sign-in marks themselves in and out, with the phone's location, checked against
    their site's location and radius; outside it, the mark stands but is flagged.
- **Leave:** types (casual, sick, earned; paid or not; days a year; accrued monthly or credited on 1 January; how
  many carry forward), applications for a day, a half day or a range (counting only the employee's working days),
  approved through the approval rules (document type "Leave application"); balances (opening, accrued, taken,
  pending, available); a year closed by carrying the capped balance forward. An approved leave and a marked present
  on the same day are refused.
- **The month:** each employee's days (present, half, paid leave, unpaid leave, holidays, weekly offs, absent) and
  their payable days, the input step 12 needs.
- **Rights:** `hr.view` (the register, attendance, leave, the month), `hr.edit` (employees, designations,
  calendars, deployments, leave types, imports), `attendance.mark` (a site's register, as the project's lead or
  member). Everyone signs their own phone attendance and applies for their own leave.
- **Tests:** employees with masked fields and the Aadhaar rule; a designation that grants a permission and approves a
  requisition; deployment history; a site's register, a biometric file and a phone check-in (in and out of the
  radius); leave applied, approved, counted around a holiday and a weekly off, refused over the balance and against
  attendance; carry forward; the month's summary worked by hand.

## Step 12 in detail (planned before building)

**Goal:** a site's staff paid for a month: earnings by their payable days (step 11), PF, ESI, professional tax,
labour welfare fund and TDS on salary deducted by rules with effective dates, the cost charged to the projects they
worked on, payslips, the bank file, and the statutory files. Built in two parts: **12a** the rules, salaries and the
monthly run; **12b** the statutory files, full and final settlement and the 3b exit check.

**[Certain] The rules moved recently and will move again.** Checked when planning (October 2026), from secondary
sources, each [Guessing] until a payroll practitioner confirms:
- The **Code on Wages** (in force from 21 November 2025): "wages" are basic, dearness and retaining allowance; when
  the other allowances pass half of the pay, the excess counts as wages too (for PF and gratuity).
- **EPF:** 12% employee; employer 12%, of which 8.33% to the pension scheme (on wages up to the ceiling) and the rest
  to EPF; EDLI 0.5% and admin charges 0.5%. The wage ceiling reportedly rose from ₹15,000 to **₹25,000 from 17
  September 2026**; employees above it contribute on the ceiling unless the company chooses actual wages.
- **ESI:** 0.75% employee and 3.25% employer of gross wages, for those earning up to ₹21,000 a month (an employee
  covered at the start of a contribution period, April–September or October–March, stays covered to its end).
- **Professional tax**, by the state of the place of work: Maharashtra ₹175 from ₹7,501, ₹200 from ₹10,001 (₹300 in
  February); women nil up to ₹25,000. Other states as data.
- **Labour welfare fund** by state (Maharashtra: June and December).
- **TDS on salary** (section 392 of the Income-tax Act, 2025, from 1 April 2026; 192 before): the new regime by
  default (nil to ₹4 lakh, then 5% to 30% in ₹4 lakh steps above, 30% over ₹24 lakh; standard deduction ₹75,000;
  rebate to ₹12 lakh; 4% cess), the old regime on the employee's choice with their declared deductions.

**12a:**
- **Compliance rules:** a table of rules by kind (PF, ESI, PT, LWF, income tax, the wages rule), state where it
  applies, and the date from which it applies, holding its figures; seeded with the above; a new version added by
  whoever keeps HR, never an old one changed. A month is worked by the rules in force on its last day.
- **Pay components:** earnings (basic, DA, HRA, conveyance, special, …; whether each counts as "wages", is taxable,
  is cut for unpaid days) and the employee's **salary** from a date: each component's monthly amount (or a percent of
  basic); whether PF applies and on what (the ceiling or actual wages); the tax regime and, under the old one, the
  year's declared deductions.
- **The monthly run** for a company: each employee in service that month, their payable days (step 11) over the
  month's days, earnings cut for the rest, **arrears** typed in (taxable earnings), other deductions (advances,
  canteen); PF, ESI, PT, LWF and TDS worked; net pay. **TDS:** the year's taxable salary projected (paid so far in
  the financial year, plus this month for the months left), less the standard deduction (and old-regime
  deductions), taxed by the slabs with the rebate and cess, less TDS deducted so far, spread over the months left.
  Draft, recalculated freely; **approved** through the approval rules (document type "Payroll run"); then posted.
- **Posting** (one voucher): salaries and employer contributions Dr, split by project in proportion to the
  employee's payable days at each deployment (the head office's share without a project); net pay, PF, ESI, PT, LWF
  and TDS payable Cr (new seeded ledgers). **Paid** from a bank ledger: a payment voucher and the **bank file**
  (account, IFSC, name, amount, CSV).
- **Payslips:** each employee's slip as a printable page (the browser's print to PDF; no paid PDF service).
- **Rights:** `payroll.run` (new; the run, salaries, posting and paying; managers off by default); employees see
  their own payslips.

**12b:**
- **PF ECR** text file (the EPFO's #~# format: UAN, name, gross, EPF, EPS and EDLI wages, contributions, days not
  paid), **ESI** monthly contribution data (Excel), **Form 16** (Form 130) year data per employee, and the monthly
  **TDS on salary** summary for the quarterly return.
- **Full and final:** the last month's pay, **gratuity** (15 days' wages for each completed year at the last
  wages ÷ 26, from five years' service, or one year for fixed-term staff; capped at ₹20 lakh), **leave encashment**
  (earned leave balance × wages ÷ 26), **notice** pay recovered or paid; posted.
- **Exit check for 3b:** a site's staff paid for a month with every figure worked by hand, recorded as open for a
  payroll practitioner's review.
- **Tests:** the rules by date (the ₹25,000 ceiling either side of 17 September; the 50% wages rule); TDS under both
  regimes by hand; a run with unpaid days, arrears, an ESI-covered worker, a PT February; the voucher by project;
  the ECR line format; a gratuity and encashment by hand.

## Step 13 in detail (planned before building)

**Goal:** the contract labour on a site is known by name each day; what the contractor owes them is worked out and
checked against the minimum wage before their bill is passed; the registers an inspector asks for print from the
same data; BOCW cess is tracked to payment.

- **Labour contractors:** a supplier (step 4's party) with its CLRA licence (number, the worker count it allows,
  valid to), and its BOCW registration; a licence lapsing within 30 days, or exceeded, is flagged.
- **Workers:** each contractor's people: name, father's or husband's name, sex, date of birth, trade, skill
  (unskilled, semi-skilled, skilled, highly skilled), daily wage, the last four digits of Aadhaar with consent (the
  DPDP rule of step 11), UAN and ESI number if any, joined and left.
- **Minimum wages** as data with effective dates: a state, a skill and a daily rate (with the zone or class the
  notification uses as text). None is seeded: the tenant enters its state's notification. [Certain] Rates are
  revised twice a year (variable dearness allowance); a rate I typed from memory would be wrong.
- **Daily muster** by site: each worker present, half day or absent, with overtime hours; one muster a day per site
  and contractor. The **daily site report** shows the day's muster counts by contractor and trade beside its typed
  manpower rows.
- **Wage sheet** for a contractor, site and month: each worker's days, wages at their rate, overtime at twice the
  ordinary hourly rate (the day's wage ÷ 8), gross; the minimum wage for their skill in the state on the month's last
  day and the shortfall when their rate is below it (flagged, the sheet not passed); deductions as the contractor
  reports them (PF, ESI, advances); net. **Verified:** the contractor's proof of payment (date, reference, mode) is
  recorded against the sheet; a subcontract bill (step 5) of that contractor shows whether its months' sheets are
  verified, and certification warns when one is not.
- **Registers** (Excel), for a contractor and site: the register of workmen employed by the contractor, the muster
  roll, and the register of wages (CLRA Forms XIII, XVI and XVII in the central rules; [Guessing] states use their
  own numbering and columns).
- **BOCW cess:** for a project, the cost of construction booked to date (its expenses in the ledger) at 1%, the cess
  deducted from subcontract bills (step 5), the cess paid (challans recorded with a voucher: labour cess payable Dr,
  bank Cr), and the balance.
- **Rights:** `labour.manage` (new: contractors, workers, minimum wages, wage sheets, cess payments; managers on by
  default); the project's team with `attendance.mark` keeps its sites' musters.
- **Tests:** a contractor with a licence near expiry; workers; a month's musters with overtime; the wage sheet worked
  by hand with a worker below the minimum wage flagged; verification; the registers' rows; the daily report's
  counts; the cess register and a challan posted.

## Step 14 in detail (planned before building)

**Goal:** what was built was checked and passed before it was billed; tests are recorded against their acceptance
criteria and a failure is followed to closure; materials and makes are approved before they are bought.

- **Inspection requests** (RFI) for a project: the site asks the client's engineer to inspect a BOQ line's work (its
  location, the activity), at a date; the request takes the measurement-book entries of that line not covered by an
  earlier request; the inspector's decision is recorded: approved, approved with comments, or rejected (with the
  comments). **Hold from billing** (a project setting): when on, a client bill (step 2) counts only measurements
  covered by an approved inspection.
- **Checklists:** company templates by work type (items answered yes/no, a number within limits, or a note; some
  required); a filled checklist for a project and site (optionally for an inspection), answered on the phone with
  photos; a "no" or an out-of-limit number on a required item fails it.
- **Test records** for a project: concrete cubes (the grade, cast date, three specimens at 7 and 28 days), slump,
  reinforcement steel (yield, tensile strength, elongation), soil compaction, bricks (compressive strength); each
  judged against its criteria; a failure raises an NCR. [Guessing] The criteria are IS 456 (concrete: a 28-day sample,
  the mean of its three cubes, at least fck − 3 N/mm² for M20 and above, no cube more than 15% from the mean; 7 days
  indicative only, about 65% of fck), IS 1786 (Fe 500: yield ≥ 500, tensile ≥ 1.08 × yield and ≥ 545, elongation ≥
  12%), the specified compaction (95% by default) and slump range, and IS 1077 (the brick's class): held as data a
  quality engineer can change.
- **NCRs:** numbered per project; from a test, an inspection or raised by hand; the non-conformance, root cause,
  corrective action, who acts and by when; action taken, then **closed** by someone other than whoever took the
  action (verification).
- **Snag lists** by area or room, with photos; open, fixed, closed.
- **Material approvals:** a sample or make submitted for a project's item (the resource), approved or rejected; an
  item can be marked as needing an approved make, and a purchase order (Wave 2b) for it is then refused submission
  without one.
- **Rights:** `quality.manage` (new; templates, test criteria, decisions, NCR closure, material approvals; managers on
  by default); the project's team raises inspections, fills checklists, records tests and snags.
- **Tests:** an inspection covering two MB entries, rejected, then a second approved; a client bill with the hold on
  and off; a checklist failed and passed; cubes passing and failing (an NCR raised and closed by another person);
  steel and slump; a snag; a make required and a PO refused, then approved.

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

## Step 2 delivered: client RA bills

**Journey:**
- A project's page has **Client bills**: the contract terms in one line, the bills (RA 1, RA 2, …) with their status,
  work done, invoice total and net payable, and **New RA bill**.
- **Contract terms:** GST % (18 by default), retention % with an optional cap, the mobilisation advance and the % of
  each bill that recovers it, and escalation components (name, share %, base index) with the factor (0.85 by
  default). Each bill keeps a copy of the terms it was made under.
- **A bill** is made up to a date (and for a site, when the project has several: the site decides CGST and SGST or
  IGST). It takes every priced item of the live contract BOQs measured to that date, less what the previous certified
  bill certified. The quantity billed to date can be lowered (measured to date is shown beside it); the escalation
  indices for the period and other deductions (with their ledgers) are entered; **Save and work out** shows the
  abstract; **Take the measurement book again** starts the quantities over.
- **Submit the bill:** under the approval rules for client bills (none: straight to the client; above a rule's amount:
  waiting for approval, as requisitions do). A new bill waits until this one is certified or cancelled.
- **The client's certificate:** the date, the certificate number, and each line's certified quantity to date (often
  less). The bill is worked again on the certified quantities, becomes a **tax invoice** (INV/2026-27/0001, per
  company and year) and posts a sales voucher. "Submitted for … certified … less" shows the difference.
- **Print** and **Excel** (an abstract sheet and the items with previous, this-bill and cumulative quantities).

**What it posts on certification:** the client Dr the net payable; retention receivable Dr the retention; mobilisation
advance received Dr the recovery; each other deduction's ledger Dr; contract revenue Cr the taxable value; output CGST
and SGST, or IGST, Cr. Every line names the project and site. The voucher cannot be reversed by hand ("posted by a
document"); a certified bill is corrected by a credit note (step 6).

**Who does what:** new `billing.edit` (managers by default), for the project's lead and members (or those who edit
projects). The team reads the bills.

**Decisions made while building (change any you disagree with):**
- **[Likely] Tax invoice on certification,** dated the day of the certificate. Firms that invoice on submission need a
  setting; none was built.
- **[Likely] Deductions never reduce the taxable value;** retention and advance recovery are on the gross value of work.
- **[Likely] Only priced contract BOQ items are billed** (provisional sums and items without a rate wait for
  variations, Wave 4).
- **[Likely] The next bill starts from the last certified quantities,** not from what was billed.
- **[Certain] A company GSTIN, the project's client and the site's GST state are required** before a bill is made.
- **[Guessing] Escalation as CPWD 10CC-style:** value × factor × share × (index − base) ÷ base per component, rounded
  to the paisa per component. Check against a real contract.

**API** (under `/api/tenant`):
- `GET /projects/:id/client-bills` (with the terms); `POST /projects/:id/bill-terms`.
- `POST /projects/:id/client-bills` (`{upto, siteId}`); `GET|POST /client-bills/:id` (quantities, indices,
  deductions).
- `POST /client-bills/:id/refresh|submit|certify|cancel`; `GET /client-bills/:id/xlsx`.

Migration `0037_client_bills.sql`.

**Tests:**
- 2 API integration tests, every figure by hand:
  - RA 1: ₹49,000 of work, escalation ₹2,707.25 (materials and labour by the formula), CGST and SGST ₹4,653.65 each,
    retention ₹2,450, advance ₹4,900, a 1% cess ₹490: net ₹53,174.55. Certified with PCC at 4 cum not 5: net
    ₹47,041.47, posted as a sales voucher of ₹54,041.47 a side. Refused: billing before the project has a client or
    the company a GSTIN; a second bill while the first is open; cancelling a certified bill; reversing its voucher.
  - RA 2 from RA 1's certified quantities: ₹1,99,600 with retention held to the ₹10,000 cap (₹7,830) and ₹19,960 of
    advance: net ₹2,07,738. RA 3 at a site in Gujarat (IGST ₹28,530), brickwork billed below what was measured, no
    retention left, waiting for approval above ₹1 lakh and approved by the admin. The project's trial balance:
    contract revenue ₹2,45,397.85, the client ₹2,54,779.47, retention ₹10,000. The bill as Excel.
- A browser test: the company's GSTIN, a client, a tender won and made a project, 50 cum measured; the terms; RA 1 at
  ₹5,900 with GST and ₹5,650 net, submitted; certified for 40 cum (net ₹4,520, ₹1,130 less) and its voucher.

**For the CA review:** the posting on certification, tax invoice timing, and the escalation formula.

## Step 3 delivered: receivables

**Journey:**
- **Receivables** (Accounts menu), for a company as at a date: each client's outstanding by age (0-30, 31-60, 61-90,
  over 90 days from the invoice date), retention held and mobilisation advance still to recover; the bills
  outstanding with what they received; the receipts; as Excel.
- **Record a receipt:** the client, the date, the bank or cash ledger, the amount received, the TDS the client deducted,
  other deductions (each to its ledger), the UTR or cheque number. The client's open items are listed: each certified
  bill with what is outstanding, each project's retention held, and its mobilisation advance. **Oldest bills first**
  fills the bills in invoice order; the screen shows what is settled and what is still to allocate, and records only
  when they agree.
- **A receipt's page** shows what it settled and its voucher; **Cancel the receipt** (with a reason) reverses the
  voucher and opens the bills again. A bill's page lists what it has received and what is outstanding.

**What it posts:** a receipt voucher: the bank Dr the amount, TDS receivable Dr the TDS, each deduction's ledger Dr; the
client Cr each bill's share (with the bill's project), retention receivable Cr the retention released, mobilisation
advance received Cr the advance (with the project).

**Who does what:** `accounts.post` records and cancels; `accounts.view` reads.

**Decisions made while building (change any you disagree with):**
- **[Likely] Every rupee settled is allocated** (received + TDS + deductions = allocations); unallocated money on
  account waits for a later step if pilots need it.
- **[Likely] A cancellation is dated when it is made,** like any reversal.
- **[Likely] An advance can be received for any amount** on a project of the client; recovery is by the bills (step 2).
- **[Certain] Interest on late payment is not calculated,** as planned; 26AS matching is step 6.

**API** (under `/api/tenant`): `GET /accounts/open-items?entityId&partyId`; `GET|POST /accounts/client-receipts`;
`GET /accounts/client-receipts/:id`, `POST /accounts/client-receipts/:id/cancel`;
`GET /accounts/receivables?entityId&asOf` (`format=xlsx`). A client bill now returns its `receipts`. Migration
`0038_client_receipts.sql`.

**Tests:**
- 2 API integration tests, by hand: a ₹20,000 advance; RA 1 (net ₹14,420) and RA 2 (net ₹21,630) certified; ₹30,000
  received with ₹700 TDS settling RA 1 in full and RA 2 by ₹16,280 (refused: more than RA 1 owes, an unallocated
  amount, a worker); the voucher's lines; retention: ₹2,000 refused against ₹1,750 held, ₹1,000 released; as at 30
  September RA 2 owes ₹5,350 at 51 days, retention ₹750 held, ₹16,500 of advance to recover; as at 15 August ₹36,050;
  the project's trial balance; the payment cancelled and both bills owed again (61-90 and 31-60 days).
- The browser test (with step 2): ₹4,440 received with ₹80 TDS settles the certified bill, oldest first; nothing
  outstanding, ₹200 retention still held.

**Also:** buttons in the forms added since Wave 2b that are not the form's own submit (add a line, remove, cancel,
oldest first) no longer submit the form.

## Step 4 delivered: vendor bills and payables

**Journey:**
- **Payables** (Accounts menu), for a company as at a date: what each supplier is owed, not due and 1-30, 31-60, 61-90
  and over 90 days overdue, with advances not yet applied; the suppliers' bills (all, held, posted, cancelled); the
  payment runs; as Excel.
- **Enter a bill:** the supplier, their bill number (refused if entered before), dates (due 30 days later by
  default), the TDS section (the supplier's by default).
  - **Against an order:** its lines with what was accepted on receipt; quantities and rates billed. The bill is
    matched: a quantity beyond what was accepted (for a work order, ordered) and not billed before, or a rate above the
    order's beyond the tenant's tolerance (0% by default), **holds** the bill with the reasons. Someone with the right
    to post **passes** it with a reason, or cancels it.
  - **Without an order:** each line to an expense ledger, with a project, at its GST rate.
  - GST from the order (CGST and SGST or IGST as on the order), or from the supplier's GSTIN state against the
    company's; none for an unregistered supplier.
- **TDS** worked by the section's data: a bill above the single-bill limit is taxed on itself; once the year's bills
  pass the annual limit, on everything not taxed so far; individuals and HUFs (the PAN's 4th letter) at the lower
  rate; without a PAN at the higher; to the rupee.
- **A bill's page:** lines, GST, TDS, payable and outstanding; why it is held; pass; cancel (a posted bill only while
  nothing is paid, applied or noted against it, by reversing its voucher); **debit note** (value and GST reversed);
  **apply an advance**.
- **Payment runs:** the bank, the date, the bills to pay (each up to what is outstanding and not already in a run;
  "All" fills it) and advances (supplier, project, amount). Submitted under the approval rules for payment runs;
  once approved, the **bank file** (CSV, refused until every supplier has an account number and IFSC) and **mark
  paid**, which posts one payment voucher per supplier. Printable as payment advices.
- **Clients and suppliers** now keep a supplier's TDS section and bank account.

**What it posts:** a bill: each line's ledger Dr (material consumption for purchase orders, subcontract cost for work
orders, the chosen ledger otherwise, each with the project), input tax Dr, the supplier Cr the payable, TDS payable Cr
the TDS (194C, 194J, 194I and 194Q each to its ledger). A debit note: the supplier Dr; the bill's first ledger and input
tax Cr. A payment: the supplier (or advances to suppliers) Dr; the bank Cr. An advance applied: the supplier Dr,
advances to suppliers Cr.

**Who does what:** `accounts.post` enters, passes and cancels bills, raises debit notes, applies advances and makes and
pays runs; payment runs above a rule's amount wait for approval. The admin sets the rate tolerance.

**Decisions made while building (change any you disagree with):**
- **[Likely] Materials are costed when billed,** not when received or issued (see the plan above).
- **[Likely] A held bill does not post** until passed; its quantities still count against what can be billed.
- **[Guessing] The TDS sections, rates and limits** (194C 1%/2% over ₹30,000 a bill or ₹1 lakh a year; 194J 10% over
  ₹30,000; 194I 10% over ₹2,40,000; 194Q 0.1% over ₹50 lakh; 20% without a PAN) are data with dates, for the CA to
  confirm. Lower-deduction certificates are not handled yet.
- **[Likely] The bank file is a plain CSV** (beneficiary, account, IFSC, amount, date, reference); each bank's own layout
  is a later mapping.

**API** (under `/api/tenant`):
- `GET /accounts/tds-sections`; `POST /accounts/payables-settings` (`{rateTolerancePct}`, admin).
- `GET|POST /accounts/vendor-bills`, `GET /accounts/vendor-bills/:id`, `POST /accounts/vendor-bills/:id/pass|cancel|debit-notes|apply-advance`.
- `GET|POST /accounts/payment-runs`, `GET /accounts/payment-runs/:id`, `POST /accounts/payment-runs/:id/submit|cancel|paid`,
  `GET /accounts/payment-runs/:id/bank-file`.
- `GET /accounts/payables?entityId&asOf` (`format=xlsx`). Parties take `tdsSection`, `bankAccountName`,
  `bankAccountNo`, `bankIfsc`.

Migration `0039_payables.sql`.

**Tests:**
- 4 API integration tests, every figure by hand:
  - 60 bags accepted of 100 ordered: V/101 for the 60 at ₹390 matched and posted (₹29,952; its voucher's lines); a
    repeated bill number and a worker refused; V/102 for 30 more at ₹395 held for both reasons, then passed (₹15,168).
  - A contractor (an individual, no GST) under 194C: ₹24,000 (no TDS), ₹36,000 (₹360 on itself), ₹48,000 (the year
    at ₹1,08,000: ₹720 on ₹72,000); a fourth bill beyond the work order held and cancelled. Rent of ₹2,50,000 + 18%
    under 194I without an order: ₹25,000 TDS, ₹2,70,000 payable.
  - A debit note of ₹2,496; a ₹73,096 run waiting for approval, approved by the admin; the bank file refused until
    both suppliers have accounts, then exact; paid in two vouchers; the advance applied to the contractor's bill and no
    more; a paid bill not cancelled.
  - Payables as at 30 September: ₹3,46,448 across three suppliers by age; the supplier's ledger and TDS payable 194C
    (₹1,080) agree.
- A browser test: the company's GSTIN, a bank ledger, a landlord with a bank account; a ₹59,000 rent bill entered and
  posted; a run paying it, approved, its bank file, paid; nothing owed.

**For the CA review:** the TDS data and catch-up rule, costing materials when billed, and the debit note's posting.


## Step 5 delivered: subcontract bills

**Journey:**
- **On a work order's page** (once issued), three new cards:
  - **Subcontract terms:** retention % with an optional cap, advance recovery % per bill, labour cess % (1% by
    default), TDS section (194C by default, 194J or none).
  - **Measurement book:** each line ordered, measured and certified so far; record an entry (item, date, quantity,
    where); an entry is never changed, only **reversed** by an entry the other way (with a reason). The book refuses a
    date in the future, a total beyond the order (revise the order first) or below nothing.
  - **Subcontract bills:** RA bills to date with their status, gross and amount to pay; **New RA bill** up to a date
    (one in the making at a time, not before the last certified bill's date); retention held, released and left;
    **Release retention** (a date and an amount, up to what is held).
- **A subcontract RA bill:** each line's previous (the last certified bill's), to date (from the book, can be lowered,
  not raised beyond what is measured) and this bill's quantity at the order's rate; **back-charges** typed on the
  bill, each to a cost ledger it recovers; the abstract worked out on saving: gross, GST, bill total, less TDS,
  retention, back-charges, labour cess and the advance recovered; net to pay. **Take the book again** re-reads the
  book and the terms. **Submit for certification** under the approval rules for subcontract bills: with none (or once
  approved) it is certified and becomes a supplier's bill in payables (`WO/…/RA-n`), paid in payment runs like any
  other.
- **A quantity below what was certified** before is refused: the earlier bill is corrected with a debit note in
  payables. A certified bill is not cancelled; its supplier's bill is not cancelled in payables either.

**The figures:** gross = Σ (to date − previous) × rate, each line to the paisa; GST as on the order (CGST and SGST, or
IGST, none if unregistered); retention = gross × % up to the cap less what earlier bills retained; advance recovered =
gross × % up to the advances paid to the subcontractor and not yet applied (and the bill's payable); labour cess =
gross × %; TDS by the supplier rules of step 4 on the gross, the year's catch-up included.

**What it posts** (one purchase voucher, dated the bill's "up to" date): subcontract cost Dr each line's amount with
the project, input tax Dr; the subcontractor Cr the bill less TDS, retention, back-charges and cess; retention payable
Cr; each back-charge's ledger Cr; labour cess payable Cr; TDS payable Cr; and the advance recovered, the subcontractor
Dr and advances to suppliers Cr (recorded as an advance applied to the bill). A retention release: retention payable Dr,
the subcontractor Cr, as a supplier's bill (`WO/…/RR-n`).

**Who does what:** the project's team (leads and members, or those who edit projects) with `billing.edit` set terms,
measure, and make and submit bills; approvers under the rules for `subcontract_bill`; `accounts.post` releases
retention.

**Decisions made while building (change any you disagree with):**
- **[Likely] The bill is dated its "up to" date** in the books and for TDS's year, not the day it is approved.
- **[Likely] The book cannot pass the ordered quantity:** extra work is a revision of the order, approved like any.
- **[Guessing] Labour cess is deducted from the subcontractor** on the gross where the terms say so (1% by default),
  credited to labour cess payable; whether the company or the subcontractor bears it is the contract's call.
- **[Likely] A correction to a certified bill is a debit note,** not a negative next bill.
- **[Likely] Retention released carries no TDS or GST:** both were dealt with on the bills it was held from.

**API** (under `/api/tenant`):
- `GET /work-orders/:id/subcontract`; `PUT /work-orders/:id/subcontract-terms`; `POST /work-orders/:id/measurements`;
  `POST /wo-measurements/:id/reverse`; `POST /work-orders/:id/subcontract-bills`; `POST /work-orders/:id/retention-release`.
- `GET|PUT /subcontract-bills/:id`; `POST /subcontract-bills/:id/refresh|submit|cancel`;
  `GET /projects/:id/subcontract-bills`.

Migration `0040_subcontract_bills.sql`.

**Tests:**
- 3 API integration tests, every figure by hand, on a work order of brickwork (100 cum at ₹4,500) and plaster (1,000
  sqm at ₹250) to an individual registered in the state; retention 5% to ₹22,000, advance recovery 10%, cess 1%, 194C;
  a ₹50,000 advance paid in a run:
  - The book with a mistake reversed (and not twice); RA 1 with a ₹2,000 cement back-charge: ₹33,040 billed, no TDS,
    ₹26,560 to pay; over a ₹30,000 rule, approved by the admin; its voucher's ten lines; not cancelled in payables.
  - RA 2 with brickwork lowered to 35 of the 40 measured (41 refused): TDS catches up on the year's ₹4,07,500
    (₹4,075); ₹3,83,015 to pay, certified at once under a ₹5 lakh rule. The book refuses passing the order. RA 3:
    retention only the ₹1,625 left under the cap; ₹46,075 to pay.
  - Retention released (a worker refused, a paisa more refused); RA 1 and the release paid in a ₹48,560 run; the
    trial balance: retention payable nil, ₹4,750 of the advance left, TDS 194C and labour cess ₹4,525 each.
- A browser test: a subcontractor, a work order, 5% retention; the book with a mistake reversed; RA 1 with a
  back-charge (₹31,860 billed, ₹29,740 to pay), certified straight into payables.

**For the CA review:** labour cess deducted from the subcontractor, the bill dated its measurement date, and retention
released without TDS.

## Step 6a delivered: GST

**Journey:**
- **GST** (Accounts menu), for a company and a month:
  - **Returns:** GSTR-3B as the return's tables — 3.1(a) outward taxable supplies; 4(A)(5) input tax, all other;
    4(B)(1) reversed under section 17(5); 4(C) net — and **GSTR-1 for the offline tool**: a workbook with the
    tool's sheets (`b2b`, `b2cl`, `b2cs`, `cdnr`, `hsn(b2b)`, `hsn(b2c)`, `docs`) and headings, dates as dd-MMM-yy and
    the place of supply as "27-Maharashtra".
  - **Outward register:** each tax invoice and credit note (credit notes less), client and GSTIN, place of supply,
    taxable, CGST, SGST, IGST, total; **inward register:** each posted supplier's bill and debit note, with the input
    tax blocked; both as Excel.
  - **GSTR-2B against the purchase book:** the portal's 2B JSON uploaded for the month (replacing an earlier one);
    each 2B invoice matched to a posted bill by GSTIN and bill number (letters and digits only, leading zeros dropped):
    matched, differs (taxable or tax off by more than ₹1), in 2B only; and bills of the month the supplier has not
    filed.
- **A certified client bill** now shows its **e-invoice** (the IRP JSON, schema 1.1, downloaded; the IRN, acknowledgement
  and signed QR recorded and shown with the QR drawn) and its **credit notes** (raised with a date, a reason and a
  value; GST at the bill's rate and supply; each with its own e-invoice). The JSON is refused, naming what is missing,
  without the company's and client's GSTIN, address, city and PIN code and the site's state.
- **Companies** take a city, PIN code and "issues e-invoices"; **clients** a legal name, city, PIN, state and TAN;
  **ledgers** "input tax blocked"; a project's **contract terms** the SAC its invoices carry (9954 by default).

**What it posts:** a credit note: contract revenue and output tax Dr (with the project), the client Cr; what the client
owes on the bill falls by it (receivables honour it). A supplier's bill line to a ledger with input tax blocked: its GST
goes into that ledger instead of input tax.

**Who does what:** `accounts.view` sees the GST page and a bill's e-invoice and credit notes; `accounts.post` raises
credit notes, records IRNs and uploads 2B.

**Decisions made while building (change any you disagree with):**
- **[Likely] B2CL is an inter-state invoice to an unregistered client above ₹1 lakh;** credit notes to unregistered
  clients net into B2CS rather than CDNUR.
- **[Likely] The 3B's 4(A)(5) holds all input tax and 4(B)(1) reverses the blocked part,** as the return's instructions
  since 2022 read; the cash set-off (which credit pays which tax) is left to the portal.
- **[Guessing] The GSTR-1 workbook's headings** follow the offline tool's template as known; to be checked against the
  tool's current sample before the pilot files with it.
- **[Likely] A credit note is limited to what is outstanding on the bill;** a refund after payment is a journal.
- **Not built:** e-way bills (recorded as an open item: the bulk layout should come from a pilot's real file); the 3B
  JSON (the portal's 3B is entered online).

**API** (under `/api/tenant`):
- `POST /client-bills/:id/credit-notes`, `GET /client-bills/:id/gst`, `GET /credit-notes/:id`.
- `GET /accounts/gst/registers?entityId&from&to` (`format=xlsx`), `GET /accounts/gst/gstr1?entityId&period`
  (`format=xlsx`), `GET /accounts/gst/gstr3b?entityId&period`.
- `GET /accounts/e-invoices/:kind/:id/json`, `POST /accounts/e-invoices/:kind/:id` (`invoice` or `credit_note`).
- `GET|POST /accounts/gst/2b?entityId&period` (POST: multipart, field `file`).

Migration `0041_gst.sql`.

**Tests:**
- 4 API integration tests, every figure by hand: four invoices in August (₹41,300 in the state; ₹1,18,000 to
  Karnataka; ₹11,800 to an unregistered client; ₹1,41,600 to an unregistered client in Goa) and a ₹5,900 credit note
  (a worker and an over-large note refused; its voucher; the client's outstanding down to ₹35,400): the outward
  register (₹3,06,800), every GSTR-1 section and the workbook's sheets and first B2B row; purchases of ₹64,000,
  ₹10,500 (food, ₹500 blocked: its voucher has no input tax) and ₹1,18,000 and a ₹2,560 debit note: the inward
  register and GSTR-3B; the e-invoice JSON field by field, the credit note's with its preceding invoice, refusals
  naming what is missing; an IRN recorded; a 2B file with a match (`V-201` against `V/201`), a difference, one only in
  2B and one not filed.
- Browser tests: a credit note on the client bill journey (the receipt then settles ₹4,402) and the e-invoice refused
  for want of the company's address; a ledger with input tax blocked, a hotel's bill to it, the GST page for September
  (₹1,800 blocked, reversed in 3B) and a 2B file uploaded and matched.

**For the CA review:** the blocked-credit list per ledger, B2CL's limit, the 3B layout and the GSTR-1 headings.

## Step 6b delivered: TDS

**Journey:**
- **TDS** (Accounts menu), for a company and a financial-year quarter:
  - **Deducted from suppliers:** each posted supplier's bill with TDS (date, supplier and PAN, section, paid or
    credited, TDS) and the challan that deposited it, or "to deposit"; the 26Q's problems (no TAN, deductions not in a
    challan, deductees without a PAN).
  - **Record a challan:** a section and month with deductions left (the amount shown), the date deposited, BSR code,
    challan serial number, interest and fee, the bank; every open deduction of that section and month goes into it.
  - **Challans** of the quarter; **26Q for the return utility:** a workbook of the deductor, the challans and the
    deductees (PAN, or `PANNOTAVBL` with remark C; section; date; amount; base; rate; TDS; challan).
  - **Deducted by clients:** each client's TDS on receipts of the quarter, by the client's TAN, against a 26AS or AIS
    extract uploaded as Excel (a header row naming TAN and TDS, and the deductor and amount): matched (within ₹1),
    short in 26AS, more in 26AS, not in 26AS, not in the books; clients without a TAN listed apart.

**What it posts:** a challan: TDS payable (the section's ledger) Dr the tax, interest and fees on TDS Dr (a new seeded
ledger, X7090), the bank Cr.

**Who does what:** `accounts.view` sees it; `accounts.post` records challans and uploads 26AS.

**Decisions made while building (change any you disagree with):**
- **[Likely] A deduction is deposited once, in the challan for its section and month;** a challan is not cancelled
  (an error is corrected at the bank and TRACES, then by a journal).
- **[Guessing] The 26Q workbook's columns** are those the NSDL utility asks for, in its order as known; checked against
  the utility before the pilot's first return. The FVU file itself comes from the free utility, as planned.
- **[Likely] Form 16A is downloaded from TRACES**; the deductions list per supplier is what to check it against.
- **[Likely] Clients' TDS is matched by TAN and quarter totals,** not deduction by deduction (26AS has no invoice
  numbers).

**API** (under `/api/tenant`): `GET /accounts/tds/deductions?entityId&from&to[&section]`;
`GET|POST /accounts/tds/challans`, `GET /accounts/tds/challans/:id`; `GET /accounts/tds/26q?entityId&quarter`
(`format=xlsx`); `GET|POST /accounts/tds/credits?entityId&quarter` (POST: multipart, field `file`).

Migration `0042_tds.sql`.

**Tests:**
- 2 API integration tests, every figure by hand: rent of ₹2,50,000 under 194I (₹25,000); a contractor's ₹40,000
  (₹400), ₹20,000 (nothing) and ₹50,000 (₹700 on the ₹70,000 untaxed once the year passes ₹1 lakh); the 26Q's problems
  before deposit; challans of ₹400, ₹25,000 and ₹721 (₹21 interest; its voucher), a worker, a repeat and a duplicate
  serial refused; the 26Q's challans, deductees and workbook. Clients' TDS of ₹1,000, ₹2,000 and ₹500 against a 26AS
  extract: matched, short by ₹200, no TAN, and a deductor not in the books.
- A browser test: a landlord's ₹2,50,000 rent bill, its ₹25,000 shown to deposit, the challan recorded, the 26Q
  workbook downloaded.

**For the CA review:** the 26Q columns, interest and fees posted to one ledger, matching clients' TDS by quarter.

## Step 7 delivered: bank and reconciliation

**Journey:**
- **Bank** (Accounts menu), for a company and a bank ledger, between two dates:
  - **Statements:** the bank's **column mapping** saved per bank ledger (date, narration, reference, withdrawal and
    deposit or one signed amount, balance, date format); **import** a CSV or Excel statement by it, or an OFX or MT940
    file as it comes; Indian figures (`1,00,000.00`), "Dr"/"Cr" and brackets read; the bank's own header and footer
    rows skipped. Lines seen before are skipped (each counted); a file whose every line was seen is refused.
  - **Statement lines** with what each is matched to; for an open line, up to three **suggested** vouchers (the same
    amount, the same way, within 7 days; those whose reference or number the statement mentions first), **pick
    vouchers** (one or more adding up to the line), or **make a voucher** (a ledger and a narration: posted on the
    statement's date and matched); a match **undone** with a reason.
  - **Reconciliation** as at the "to" date: the books' balance; cheques issued and not presented; deposits not yet
    credited; lines on the statement not in the books; the balance as per the bank, set against the statement's own
    balance, and whether they agree.
- **`BankAdapter`** with only `MockBankAdapter` (no bank's API is bundled: each needs a commercial agreement).

**What it posts:** only the one-click vouchers: a withdrawal, the chosen ledger Dr and the bank Cr (a payment); a
deposit, the bank Dr and the ledger Cr (a receipt).

**Who does what:** `accounts.view` sees it; `accounts.post` sets the mapping, imports, matches, undoes and posts.

**Decisions made while building (change any you disagree with):**
- **[Likely] A voucher and its reversal are left out of matching:** together they never touched the bank.
- **[Likely] A line's fingerprint** is its date, amount, reference, narration and balance, with repeats in one file
  counted, so two identical ₹59 charges on a day are two lines but the same file twice is one.
- **[Likely] Matching is per company:** the vouchers offered are the chosen company's on that ledger.

**API** (under `/api/tenant`): `GET|PUT /accounts/bank/:accountId/mapping`; `POST /accounts/bank/:accountId/statements`
(multipart, field `file`); `GET /accounts/bank/:accountId/statement?entityId&from&to`;
`GET /accounts/bank/:accountId/reconciliation?entityId&asOf`; `POST /accounts/bank-lines/:id/match|post`;
`POST /accounts/bank-matches/:id/undo`.

Migration `0043_bank.sql`.

**Tests:**
- 4 unit tests: amounts and dates as banks write them; a mapped CSV with a bank header and footer; OFX and MT940
  (narration over two lines, the closing balance); fingerprints for repeats and the mock adapter.
- 2 API integration tests, every figure by hand: six September vouchers and a five-line SBI statement; refused
  without a mapping and for a worker; imported; refused the second time; suggestions by reference; one line matched
  to two NEFT payments (one alone refused as not adding up, a second match refused); charges and interest posted in
  one click (PV 5, RV 3); a match undone and made again; the reconciliation (books ₹70,353 + ₹12,000 not presented −
  ₹20,000 not credited = ₹62,353, the statement's balance); a longer file taking only its one new line.
- A browser test: the mapping saved, a statement imported and refused again, two lines made vouchers, the books and
  the statement agreeing at ₹353.

## Step 8 delivered: statements, year end, Tally export and the exit check

**Journey:**
- **Statements** (Accounts menu), for a company:
  - **Profit and loss** for a period and **balance sheet** as at a date in Schedule III's lines, the previous year
    beside them, as Excel; the profit not yet closed shown within other equity (so the balance sheet balances before
    and after the close), and a warning if it ever does not balance.
  - **Cash flow** (indirect method): profit, depreciation added back, each change in working capital, investing,
    financing, the net change, and cash and bank at the start and end; a warning if the flows do not add up.
  - **Projects:** each project with income or costs in the period: revenue, costs (by Schedule III line and by cost
    code), margin and its %, invoiced, received, outstanding.
  - **Year end** (admin): the financial year and the closing stock; closed once: closing stock posted on 31 March and
    reversed on 1 April, income and expenses (by project) closed into the profit and loss account, the twelve months
    locked; the years closed listed.
  - **Tally:** the accounts mode (admin): the app keeps the books; keeps them and exports to Tally; or Tally keeps them
    (typed-in vouchers refused, bills, receipts and payments still post). With the export on: **masters** as at a date
    (groups under Tally's primary groups, ledgers with opening balances, parties with GSTIN, state, PIN and address) and
    **vouchers** for a period, as Tally Prime's XML import takes them.

**What it posts:** the year end: stock Dr, changes in inventories Cr (and back on 1 April); each income and expense
ledger closed against the profit and loss account (a `year_end` voucher, left out of the year's P&L).

**Who does what:** `accounts.view` sees the statements and exports; the admin closes a year and sets the mode.

**Decisions made while building (change any you disagree with):**
- **[Likely] Subcontract and labour is its own line** in the P&L (Schedule III folds it into other expenses; many
  contractors show it apart), and site expenses fall in other expenses.
- **[Likely] Investing activities are worked from fixed assets plus depreciation** (the chart writes depreciation off
  the asset ledger); a separate accumulated depreciation ledger under fixed assets works the same.
- **[Likely] Closing stock is typed or confirmed at the year end** from the stores' valuation; materials are costed
  when billed (step 4), so the stock is a year-end adjustment, reversed the next day.
- **[Likely] The Tally export is two files** (masters, then vouchers), the order Tally imports them in; projects are not
  sent as Tally cost centres yet.
- **[Certain] Tally accepting the files is not tested here** (Tally Prime is paid and never used in tests); the first
  pilot's import is the check (open item).

**API** (under `/api/tenant`): `GET /accounts/statements/profit-and-loss?entityId&from&to`,
`GET /accounts/statements/balance-sheet?entityId&asOf` (both `format=xlsx`), `GET /accounts/statements/cash-flow`,
`GET /accounts/statements/projects`; `GET|POST /accounts/year-end`; `GET|PUT /accounts/mode`;
`GET /accounts/tally/masters?entityId&from`, `GET /accounts/tally/vouchers?entityId&from&to`.

Migration `0044_year_end.sql` (the "Changes in inventories" ledger and role).

**Tests:**
- 2 API integration tests, every figure by hand: a year (₹10 lakh capital, ₹5 lakh loan, ₹6 lakh plant, ₹3 lakh billed
  and paid, ₹1 lakh cement part paid, site overheads, depreciation, interest): P&L ₹90,000; balance sheet ₹16,92,000 a
  side; cash flow ₹2,34,000 + (−₹6,00,000) + ₹15,00,000 = the bank's ₹11,34,000; two projects' P&L. The year closed
  by the admin (a manager and a worker refused, a second close refused) with ₹25,000 stock: profit ₹1,15,000, the
  balance sheet ₹17,17,000 a side and balanced, March locked, April's P&L carrying the stock back.
- **The exit check for 3a** (one integration test): a project's RA bill certified (₹59,000) and paid with TDS; a
  supplier's bill (₹23,600) and a subcontract bill (₹47,200, TDS ₹400) paid in one ₹70,400 run; GSTR-1 and GSTR-3B for
  August; the TDS challan and a clean 26Q; a five-line bank statement matched (charges posted in one click) and
  reconciled to the paisa; the trial balance balanced, P&L (−₹10,059), balance sheet and project P&L agreeing; the Tally
  export refused until turned on (by the admin only), then masters and all eight vouchers well formed, each balanced;
  a typed voucher refused once Tally keeps the books.
- A browser test: three vouchers; the P&L (₹8,000), balance sheet (₹58,000) and cash flow; the year closed.

## Step 9 delivered: fixed assets

**Journey:**
- **Fixed assets** (Accounts menu), for a company:
  - **Register:** each asset's number, name, class, project, cost and book value, disposed ones marked. **Register an
    asset** from a posted supplier's bill (no more than the bill put on the class's ledger) or from the opening balances
    (its depreciation to date and tax written-down value); its project. **Move or sell:** a transfer to another project
    from a date (after its last depreciation), or a disposal for a price into a bank or cash ledger.
  - **Depreciation:** a run up to a date charges every active asset from where it last stopped (an opening asset from
    the books' start), split where it moved and where a year starts, posted as one journal; runs listed, the latest
    reversed with a reason.
  - **Income Tax depreciation** for a financial year, block by block, worked from the books' first year.
- Asset classes (six seeded) are the admin's to change through the API (`/accounts/asset-classes`); a screen for them
  waits for a pilot to ask.

**What it posts:** a run: depreciation Dr by project, each asset's ledger Cr (the chart writes depreciation off the
asset ledger). A disposal: the bank or buyer Dr the price, the asset's ledger Cr its book value, the gain Cr or the loss
Dr "profit or loss on sale of assets" (a new seeded ledger, I2003). Registering posts nothing.

**Decisions made while building (change any you disagree with):**
- **[Likely] A part year is by the days of that financial year** (366 when it holds 29 February), so a full year
  charges exactly the year's depreciation.
- **[Likely] The WDV rate is 1 − (residual ÷ cost)^(1 ÷ life)** to four places (31.23% for 8 years and 5%).
- **[Likely] Only the latest run is reversed,** and not once an asset in it is disposed.
- **[Guessing] The seeded lives and tax rates** (plant 15 years and 15%, construction equipment 12 years, vehicles 8
  years WDV, furniture 10 years and 10%, office equipment 5 years, computers 3 years and 40%) are the CA's to confirm.

**API** (under `/api/tenant`): `GET|POST /accounts/asset-classes`, `PUT /accounts/asset-classes/:id`;
`GET|POST /accounts/assets`, `GET /accounts/assets/:id`, `POST /accounts/assets/:id/transfer|dispose`,
`GET /accounts/assets/tax-depreciation?entityId&fy`; `GET|POST /accounts/depreciation-runs`,
`POST /accounts/depreciation-runs/:id/reverse`.

Migration `0045_fixed_assets.sql`.

**Tests:**
- 3 unit tests: straight line split by a transfer (₹2,394.52 and ₹2,342.47 of ₹9,500 a year); WDV across a year end
  (₹3,12,300 then ₹2,14,768.71); the residual floor; a tax block with a half-rate addition and a sale (₹1,05,000).
- 3 API integration tests, every figure by hand: a ₹12 lakh excavator from a bill (a worker and an over-bill refused)
  and a jeep from the opening balances; a year's run of ₹3,21,155.07 (its voucher by project and ledger), refused a
  second time, reversed and run again; the tax blocks (₹1,80,000 and ₹90,000); the jeep sold at a ₹9,840 gain and the
  excavator at a ₹2,28,684.93 loss (their vouchers); the run then not reversible and the jeep not movable.
- A browser test: the jeep registered, a year's ₹2,49,840 run, the jeep sold.

## Step 10 delivered: equipment and fleet

**Journey:**
- **Equipment** (Accounts menu), for a company:
  - **Register:** each machine (code, name, category, hours or km meter), own (an internal rate; optionally its fixed
    asset) or hired (the supplier, by the hour with a monthly minimum, by the day or by the month), its fuel norm, and
    where it is now.
  - **A machine:** where it has been; **allocate** it to a project and site (or the yard) from a date, not before its
    last log sheet; **log sheets** for a day (readings or hours worked, idle with why, breakdown, operator), refused for
    a day it was on no project, a reading below the last one, or more than 24 hours; the month's logs; **maintenance**
    plans by hours or days, what is due, and a service recorded.
  - **Month's costing:** own machines' charge and each hired machine's hire before GST; **post the month** once.
  - **Fuel:** for a month, each machine's work, the litres issued against it, per hour against the norm, flagged when
    more than 20% off.
- A **stock issue** can name the machine it went to (the API's `equipmentId`).
- The **daily report** shows the day's log sheets of its site beside the typed equipment rows.

**What it posts:** the month: equipment charges Dr by project, equipment recovered Cr (two new seeded ledgers, X3005
and X3006, so the company's total cost is unchanged and each project carries its share); a supplier's bill for each
hired machine (`HIRE/<code>/<month>`, its lines on "Equipment hire" by project, GST at 18%).

**Decisions made while building (change any you disagree with):**
- **[Likely] A monthly minimum's shortfall is charged to the project the machine worked most on.**
- **[Likely] Hire by the month is shared by the days allocated** to each project; by the day, the days with hours.
- **[Guessing] GST at 18% on hire** (machinery hire with or without operator); the bill can be changed in payables
  before it is paid.
- **[Likely] Fuel is the quantity issued against the machine,** whatever the item; a store keeps diesel apart.

**API** (under `/api/tenant`): `GET|POST /equipment`, `GET /equipment/:id`, `POST /equipment/:id/allocate`,
`GET|POST /equipment/:id/logs`, `GET /equipment/:id/maintenance?asOf`, `POST /equipment/:id/maintenance-plans|maintenance-records`,
`GET /equipment/fuel?entityId&from&to`, `GET|POST /equipment/costing`.

Migration `0046_equipment.sql`.

**Tests:**
- 3 API integration tests, every figure by hand: an own excavator moved between two projects, a crane hired by the
  hour (minimum 200 a month) and a mixer by the month; log sheets with refusals (overlapping readings, over 24 hours,
  not allocated, a stranger, a move before a log); the daily report showing the log; 400 litres for 26.5 hours (15.09
  against 12: 25.8% over, flagged); an inspection due by days, recorded, and an oil change not yet due by hours;
  September costed: ₹24,750 and ₹15,000 charged to the projects, the crane ₹4,00,000 (17 hours and 183 short of the
  minimum) and the mixer ₹40,000 (20 of 30 days), billed with GST at ₹4,72,000 and ₹47,200; a second posting refused.
- A browser test: a machine added, allocated, a day logged, September posted (₹12,000).

## Step 11 delivered: HR

**Journey:**
- **My attendance** (People menu, everyone): mark yourself **in** and **out** with the phone's location (checked
  against your site's place and radius; away from it the mark stands but is flagged), the last week's marks, your
  leave balances, and **apply for leave** (a day, a half day or a range; withdraw while it waits).
- **Site attendance** (the project's team with `attendance.mark`): a site and a day; everyone deployed there that
  day with their leave, holiday or weekly off; mark present, half day, absent or on duty, with in and out times.
- **Employees** (`hr.view`), for a company:
  - **Employees:** the list (designation, where they work now, their sign-in); **an employee:** the record
    (personal, statutory, bank; PAN and the account shown in full only with `hr.edit` or to the employee),
    **where they work** from each date (**deploy** to a project and site, or the head office), and their leave.
  - **Month:** each employee's month day by day (P, H, L, U, HO, WO, A) with present, half days, paid and unpaid
    leave, holidays, weekly offs, absent and **payable days**, flagged marks counted.
  - **Leave:** applications waiting, approved, rejected.
  - **Import** (`hr.edit`): a biometric device's CSV or Excel file; what was imported and why the rest was not.
  - **Setup** (`hr.edit`): **designations** with the permissions they add; **holiday calendars** (working week,
    holidays, the default); **sites** (calendar, latitude, longitude, radius); **leave types**; **close a leave year**
    (carry balances forward).
- **Approval rules** can name a **designation**: whoever holds it approves (never the submitter). Leave applications
  are a new document type ("Leave application"); with no rules they are approved when applied for.

**Decisions made while building (change any you disagree with):**
- **[Likely] Designations add permissions, never remove them,** and the three sign-in roles stay. "Custom roles" are
  a designation's extra permissions on top of the role.
- **[Likely] `hr.edit` is off for managers by default** (PAN, bank and Aadhaar data); the admin grants it, or a
  designation such as "HR manager" carries it. `hr.view` is on for managers; `attendance.mark` for everyone.
- **[Likely] Aadhaar: only the last four digits, and only with the consent date;** the full number is refused. PAN,
  UAN, ESI number and the bank account are kept as entered (not encrypted in the tenant's database), masked on screen
  to anyone without `hr.edit` but the employee. [Guessing] whether a CA or DPO wants these encrypted at rest.
- **[Guessing] Four hours between the first and last punch (or the phone's in and out) is a full day,** less a half
  day; a single punch is a full day flagged for HR to check.
- **[Likely] No calendar at all means Monday to Saturday,** usual on Indian sites; a site follows its own calendar,
  else the company's default.
- **[Likely] The leave year is the calendar year.** Monthly accrual credits a twelfth on the first of each month in
  service; annual credits the whole on 1 January (or the months left, on joining); rounded down to half days.
  Carry-forward applies to paid types with a cap and never overwrites an opening typed by hand.
- **[Likely] Leave counts only the employee's working days** (holidays and weekly offs inside a range are not
  leave); a day marked present cannot be taken as leave, nor an approved leave day marked present (a half day of
  each may share a day).
- **[Likely] Leave is approved through the approval rules**, not automatically by the reporting manager: the rule
  can name the designation that approves (e.g. "HR manager"). A reporting-manager approver is not built.
- **[Likely] The phone needs a sign-in linked to the employee;** workers without phones are marked on the register
  or by the device.

**API** (under `/api/tenant/hr`): `GET permissions`; `GET|POST designations`, `PUT designations/:id`;
`GET|POST employees`, `GET|PUT employees/:id`, `POST employees/:id/deployments`, `GET employees/:id/leave?year&asOf`,
`PUT employees/:id/leave-openings`; `GET|POST calendars`, `PUT calendars/:id`, `PUT calendars/:id/holidays`;
`GET sites`, `PUT sites/:id`; `GET|POST sites/:id/attendance`; `POST attendance/import`; `GET|POST attendance/me`;
`GET attendance/month?entityId&month`; `GET|POST leave-types`, `PUT leave-types/:id`; `GET|POST leave`,
`GET leave/:id`, `POST leave/:id/withdraw|cancel`, `POST leave/carry-forward`. Approval rules take
`approver: 'designation'` with `designationId`.

Migration `0047_hr.sql` (schema `hr`; sites gain a calendar and a location; approval rules and steps gain the
designation approver).

**Tests:**
- 5 unit tests: weekdays against a working week and holidays; leave accrued by the year and by the month (a March
  joiner's 8.5 of 15 by September); the phone's distance (111 m for 0.001° of latitude, 105 m of longitude at 19°
  north); a device's punches (a full day, a short day, one punch, AM/PM times, unreadable rows) and a single
  date-and-time column.
- 4 API integration tests, every figure by hand: designations (a worker given `hr.view`, a manager `hr.edit`);
  employees with the Aadhaar rule, masked PAN (`••••••234K`) and account, a masked number sent back unchanged,
  a stale version refused; deployment refusals; a site's register (a stranger to the project refused, someone not
  deployed refused), a device file (3 days in, a day already on the register and an unknown code reported), the phone
  1,401 m from the site (flagged) and out within four hours (a half day), the head office without a location; leave
  through the "HR manager" designation: 5 working days around a holiday, refused over the balance (9.5 available
  against 11), on a day worked, twice; an unpaid day; one withdrawn; balances; September: 7.5 and 8 payable days
  worked out day by day; the year carried forward (15, 12.5 and 15 days of earned leave).
- A browser test: a calendar and a leave type set up, an employee deployed, a day on the site's register, a day's
  leave, and September's six payable days.

## Step 12a delivered: payroll rules, salaries and the monthly run

**Journey:**
- **Payroll** (People menu, `payroll.run`), for a company:
  - **Runs:** work a month; the list with each run's state (draft, waiting, approved, posted, paid), staff, gross
    and net.
  - **A run:** the totals (gross, net, PF both shares, ESI, professional tax, TDS, other deductions), anyone without
    a salary named; each employee's days paid, gross, deductions and net, with their **payslip**; **arrears and
    deductions** typed in while a draft (worked again at once); **submit** (approval rules, document type "Payroll
    run"), **post**, the **bank file** (CSV), **pay** from a bank ledger.
  - **Rules:** every version of every rule with its date; a new version added as figures (checked by kind), refused
    once a month from that date is approved.
  - **Components:** earnings and deductions (wages under the Code on Wages, taxable, cut for unpaid days).
- **An employee's page** (`payroll.run`): the **salary** history and a new salary from a date (each component's
  monthly amount; PF on the ceiling, actual wages or not at all; ESI; tax regime and, for the old, the year's
  declared deductions).
- **My attendance:** the employee's own payslips once the run is approved.

**What it posts:** at the month's last day, one journal: salaries and wages Dr and the employer's PF, EDLI, admin
charges, ESI and LWF Dr, **by project** in proportion to each employee's days at each deployment; salaries payable
(net), staff advances (deductions recovered), PF, ESI, professional tax, LWF and TDS payable Cr (six seeded ledgers,
L4006 and L5009–L5013). Paid: bank Cr, salaries payable Dr.

**Decisions made while building (change any you disagree with):**
- **[Likely] The rules in force on the month's last day govern the whole month** (September 2026 is worked on the
  ₹25,000 ceiling from 17 September). Payroll practice differs; a practitioner should confirm.
- **[Guessing] The seeded figures** (checked in October 2026 from secondary sources): the Code on Wages' 50% rule
  from 21 November 2025; EPF ceiling ₹15,000, ₹25,000 from 17 September 2026; ESI ₹21,000, 0.75% and 3.25%;
  Maharashtra PT (women nil up to ₹25,000) and LWF ₹25/₹75 in June and December; income tax for 2025-26 onwards
  (new regime default, rebate to ₹12 lakh with marginal relief; old regime rebate to ₹5 lakh). Every one is the
  practitioner's to confirm before a tenant relies on it; correcting one is a new version.
- **[Likely] Pay is by calendar days:** each component cut by payable days over the month's days, to the rupee.
- **[Likely] PF and ESI to the rupee as the authorities do:** PF rounded, ESI rounded up; the employer's EPF share is
  12% less the pension share. PF wages are worked on the month's regular pay; arrears are not added to PF wages.
- **[Likely] ESI cover is judged on the full month's salary at the start of the contribution period** (April or
  October) and holds to its end.
- **[Likely] Professional tax and LWF follow the state of the site the employee is at on the month's last day**, else
  the company's state; an employee with no sex recorded is charged the men's slabs.
- **[Likely] TDS projects the year from this month's regular pay** (earlier approved months, this month, and the
  same for the months left), taxes one-off pay (arrears) in full in its month, and spreads the rest evenly. The old
  regime takes the declared deductions as one figure; PT and the employee's PF are not deducted automatically.
- **[Likely] The cost split is by deployed days** in the month (calendar days in service at each project).
- **[Likely] Payslips are a printable page** (the browser's print to PDF), so no PDF service is needed.

**API** (under `/api/tenant/payroll`): `GET|POST rules`; `GET|POST components`; `GET|POST employees/:id/salary`;
`GET|POST runs`, `GET runs/:id`, `POST runs/:id/work|submit|post|pay`, `POST runs/:id/adjustments`,
`DELETE runs/:id/adjustments/:adjustmentId`, `GET runs/:id/bank-file`, `GET runs/:id/payslips/:employeeId`,
`GET payslips/mine`. HR's `GET attendance/month` is unchanged; payroll reads the same days.

Migration `0048_payroll.sql` (schema `pay`).

**Tests:**
- 6 unit tests: wages under the 50% rule; PF on the ₹15,000 and ₹25,000 ceilings and on actual wages; ESI rounded
  up and its periods; Maharashtra PT by slab, sex and February; income tax under both regimes (₹12.1 lakh: ₹10,400
  with marginal relief); a month's TDS (₹12,567, and ₹22,967 with ₹50,000 arrears).
- 3 API integration tests, every figure by hand: three staff for September 2026 from a device's file: Suresh (₹2
  lakh, ₹50,000 arrears, an advance of ₹5,000, split between two projects; TDS ₹19,500; net ₹2,22,300), Raju (27
  of 30 days, ESI ₹122 and ₹527; net ₹14,258), Meena (the 50% rule: wages ₹40,000; PF on actual wages; the old
  regime; net ₹75,000); totals; a rule refused for an approved month; the voucher (₹3,56,858, salaries ₹2,21,200 and
  ₹1,25,000 by project); the bank file; paid from the bank; Raju's own payslip and not Suresh's.
- A browser test: a salary set, September imported, the run worked (₹17,250 net), approved, posted, the payslip.

## Step 12b delivered: returns, full and final, and the 3b exit check

**Journey:**
- **A run** (approved or later): **PF ECR** (the EPFO's #~# text file; members without a UAN named), **ESI file**
  (the ESIC's monthly contribution sheet: IP number, name, days paid, wages, reason code).
- **Payroll › Year:** each employee's financial year for **Form 16 (Form 130)**: salary, the standard deduction,
  declared deductions (old regime), taxable income, TDS by quarter (the figures for the quarterly salary TDS
  return).
- **An employee who has left** (their record's leaving date): **full and final**: gratuity, earned leave encashed,
  notice paid or recovered; worked again freely while a draft; **posted** on the last day (salaries and wages Dr on the
  project they last worked on, salaries payable Cr), then paid like any payment.

**Decisions made while building (change any you disagree with):**
- **[Guessing] Gratuity under the Code on Social Security:** 15 days' wages (wages ÷ 26) for each year counted (a part
  year over six months counts), from five completed years, or one for **fixed-term** staff (a new flag on the
  employee), capped at ₹20 lakh; a rule with an effective date like the others.
- **[Guessing] Leave encashment** at wages ÷ 26 a day on the chosen leave type's balance at the last day; **notice** at
  the month's gross ÷ 30 a day. Neither is taxed by the settlement (exemptions differ by case); the practitioner
  decides.
- **[Likely] A settlement that nets to nothing or less is not posted:** the notice recovery then belongs in the last
  month's run as a deduction.
- **[Guessing] The ECR and ESI layouts** follow the portals' published templates as last known; the portals change
  them, so check on the first real upload.

**API** (under `/api/tenant/payroll`): `GET runs/:id/ecr?format=json|txt`, `GET runs/:id/esi?format=json|xlsx`,
`GET year-form?entityId&year`, `GET|POST employees/:id/settlement`, `POST employees/:id/settlement/post`.

Migration `0049_payroll_settlement.sql` (the gratuity rule, `hr.employee.fixed_term`, `pay.settlement`).

**Tests:**
- 3 unit tests: an ECR line; years of service (six months and a day counts, six does not); gratuity (₹1,03,846 for six
  years at ₹30,000; a fixed-term year; the cap), encashment and notice.
- **The 3b exit check** (2 more API integration tests on the same September): the ECR line for Suresh and the two
  without a UAN; Raju's ESI row; the year's Form 16 data (₹2.5 lakh, ₹1.75 lakh taxable, ₹19,500 in Q2); Suresh
  leaving after six years: gratuity ₹3,46,154, 16 days encashed ₹61,538, 15 days' notice short −₹1,00,000, total
  ₹3,07,692 posted. **Open:** a payroll practitioner's review of every rule and figure above.

**CI:** the Windows installer (~100 MB) is now kept as an artifact from `main` only, for three days, so branch pushes
no longer fill the account's artifact storage (runs 89–90 failed only on that upload).

## Step 13 delivered: labour contractors

**Journey:**
- **Contract labour** (People menu, `labour.manage`): **contractors** (a supplier with its CLRA licence: number, workers
  allowed, valid to; BOCW registration), flagged when the licence lapses within 30 days or has lapsed, or when more
  workers are on the books than it allows; a contractor's **workers** (name, father's or husband's name, sex, trade,
  skill, daily wage, joined; Aadhaar only as its last four digits with consent); its **wage sheets**; **minimum
  wages** (state, skill, zone, from a date: none filled in, the tenant enters its notification); **BOCW cess** for a
  project (the cost booked, 1% due, deducted from subcontractors, paid, balance) and a challan paid from the bank.
- **Labour muster** (the project's team with `attendance.mark`, or `labour.manage`): a site, a contractor and a day;
  each worker present, half day or absent with overtime hours; a worker already on another site that day is refused.
- **A wage sheet** (a contractor, site and month from the musters): each worker's days, wages, overtime at twice the
  ordinary rate (the day's wage ÷ 8), gross and the minimum wage for their skill, with any shortfall; **passing** is
  refused while anyone is paid below the minimum; **verified** with the contractor's proof of payment (date,
  reference, mode); the **registers** (Excel: register of workmen, muster roll, register of wages). Once passed, the
  month's musters are closed.
- The **daily site report** shows the day's muster by contractor and trade; a **subcontract bill** warns of the
  contractor's months not yet verified as paid.

**What it posts:** only cess paid: labour cess payable Dr (on the project), bank Cr.

**Decisions made while building (change any you disagree with):**
- **[Certain] No minimum wage is seeded:** rates change twice a year by state, zone and skill; a figure typed from
  memory would be wrong. With none on record, the wage sheet says so instead of passing silently as compliant.
- **[Likely] The highest zone's rate in force on the month's last day** is the minimum (the safe reading, as a site
  is not tied to a zone yet).
- **[Likely] Overtime at twice the ordinary rate on an eight-hour day.**
- **[Guessing] The registers follow the central CLRA rules' Forms XIII, XVI and XVII;** states number and lay them
  out differently.
- **[Likely] Cess is 1% of the cost of construction** booked to the project (its expense ledgers, to date); cess
  deducted from subcontract bills is shown beside it, not netted.
- **[Likely] Contractors' deductions (their PF, ESI, advances) are not taken on the sheet;** what the principal
  employer checks is the gross against the minimum wage and the proof of payment.

**API** (under `/api/tenant/labour`): `GET contractors`, `PUT contractors/:partyId`,
`GET|POST contractors/:partyId/workers`, `PUT workers/:id`, `GET contractors/:partyId/wage-sheets`,
`GET|POST min-wages`, `GET|POST sites/:id/muster`, `POST wage-sheets`, `GET wage-sheets/:id`,
`POST wage-sheets/:id/work|pass|verify`, `GET wage-sheets/:id/registers`, `GET|POST projects/:id/cess`.

Migration `0050_labour.sql` (schema `lab`).

**Tests:**
- 2 unit tests: a month with half days and overtime against the minimum wage (₹10,125, ₹1,125 short); a licence's
  days left.
- 4 API integration tests, every figure by hand: a contractor with three workers on a licence for two, 20 days from
  its end; the muster (a stranger refused, a day to come refused, a worker on two sites refused), the daily report's
  counts; September's sheet (₹4,125 with overtime, ₹1,575 for Sunita ₹175 below the minimum, ₹2,080; ₹7,780) refused,
  her rate raised, worked again (₹7,955), passed, verified, the month closed; the registers' rows; ₹10 lakh of cost,
  ₹10,000 cess due, ₹6,000 paid, ₹4,000 balance.
- A browser test: a contractor, a worker, a minimum wage, a day mustered, the sheet refused below the minimum.
