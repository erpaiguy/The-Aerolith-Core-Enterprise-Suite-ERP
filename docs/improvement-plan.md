# Improvement plan: Aerolith Core through each role's eyes

Written after replaying two and a half years of a ₹2.5 crore contractor's work through the app (docs/demo.md) and
reading it as each person who would use it daily. Proposals only; nothing here is built yet. Each item carries a
priority (P1 do next, P2 soon, P3 later) and a rough size (S: days, M: one to two weeks, L: three weeks or more).

## The finding that matters most

The app is not short of features; it is hard to *find* them and hard to *move through a day's work* in it.

- Of about 670 tenant API functions, the web app reaches almost all; a manual check found only three with no way to
  use them (posting a full-and-final settlement, leave opening balances, quality test criteria).
- But most daily work lives two or three clicks inside a project: daily reports, the measurement book, client bills,
  subcontract bills, stores, requisitions, drawings, WBS, programme, material budget. None of these has a company-wide
  list or a menu entry, so a site engineer or accountant must remember which project to open first.
- The menu is organised by module (what the software has), not by job (what a person does today). Each role sees
  forty entries and uses six.
- Forms are reached from buttons on list screens; there is no "New …" shortcut and no search that jumps to a record.

So the first wave below is navigation and workflow, before any new module. It costs little and every role feels it.

---

## 1. For everyone (cross-cutting)

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 1.1 | **Project workspace.** Opening a project switches the left menu to that project's own sections: Overview, BOQs, WBS, Programme, Measurement book, Daily reports, Requisitions, Orders, Stores, Client bills, Subcontract bills, Variations, Contracts and claims, Risks, Quality, Safety, Documents and drawings, Cost control, Cash flow. A project picker at the top keeps the choice. | Today these are tabs or links scattered over the project page. | P1 | M |
| 1.2 | **Company-wide registers** for what is now project-only: daily reports, measurement books, client bills, subcontract bills, drawings, RFIs, inspections, NCRs, material approvals, stock issues and transfers, RFQs (enquiries). Each with project, date and status filters. | Managers and accounts look across projects, not into one. | P1 | M |
| 1.3 | **"New" button in the header**: voucher, supplier bill, client receipt, payment run, requisition, purchase order, goods receipt, store issue, daily report, leave, RFI, variation. Remembers the last project. | The create forms exist (`/accounts/vouchers/new` and the like) but no menu leads there. | P1 | S |
| 1.4 | **Search everything (Ctrl+K)**: type a PO, bill, tender or employee number, a party or a screen name, and jump to it. | Numbers are how people talk ("PO 278 is short"). | P1 | M |
| 1.5 | **"My work" home per role**: what waits on me (approvals, reviews, RFIs assigned, bills to certify, POs to receive, NCRs to close, leave to approve), with counts; replaces today's generic inbox for daily use. | The inbox lists notifications; it does not list work. | P1 | M |
| 1.6 | **Menu by role.** Show each role the groups it uses first, hide what it cannot open (already partly done), let each person pin favourites and see recently opened records. | Forty entries for six used. | P2 | S |
| 1.7 | **Consistent lists**: column chooser, saved filters ("my projects, this month"), totals row, export to Excel on every list, bulk actions (approve, print, close), paging beyond 500 rows. | Some lists stop at 500 rows silently (vendor bills, vouchers). | P2 | M |
| 1.8 | **Printable documents with the company's letterhead and logo**: purchase order, work order, GRN, issue slip, RA bill and abstract, payment advice, receipt, payslip, transmittal, appointment and relieving letters. One template setting per company. | Most documents export to Excel today; suppliers and clients expect a signed PDF. | P1 | M |
| 1.9 | **Attachments on every record** (photo, PDF) with a count badge; today only some records take files. | Challans, invoices and test certificates live on paper. | P2 | M |
| 1.10 | **Email digests** (free SMTP, no paid service): a morning summary per person of what is due today and overdue. | Reminders exist but only in the app. | P2 | S |
| 1.11 | **Rename "Clients" to "Parties"** (clients, suppliers, subcontractors, competitors) and give suppliers their own filtered entry under Procurement. | Vendors are kept under "Clients" today. | P1 | S |
| 1.12 | **Audit trail screen**: who changed what and when, per record and company-wide; the database already records it. | Accountants and auditors ask for it first. | P2 | S |
| 1.13 | **Bulk import of masters** from Excel: parties, employees, contract workers, resources and opening stock (only BOQs and price books import today). | Starting a company means typing hundreds of records. | P1 | M |

---

## 2. Estimator

Has today: rate library with history, rate analyses with overheads and profit, BOQs (import, templates, provisional
sums, alternates), pricing scenarios, revisions and comparison, tender RFQs, bid dashboards, win/loss, pipeline.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 2.1 | **Schedule of rates (SOR/DSR) library**: import the PWD or CPWD schedule as a read-only reference, with item codes, so BOQ items can cite and price against it, with a premium or discount percentage per tender. | Government tenders are priced as a percentage above or below the SOR. | P1 | M |
| 2.2 | **Estimate versus actual feedback**: for completed projects, compare each analysis' material and labour per unit with what was actually issued from stores and paid to labour, and propose rate-analysis corrections. | The data exists (measurement book, issues, subcontract bills); nobody closes the loop. | P1 | M |
| 2.3 | **Quick budget estimate**: cost per square metre by building type from past projects, before a BOQ exists, to decide bid or no-bid. | Bid decisions are made in a day. | P2 | S |
| 2.4 | **Rate escalation indices** (cement, steel, labour, fuel) with monthly values, used both in pricing long jobs and in price-variation claims. | Escalation clauses are common in government contracts. | P2 | M |
| 2.5 | **Lead time and labour productivity from site**: crews and output per day from daily reports, offered as constants in analyses. | Today's constants are typed in once and never checked. | P3 | M |
| 2.6 | **Tender comparison**: our rate against L1 per item when the client publishes the comparative, kept for future bids. | We record competitors' totals only. | P3 | S |

---

## 3. Project manager and planner

Has today: projects, WBS, programme with baseline and look-ahead, macro plan, progress, dashboard, cost control,
earned value, cash flow, monthly review, variations, contracts and claims, risks, portfolio.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 3.1 | **Project workspace** (1.1) with a one-page overview: progress against plan, billed against done, cost against budget, cash in against out, open RFIs, NCRs, overdue items. | The numbers exist across five screens. | P1 | M |
| 3.2 | **Meetings and action items**: progress meetings with the client and subcontractors, attendees, decisions, actions with owners and due dates that follow into "My work". | Minutes are the most-used site document and the app has none. | P1 | M |
| 3.3 | **Weekly and monthly progress report to the client** as a PDF: progress S-curve, photos, work done, next period's plan, hindrances, manpower. | Built today by hand from daily reports. | P1 | M |
| 3.4 | **Daily-report quantities proposed into the measurement book** at month end, for the engineer to check and accept, instead of retyping. | Daily report work quantities do not reach the measurement book. | P1 | M |
| 3.5 | **Hindrance and delay register** across reports, with responsibility and days, feeding the extension-of-time basis (already computed) and the claims. | The data is inside daily reports; there is no register view. | P2 | S |
| 3.6 | **Forecast at completion review**: a monthly sign-off of cost to complete by cost head, with history, before the month is closed. | Cost to complete can be entered but is not reviewed or kept month by month. | P2 | M |
| 3.7 | **Programme progress from site**: activities' percent complete suggested from measured quantities linked to them. | Programme updates are typed by hand. | P2 | M |
| 3.8 | **Photo timeline** per site and area, from daily reports, filterable by date. | Photos exist but only inside each day's report. | P3 | S |

---

## 4. Site engineer and supervisor (on a phone)

Has today: daily report with manpower, machines, work, weather, hindrances and photos; site attendance; labour
muster; goods receipt; store issue; offline outbox.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 4.1 | **A site home on the phone**: today's report, muster, deliveries expected, issues to make, inspections due, permits, with large buttons. | The desktop menu on a phone is unusable. | P1 | M |
| 4.2 | **Muster by gang with one tap for "all present"**, and photo attendance for gangs. | 60 to 120 workers a day are marked one by one. | P1 | S |
| 4.3 | **Copy yesterday's daily report** (manpower, machines, work in progress) and change what differs. | Most of a day's report repeats yesterday. | P1 | S |
| 4.4 | **Material request from site** in two taps from a stock item, becoming a requisition. | Requisitions are a desktop form. | P2 | S |
| 4.5 | **Joint measurement sheets** signed on the phone by the client's engineer. | Measurements are recorded after the fact. | P3 | M |

---

## 5. Document controller

Has today: project documents and folders, drawing register with revisions, distribution matrix, drawing receipts,
transmittals, RFIs, submittals, review workflows, mark-up, sign-offs, controlled revisions, share links.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 5.1 | **Company-wide drawing register and document register** in the menu, with "latest revision only" and "superseded" views. | Drawings are reachable only inside a project. | P1 | S |
| 5.2 | **Master document list** per project: every expected drawing and submittal with planned and actual dates, and what is late. | Late drawings are the commonest delay claim; the evidence should be one report. | P1 | M |
| 5.3 | **Correspondence register**: incoming and outgoing letters and emails with reference numbers, linked to projects, notices and claims. | Contract notices exist; ordinary letters have nowhere to go. | P1 | M |
| 5.4 | **Document numbering rules** per project (discipline, type, sequence) checked on upload, and bulk upload reading the number and revision from file names. | Uploading 200 drawings one by one is the first day's work on every project. | P2 | M |
| 5.5 | **"Superseded" stamp** on downloads of old revisions, and a QR code on issued prints that opens the current revision. | Old prints on site cause rework. | P2 | M |
| 5.6 | **Review overdue dashboard**: reviews and transmittals waiting on whom, for how long. | Deadlines exist; the overview does not. | P2 | S |

---

## 6. Procurement executive

Has today: requisitions with approval, material budget, project enquiries (RFQs) with comparative statements and
negotiation, purchase and work orders with amendments, receipts, procurement reports, open orders, suppliers report.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 6.1 | **Order from a requisition directly** (select lines, choose a supplier), keeping the link; today a requisition reaches an order only through an RFQ. | Most site purchases are repeat buys with no enquiry. | P1 | S |
| 6.2 | **Enquiries (RFQs) list** in the menu across projects and tenders. | RFQs open only from their tender or project. | P1 | S |
| 6.3 | **Rate contracts**: agreed rates with a supplier for a period and items, used automatically on orders, with consumption against the agreed quantity. | Cement and steel are bought on annual rates. | P1 | M |
| 6.4 | **Supplier evaluation**: on-time delivery, rejection rate and price trend from receipts, and an approved-supplier list per material. | The data is in receipts and orders. | P2 | M |
| 6.5 | **Expediting view**: orders past their delivery date, partly received, or awaiting acknowledgement, with one-click reminder emails. | Delivery dates are stored and never watched. | P2 | S |
| 6.6 | **Three-way match exceptions**: receipts not billed, bills held for quantity or rate, price differences, in one list. | Accounts and purchase chase each other over these. | P2 | S |

---

## 7. Storekeeper

Has today: stores per site, receipts, issues to WBS, issue returns, transfers, stock counts with approval, reorder
levels, weighted average or FIFO valuation, consumption report.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 7.1 | **Material reconciliation per project**: theoretical consumption (measured work × rate-analysis quantities) against issues, with wastage percentage by material. | The most important store report on a construction site, and every input already exists. | P1 | M |
| 7.2 | **Stores menu entries** for issues, transfers and counts across stores, and a stock-on-hand view across sites. | Each lives inside one store today. | P1 | S |
| 7.3 | **Tools and returnables register**: drills, vibrators, shuttering issued to gangs and due back. | Small tools vanish; they are not consumables. | P2 | M |
| 7.4 | **Reorder alerts** on the home screen and a requisition made from them in one click (the action exists on the store screen). | Reorder levels are set and then forgotten. | P2 | S |
| 7.5 | **Scrap and wastage register**, and sale of scrap to the ledger. | Steel scrap is real money. | P3 | S |
| 7.6 | **Bin cards and labels with QR codes** for items, and stock movement by scanning. | Speeds counts and issues. | P3 | M |

---

## 8. Accountant

Has today: vouchers, receivables, payables, payment runs, GST registers and returns, TDS challans and 26Q, bank
statement import and reconciliation, fixed assets and depreciation, equipment costing, statements, trial balance, day
book, chart, periods, year-end close, Tally export.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 8.1 | **Month-end close checklist**: GST set-off and payment, TDS deposit, payroll posted, depreciation, machine costing, bank reconciled, cost months closed; each ticks itself when done; then lock the month. | All the steps exist in separate screens; nothing says what is left. | P1 | M |
| 8.2 | **Recurring vouchers and bills**: rent, interest, subscriptions, posted on schedule as drafts. | The same entries every month. | P1 | S |
| 8.3 | **Site imprest (petty cash) per site**: advances to site, expense entries with bills from the phone, settlement. | Today this needs a contra and hand-entered payments. | P1 | M |
| 8.4 | **Cheques**: issued and post-dated cheque registers, printing on bank stationery, bounce handling. | Many suppliers and clients still pay by cheque. | P2 | M |
| 8.5 | **Ageing with follow-up** for receivables (by client and bill) and supplier advances, with reminder letters. | Ageing exists as a total; the follow-up does not. | P2 | S |
| 8.6 | **Overhead budgets** for the head office by ledger and month, against actuals. | Projects have budgets; the office does not. | P2 | S |
| 8.7 | **E-way bills** for site-to-site transfers and supplies over the threshold (JSON for the free government portal). | Transfers between sites need them. | P3 | S |
| 8.8 | **MIS pack PDF**: P&L, balance sheet, cash flow, receivables, project margins, for the directors each month. | Each piece exists; the monthly pack is built by hand. | P2 | S |

---

## 9. HR and payroll

Has today: employees, designations with permissions, calendars and holidays, deployments, attendance (register,
phone, punch import), leave, payroll with PF, ESI, PT, LWF and TDS, payslips, ECR and ESI files, settlements.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 9.1 | **Missing screens**: post a full-and-final settlement (it can be worked out and viewed, not posted), and leave opening balances. | Both exist in the API with no way to use them. | P1 | S |
| 9.2 | **Salary revision in bulk**: an April increment sheet for everyone, reviewed and applied together. | Each raise is entered person by person. | P1 | S |
| 9.3 | **Joining and exit checklists**: documents collected, assets issued and returned, sign-in created or turned off, settlement done. | Exits are three separate actions in three screens. | P1 | M |
| 9.4 | **Loans and salary advances** with an EMI recovered through payroll. | Common for site staff. | P2 | S |
| 9.5 | **Letters**: offer, appointment, increment, relieving and experience letters from templates. | Typed in Word today. | P2 | S |
| 9.6 | **Self-service**: leave balance, payslips, attendance and tax declarations for each employee. | Payslips exist; the rest is asked of HR. | P2 | M |
| 9.7 | **Gratuity rules before November 2025** can be entered, so older exits are settled correctly. | The rule cannot be added through the app. | P2 | S |

---

## 10. Labour compliance (contract labour)

Has today: contractors and licences, workers, minimum wages, daily muster, wage sheets (pass and verify), statutory
registers, BOCW cess.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 10.1 | **Bulk worker import** from the contractor's Excel, and worker ID cards with QR codes for the muster. | Workers are added one at a time. | P1 | S |
| 10.2 | **Compliance calendar**: licence renewals, PF and ESI payment proofs from contractors each month, BOCW returns; a contractor is blocked from billing when proof is missing. | Principal employer liability. | P1 | M |
| 10.3 | **Safety induction before first muster**: a worker cannot be marked present until inducted (toolbox records already exist). | Safety and insurance claims. | P2 | S |
| 10.4 | **Labour cost per unit of work**: wage sheets against measured quantities, by trade and gang. | Feeds the estimator (2.2, 2.5). | P2 | M |

---

## 11. Quality and safety

Has today: inspection requests and decisions, checklists from templates, material tests with criteria, NCRs,
snags, approved makes; incidents with investigation, permits to work, toolbox talks, safety statistics.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 11.1 | **Missing screen**: test criteria (acceptance values for cube, slump, steel, soil, brick tests). | Exists in the API only. | P1 | S |
| 11.2 | **Inspection and test plan (ITP)** per project: which checklists and tests each activity needs, and what is due from the programme. | Today inspections are raised ad hoc. | P1 | M |
| 11.3 | **Safety inspections and audits**: weekly site walks with a checklist, findings, actions and closure. | Safety has no inspection module at all. | P1 | M |
| 11.4 | **Quality and safety dashboards**: NCRs by age and cause, test pass rate, man-hours without lost time, LTIFR. | Statistics exist per project only. | P2 | S |
| 11.5 | **PPE issue register** per worker and site. | Required by most clients. | P3 | S |

---

## 12. Directors and management

Has today: portfolio, monthly review, tender and estimation dashboards, report builder, statements.

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 12.1 | **Company dashboard**: order book in hand, revenue this year against plan, gross margin by project, cash and cash-credit position, receivables over 90 days, tenders due this month, safety incidents. | The question every Monday, answered in five screens today. | P1 | M |
| 12.2 | **Alerts by exception**: a project's cost to complete exceeds its budget, a bill uncertified for 30 days, a performance guarantee expiring in 30 days, the cash-credit limit 80% used. | Directors should not have to look for trouble. | P2 | M |
| 12.3 | **Annual business plan** (revenue, margin, overheads by month) and progress against it. | Gives the dashboards a target. | P3 | M |

---

## 13. Sales (own developments, RERA)

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 13.1 | **Buyer CRM**: enquiries and site visits through to booking, with source and follow-ups (the contracting CRM does not fit buyers). | Bookings start as walk-ins and calls. | P2 | M |
| 13.2 | **Cost sheet, demand letter and receipt PDFs**, and demand reminders by email. | Buyers expect paper. | P1 | S |
| 13.3 | **Unit holds with expiry** and a price list per floor with approval for discounts. | Sales teams hold flats informally. | P2 | S |

---

## 14. Administrator

| # | Improvement | Why | P | Size |
|---|---|---|---|---|
| 14.1 | **Document number series** per company and type (prefix, padding, reset each year), editable. | Fixed today. | P2 | S |
| 14.2 | **Backup and restore** from the admin screen, with a scheduled backup to a folder. | Done with Docker commands today. | P1 | M |
| 14.3 | **Settings in one place**: company, numbering, letterhead, approval rules, permissions, tender settings, accounts mode, payables tolerance (the last has no screen today). | Settings are spread across six screens. | P2 | S |

---

## Proposed order of work

**Wave 7a: find and move (about three weeks).** 1.1 project workspace, 1.2 company-wide registers, 1.3 "New"
button, 1.4 search, 1.5 "My work", 1.11 parties, and the missing screens (9.1, 11.1, 14.3's payables tolerance).
Little new logic; most screens already exist and are only re-homed.

**Wave 7b: paper the business needs (about three weeks).** 1.8 printable documents with letterhead (PO, WO, GRN,
issue slip, RA bill, payment advice, payslip, transmittal, letters), 13.2, 8.8 MIS pack, 3.3 client progress report.

**Wave 7c: close the loops (about four weeks).** 3.4 daily reports into the measurement book, 7.1 material
reconciliation, 2.2 estimate against actual, 6.1 order from requisition, 6.3 rate contracts, 8.1 month-end checklist,
9.2 bulk revisions, 10.1 and 1.13 bulk imports.

**Wave 7d: new registers (about four weeks).** 3.2 meetings and actions, 5.3 correspondence, 5.2 master document
list, 11.2 ITP, 11.3 safety inspections, 8.3 site imprest, 8.2 recurring entries, 9.3 joining and exit checklists,
12.1 company dashboard.

**Later.** The P2 and P3 items above, chosen by what users ask for after 7a to 7c are in their hands.

## What not to do yet

- **No paid services**, as agreed: digests by plain email; no WhatsApp or SMS gateways, no paid maps, no paid OCR.
- **No AI features** until the workflows above are smooth; they would sit on top of the same navigation problems.
- **No more modules before Wave 7a.** Each new module makes the menu problem worse until navigation is fixed.
