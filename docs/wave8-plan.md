# Wave 8: close the real gaps

An audit of every department in October 2026 checked what a mid-size Indian contractor needs against what the code
holds (migrations, services and routes, not menus). This plan keeps only gaps confirmed missing or half-built, ranked
by what they cost the business when absent. Things the audit found solid are listed at the end so they are not redone.

**Status: agreed 16 Oct 2026; build all of 8a to 8g in order without stopping.** Decisions taken where the owner did
not choose: revenue on work done uses cost to date over estimated total cost (falling back to measured value where a
project has no cost estimate), with the method shown on every figure so accounts can change it later; all sub-waves
run back to back. After Wave 8: a full debug pass (the debug log, below), then Wave 9 ([wave9-plan.md](wave9-plan.md)).

## Rules for every step

As in [wave7-plan.md](wave7-plan.md): plan here first, build, test (integration tests for routes, a browser test for
screens), format, lint and typecheck before each push, the full check and browser suite at each sub-wave's end. Never
edit a committed migration. No paid services, and no library without a permissive licence. The demo history gains
each feature, so the demo shows it.

## Why this order

Money that leaks or is misstated comes first: it is invisible until year end, then expensive. Statutory compliance
next: penalties and lost input credit are certain, not possible. Then the people and site work that feed both. Sales,
estimation and the platform last, as nothing there is losing money today.

## Wave 8a: money that leaks or is misstated

1. **Revenue on work done (Ind AS 115).** Each month, per project: revenue by percentage of completion (cost to date
   over estimated total cost, from cost control's cost to complete), the unbilled-revenue contract asset or the
   billed-in-excess contract liability, posted as an auto-reversing journal; a provision when a contract is expected
   to lose money. Project P&L and the company dashboard show recognised revenue and margin. *This is why the
   dashboard shows −157% margins today.* Large.
2. **Material at site and accruals.** Month-end valuation of site stock (from the stock ledger) moved out of expense
   into inventory; goods received not yet invoiced, and subcontract work measured not yet billed, accrued and
   reversed. A month-end close step for each. Medium-large.
3. **Free-issue material to subcontractors.** A stock issue can name the subcontractor's work order; per work order,
   material issued against what their certified quantities should have used (quantity × norm + allowed wastage);
   the excess becomes a back-charge on their next bill at the agreed penal rate, proposed for a person to accept.
   Medium.
4. **Budget check on purchase orders.** An order line over the material or cost budget is held: allowed to the
   project lead with a reason, or sent to the next approver; shown on the order. Medium.
5. **Debit notes from the stores.** A return to vendor, a short receipt or a rate above the order proposes a debit
   note against the bill; nothing typed twice. Small-medium.

## Wave 8b: tax compliance

1. **GST reverse charge.** Liability and matching input credit for supplies from unregistered persons where notified
   and for notified services (transport, legal, security, renting); GSTR-3B table 3.1(d); Rule 37 reversal of input
   credit for suppliers unpaid after 180 days, and re-claim on payment. Medium.
2. **GST TDS by government clients (section 51).** The 2% deducted on a client receipt recorded apart from income-tax
   TDS, matched to GSTR-7A, and taken into the GST cash ledger. Small-medium.
3. **TDS returns and certificates.** Lower-deduction certificates (section 197) per supplier with limit and validity;
   Form 16A from 26Q data; salary TDS (section 192) on challans and a 24Q; 26Q and 24Q written in the NSDL text
   format that the free government validation utility (FVU) accepts. Medium.
4. **MSME suppliers.** Udyam number and type on the party; a 45-day payment alert in payables; the section 43B(h)
   year-end disallowance report and the half-yearly MSME-1 data. Small.
5. **TDS on flat buyers' payments (194-IA).** Receipts net of the buyer's 1% TDS, the TDS allocated and matched to
   26AS. Small.

## Wave 8c: labour and payroll compliance

1. **Contract labour compliance.** PF and ESI on contract workers' wage sheets; each contractor's monthly challan or
   ECR checked by us as principal employer; their labour licence (CLRA) and validity; a subcontract bill held while
   these are missing or the wage-sheet shortfall is unpaid. Medium.
2. **Worker muster you can trust.** Muster entry from a phone with location inside the site's geofence and a photo,
   working offline through the outbox, as staff attendance already does. Medium.
3. **Statutory payments and returns.** PF, ESI, PT and LWF challans recorded against each run (with TRRN); the
   Maharashtra PT return; Form 16 Part B and 12BA as print pages. Medium.
4. **Payroll gaps.** Overtime for staff; Payment of Bonus Act calculation; loans and salary advances with an EMI
   schedule deducted in runs; employees' tax declarations and proofs for the old regime. Medium.
5. **Leave to the reporting manager.** Approval rules can route to the employee's manager; automatic delegation while
   an approver is on approved leave. Small.

## Wave 8d: site and projects

1. **Price escalation done properly (CPWD 10CC).** A master of index series (WPI and CPI series, steel, cement) with
   monthly values; indices averaged over the bill's period; items escalated separately or extra left out; the same
   on subcontract bills. Medium.
2. **Look-ahead with constraints.** A make-ready log per activity (drawings, material, front, approvals, labour) with
   owner and date; the weekly work plan; percent plan complete and reasons for misses. Medium.
3. **Snags, handover and defect liability.** Snags with responsible party, due date and back-charge; unit or area
   handover checklists and certificate; defects reported in the liability period; reminders when it ends, tied to
   releasing retention and the performance guarantee. Medium.
4. **Geotagged photos and offline site entry.** Photos keep location and time taken and queue offline; the
   measurement book and daily photos work without signal. Small-medium.
5. **Deviation statement.** Item-wise excess and saving against tendered quantities with the percentage against the
   deviation limit and extra items, as a print page in the PWD form. Small.

## Wave 8e: purchase and stores

1. **Vendor master.** Udyam/MSME, trade categories, approved or blacklisted status with reason, KYC documents with
   expiry; enquiries offered only to approved vendors in the category. Medium.
2. **Delivery follow-up.** Delivery schedule per order line (staggered steel and ready-mix deliveries); expediting
   notes; lead-time report from requisition to order to receipt. Medium.
3. **Receipts and transfers as they really happen.** An over-receipt tolerance (weighbridge, sand, aggregate); vehicle,
   transporter and e-way bill number on receipts and transfers; short receipt and transit loss on transfers; a
   central store not tied to a project. Medium.
4. **Buying with history.** Last purchase rate and price trend shown on requisitions, comparatives and orders; stock
   ageing and slow-moving report; minimum and maximum levels. Small.
5. **Scrap and tools.** Scrap store and scrap sale; returnable tools issued to a person or gang, with overdue returns.
   Small-medium.

## Wave 8f: sales and estimation

1. **Booking life after sale.** Cancellation with forfeiture, refund voucher and GST credit notes for open demands;
   transfer or nomination to a new buyer; stamp duty and registration details; possession demand, handover checklist
   and the defect period. Medium-large.
2. **Schedule-of-rates tendering.** A library of CPWD and state PWD schedule of rates (DSR/SOR) items; BOQ items citing
   them; percentage-rate tenders (quoted % above or below the estimate); item-wise competitor comparative and win
   rates. Large.

## Wave 8g: platform

1. **Two-factor sign-in for staff.** Authenticator codes for any user; required for admins and those who post to the
   books. Small.
2. **Backup, restore and audit export.** Scheduled backups of each tenant from the admin screens, a tested restore, and
   a full export of a company's records for auditors. Medium.
3. **Reminders that go out.** A daily email digest per person: what is overdue or expiring (guarantees, insurance,
   licences, KYC, permits, actions, demands). Email only. Small-medium.
4. **Finer permissions.** Custom roles; salary and bank details masked unless permitted; view apart from edit where it
   matters. Medium.
5. **Marathi and Hindi for site screens.** Translations for the screens site staff and supervisors use (daily report,
   muster, stores, quality, safety). Medium.

## Not in this wave, and why

- **E-invoice and e-way bill sent straight to the government portals:** needs a GST suvidha provider (paid) or
  direct API registration; the JSON for upload and the numbers typed back stay as they are.
- **SMS and WhatsApp:** paid gateways. The email digest (8g.3) covers reminders.
- **GeM and CPPP feeds:** no public API to read tenders from.
- **Resource levelling, group consolidation, importing from Tally, a buyer portal, appraisals:** real but lower value
  than everything above; next wave.

## Already solid (do not redo)

Client RA bills from the measurement book with retention, advance recovery and escalation arithmetic; subcontract
bills with retention, advances, back-charges, cess and 194C; payables with three-way match, holds, TDS thresholds,
advances and payment runs; GSTR-1, 3B and 2B matching; Schedule III statements and year-end close; bank
reconciliation; fixed assets; cost control with cost to complete and earned value; CPM scheduling with baselines and
P6/MSP exchange; daily reports with hindrances feeding extensions of time; equipment logs and costing; drawing
revision control; the requisition-RFQ-order chain with revisions and rate contracts; GRN with quality hold and
returns; FIFO or average stock with counts and transfers; material reconciliation against norms; the payroll engine
with PF, ESI, PT, LWF, IT and full and final; geofenced staff attendance; MahaRERA designated account and quarterly
figures; the approvals engine with delegation; audit log; API keys and webhooks; scheduled BI reports.

## Progress

The source of truth for where the work stands. A scheduled check-in resumes from the first unticked line.

- [x] 8a.1 Revenue on work done (Ind AS 115)
- [x] 8a.2 Material at site and accruals
- [x] 8a.3 Free-issue material to subcontractors
- [x] 8a.4 Budget check on purchase orders
- [x] 8a.5 Debit notes from the stores
- [x] 8a exit: full check and browser suite
- [x] 8b.1 GST reverse charge
- [x] 8b.2 GST TDS by government clients
- [x] 8b.3 TDS returns and certificates
- [x] 8b.4 MSME suppliers
- [x] 8b.5 TDS on flat buyers' payments
- [x] 8b exit: full check and browser suite
- [x] 8c.1 Contract labour compliance
- [x] 8c.2 Worker muster you can trust
- [x] 8c.3 Statutory payments and returns
- [x] 8c.4 Payroll gaps
- [x] 8c.5 Leave to the reporting manager
- [x] 8c exit: full check and browser suite
- [x] 8d.1 Price escalation (CPWD 10CC)
- [x] 8d.2 Look-ahead with constraints
- [x] 8d.3 Snags, handover and defect liability
- [x] 8d.4 Geotagged photos and offline site entry
- [x] 8d.5 Deviation statement
- [x] 8d exit: full check and browser suite
- [x] 8e.1 Vendor master
- [x] 8e.2 Delivery follow-up
- [x] 8e.3 Receipts and transfers as they really happen
- [x] 8e.4 Buying with history
- [x] 8e.5 Scrap and tools
- [ ] 8e exit: full check and browser suite
- [ ] 8f.1 Booking life after sale
- [ ] 8f.2 Schedule-of-rates tendering
- [ ] 8f exit: full check and browser suite
- [ ] 8g.1 Two-factor sign-in for staff
- [ ] 8g.2 Backup, restore and audit export
- [ ] 8g.3 Reminders that go out
- [ ] 8g.4 Finer permissions
- [ ] 8g.5 Marathi and Hindi for site screens
- [ ] 8 exit: full check, browser suite, demo reseed and crawl; notify the owner
- [ ] Debug pass: run everything, log every failure, error and fault in docs/debug-log.md; show the owner
- [ ] Debug fixes: clear each logged item (fix or recommendation), log the action taken against it
- [ ] Wave 9: build as its own Progress list in docs/wave9-plan.md, then notify the owner and delete the routine
