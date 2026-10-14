# Wave 7: build plan (from docs/improvement-plan.md)

Waves 7a to 7d of the improvement plan, as steps small enough to build, test and push one at a time. The Progress
list at the end is the source of truth for where the work stands: a scheduled check-in resumes from the first
unticked step.

## Rules for every step

- Plan here first; build; then tick the step with its commit.
- New API routes get integration tests (`apps/api/test/*.int.spec.ts`); new screens get a browser test or extend one.
- Before each push: format, lint, typecheck, the changed package's tests. At the end of each wave: the full check
  (`pnpm check` with the test databases) and the full browser suite.
- Never edit a committed migration; add new ones. No paid services or libraries without a permissive licence.
- Printed documents are HTML pages styled for print (the browser's "Save as PDF"), as the programme print already is:
  no PDF library, nothing paid.

## Wave 7a: find and move

1. **Missing screens.** Post a full-and-final settlement (Payroll › employee); leave opening balances (HR › employee);
   quality test criteria (Quality › settings); payables rate tolerance (Accounts › Payables).
2. **Parties and enquiries.** Menu "Clients" becomes "Parties" with kind filters; "Suppliers" and "Subcontractors"
   entries under Procurement open it filtered. A company-wide RFQ list (`GET /tenant/rfqs`) under Estimation and
   Procurement.
3. **Company-wide registers.** List routes and screens across projects, with project, status and date filters:
   daily reports, client bills, subcontract bills, drawings, RFIs, inspections and NCRs, stock issues and transfers.
4. **Project workspace.** On any project page the menu shows that project's sections (overview, BOQs, WBS,
   programme, measurement, daily reports, requisitions, orders, stores, client bills, subcontract, variations,
   contracts, risks, quality, safety, documents, cost, cash flow); a project picker switches between projects.
5. **"New" menu.** One header button for the common create forms, opening them with the current project chosen.
6. **Search everything.** `GET /tenant/search?q=` over document numbers, parties, projects, tenders, employees and
   screens; Ctrl+K opens it anywhere.
7. **My work.** Home page sections per person: approvals, reviews, RFIs, bills to certify, orders to receive, NCRs,
   leave to approve, follow-ups, with counts in the menu.
8. **Audit trail.** `GET /tenant/audit` (admin) and a screen with filters by person, record and date.

## Wave 7b: paper the business needs

1. **Letterhead.** Company logo, address block, footer and signatory per company (Settings › Companies), and a
   shared printable layout.
2. **Purchase documents.** Printable purchase order, work order, goods receipt, store issue slip.
3. **Money documents.** Printable RA bill with abstract, client receipt, payment advice, payslip.
4. **Document control.** Printable transmittal and HR letters (appointment, increment, relieving, experience).
5. **Reports to people outside.** Monthly MIS pack for directors; monthly progress report to the client; RERA cost
   sheet and demand letter.

## Wave 7c: close the loops

1. **Daily reports into the measurement book.** Month-end proposal of quantities from daily reports per BOQ item,
   reviewed and accepted into the book.
2. **Material reconciliation.** Theoretical consumption (measured work × rate-analysis quantities) against store
   issues, by project and material, with wastage percentages.
3. **Estimate against actual.** For a project, each analysed item's estimated material and labour per unit against
   actual issues and labour bills.
4. **Order from a requisition.** Select approved requisition lines and a supplier; the order keeps the link.
5. **Rate contracts.** Agreed rates per supplier, item and period; orders pick them up; consumption against them.
6. **Month-end close checklist.** Per company and month, each close step's state worked out from the books, and a
   lock when all are done.
7. **Salary revisions in bulk.** An increment sheet for everyone in service, reviewed and applied together.
8. **Bulk imports.** Excel import for parties, employees, contract workers and resources.

## Wave 7d: new registers

1. **Meetings and actions.** Minutes per project, attendees, decisions, actions with owners and due dates in My work.
2. **Correspondence register.** Incoming and outgoing letters per project, with references and attachments.
3. **Master document list.** Expected documents per project with planned and actual dates, late ones flagged.
4. **Inspection and test plans.** Per project: which checklists and tests each activity needs.
5. **Safety inspections.** Site walks with a checklist, findings, actions and closure.
6. **Site imprest.** Petty-cash advances to a site, expenses against them, settlement in the books.
7. **Recurring entries.** Vouchers and supplier bills drafted on a schedule.
8. **Joining and exit checklists.** Steps per employee, with sign-in and settlement links.
9. **Company dashboard.** Order book, revenue against plan, margin by project, cash and credit, receivables over
   90 days, tenders due, incidents.

## Progress

- [ ] 7a.1 Missing screens
- [ ] 7a.2 Parties and enquiries
- [ ] 7a.3 Company-wide registers
- [ ] 7a.4 Project workspace
- [ ] 7a.5 "New" menu
- [ ] 7a.6 Search everything
- [ ] 7a.7 My work
- [ ] 7a.8 Audit trail
- [ ] 7a exit: full check and browser suite
- [ ] 7b.1 Letterhead
- [ ] 7b.2 Purchase documents
- [ ] 7b.3 Money documents
- [ ] 7b.4 Document control and HR letters
- [ ] 7b.5 MIS pack, client progress report, RERA documents
- [ ] 7b exit: full check and browser suite
- [ ] 7c.1 Daily reports into the measurement book
- [ ] 7c.2 Material reconciliation
- [ ] 7c.3 Estimate against actual
- [ ] 7c.4 Order from a requisition
- [ ] 7c.5 Rate contracts
- [ ] 7c.6 Month-end close checklist
- [ ] 7c.7 Salary revisions in bulk
- [ ] 7c.8 Bulk imports
- [ ] 7c exit: full check and browser suite
- [ ] 7d.1 Meetings and actions
- [ ] 7d.2 Correspondence register
- [ ] 7d.3 Master document list
- [ ] 7d.4 Inspection and test plans
- [ ] 7d.5 Safety inspections
- [ ] 7d.6 Site imprest
- [ ] 7d.7 Recurring entries
- [ ] 7d.8 Joining and exit checklists
- [ ] 7d.9 Company dashboard
- [ ] 7d exit: full check, browser suite, demo seed and crawl; report
