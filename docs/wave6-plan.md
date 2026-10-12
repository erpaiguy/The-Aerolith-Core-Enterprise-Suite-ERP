# Wave 6 Build Plan: Growth

Scope: docs/04-features.md W6 (G1-G6). docs/01-mvp.md exit criterion: **self-serve analytics**. Wave 6 completes
**v1**; public launch follows only after all planning phases are complete and v1 is built (docs/01-mvp.md).

**Planned before Waves 2b-5 are built**, so it is the least certain of the v1 plans. Each step is re-read with you
before it starts.

Tags: [Certain] fact or decided; [Likely] strong inference; [Guessing] to be checked.

## Read this first

- **[Certain] The documents place Tally and e-invoice integration in both Wave 3 and Wave 6.** Resolved as: Wave 3
  produces the **files** (Tally XML, e-invoice and e-way bill JSON); Wave 6 adds the **live links** (the Tally
  connector agent, and GSP/API adapters for tenants who pay a provider).
- **[Certain] Portals need a new kind of user.** Staff accounts are the tenant's employees, counted against seats
  (docs/03-architecture.md §6, §16). Vendors, subcontractors and clients logging in are **external users**: their own
  identity, scoped to their party's documents only, not counted as seats. **Proposal:** a separate external identity
  in the tenant database, with email-verified login. Pricing of external users is a Phase 6 (pricing) decision.
- **[Likely] Real estate sales (G2) is a different customer** (a developer selling flats) from the contractor this
  product is built for. It is only worth building if developers who build their own projects are a target segment.
  **Decide before step 2.**
- **[Certain] Offline sync** was a v1 non-goal until this wave (docs/01-mvp.md). The mobile app (G4) is where it is
  reconsidered, for a small set of site forms only.

## Steps

| # | Step | Features | Depends on |
|---|------|----------|------------|
| 1 | **CRM** | Leads, opportunities, contacts, interactions, into tender intake | Wave 1 |
| 2 | **Real estate sales and RERA** (if decided) | Units, bookings, payment plans, demand letters, collections, RERA account | Wave 3a |
| 3 | **Report builder and BI** | Self-serve reports and charts on a reporting model, scheduled exports | all waves |
| 4 | **Mobile app** | Store-installable app with offline site forms and sync | Waves 2b, 3 |
| 5 | **Portals** | Vendor, subcontractor and client portals | Waves 2b, 3a |
| 6 | **Integrations** | Public REST API, webhooks, Tally link, e-invoice/e-way adapters | Wave 3a |

## Step 1: CRM (G1)

- Leads (source, value, segment, stage), opportunities, client organisations and contacts (Wave 1's party master),
  interactions (calls, meetings, site visits) and follow-up reminders.
- An opportunity becomes a tender (Wave 1) with its client and documents; win/loss feeds back (Wave 1 step 8's
  win/loss analysis).
- Pipeline value by stage and expected month.

## Step 2: Real estate sales and RERA (G2), only if decided

- Projects as saleable inventory: towers, floors, units with areas (carpet, as RERA requires), rates, parking,
  charges.
- Bookings and agreements, payment plans linked to construction milestones (from Wave 2a's schedule and measured
  progress), demand letters when a milestone is reached, collections and receipts (Wave 3a receivables), interest
  on delays.
- **RERA:** the designated project account (the share of collections that must be deposited and its withdrawals
  against cost incurred), quarterly progress data, project registration details. [Guessing] Rules differ by state
  and are checked when built.

## Step 3: Report builder and BI (G3)

- A **reporting model**: curated, documented views over each module (projects, BOQ, procurement, stores, billing,
  ledger, payroll), with the same access rules as the screens (a user sees only their projects' rows).
- Self-serve builder: choose a view, fields, filters, grouping, totals; table or chart (ECharts, already in use);
  saved, shared with roles, added to dashboards.
- Scheduled exports to Excel, delivered in the app's inbox (staff have no email, docs/03-architecture.md §6), or by
  email to the admin.
- [Certain] No paid BI tool is bundled. Tenants who want their own BI connect through the read-only reporting views
  (BYO-DB tenants) or the API (step 6).

## Step 4: Mobile app (G4)

- A store-installable app wrapping the same web app (with a permissively licensed wrapper, checked against
  docs/licensing-policy.md), adding camera, location and push notifications.
- **Offline for a few site forms only:** daily site report, attendance and muster, goods receipt, issue slips,
  quality checklists. Drafts are kept on the phone and synced with conflict rules per form (a receipt cannot be synced
  twice; a daily report merges by section). Everything else stays online.

## Step 5: Portals (G5)

- External users (see above) per party, invited by staff.
- **Vendor portal:** see enquiries sent to them and quote online (Wave 1's quote entry), see orders and acknowledge
  them (Wave 2b step 4), upload invoices against orders (Wave 3a step 4), see payment status.
- **Subcontractor portal:** work orders, measurement submissions for verification, bills and payment status.
- **Client portal:** progress (dashboards and photos), RA bills and their status, transmittals for review (Wave 5).
- Everything a portal user does is recorded against their party and checked by staff before it counts.

## Step 6: Integrations (G6)

- **Public REST API** with per-tenant API keys and scopes, rate limits, and documentation generated from the same
  validation schemas the app uses.
- **Webhooks** for events (order approved, bill certified, receipt posted), signed, with retries.
- **Tally link:** the open-source connector agent on the tenant's LAN relays vouchers to a running Tally Prime
  (docs/03-architecture.md §14).
- **e-invoice and e-way bill adapters** for tenants who contract a GSP or ASP (paid by them); the file workflow from
  Wave 3 remains the default.
- **Exit check for Wave 6 (and v1):** a manager builds a report they need without help; a vendor quotes and invoices
  through the portal; a site submits daily reports from the phone in a poor-signal area.

## Answers taken (2026-10-12: "wave 6 proceed. keep real estate sales and RERA in scope, only the app users are counted as paid seats")

1. **Developers are a target segment.** Real estate sales and RERA (step 2) are built. [Likely] RERA rules differ by
   state; **Maharashtra (MahaRERA) first**, since the projects so far are there. Other states are added as data
   (account share, report forms) when a tenant needs them.
2. **Only app users (staff) are paid seats.** Portal users (vendors, subcontractors, clients, buyers) are free.
   - [Likely] Free with no limit invites abuse and support cost, so each tenant has a **fair-use cap**: 50 external
     users per kind by default, raised from the owner console.
   - The cap is not a price.
3. **Offline forms** (not answered, so the plan's list is taken): daily site report, attendance and muster, goods
   receipt, issue slips, quality checklists.

## Step 1 in detail (planned before building)

**What is there.** [Certain] Parties (`platform.party`, with client, vendor and subcontractor flags and contact
fields) and tenders. A tender's own status starts at "lead", and win/loss analysis exists (Wave 1 step 8). Nothing
records the work before a tender: who we met, what they might build, and when.

**Schema `crm`:**
- **Contacts:** people at a party (name, role, phone, email), several per party. The party's single contact stays as
  it is.
- **Leads** (LD-001…):
  - The details: a title, a party (or a new organisation's name, made into a party on conversion), a contact, a
    source (referral, repeat client, website, cold call, event, portal, other), a segment (the tender verticals,
    plus real estate) and a location.
  - The money: an estimated value, an expected award month and a **probability**, set by stage and overridable.
  - The workflow: an owner and a **stage**: new, qualified, proposal (or tender expected), negotiation, won, lost or
    dropped. A lost or dropped lead has a reason.
- **Interactions:** a call, meeting, site visit, email or note on a lead, with when and who. Each may set a
  **follow-up** (a date and what to do). The owner gets a notice and a reminder at 09:00 that day, until it is done.
- **Conversion to a tender:**
  - A qualified lead becomes a tender (Wave 1) with its client (the party, created if new), title, value, location,
    vertical and owner.
  - The lead stays linked. Its stage follows the tender's outcome: won when the tender is won, lost (with the
    reason) when lost or no-bid.
  - A lead may also be marked **won directly**, for work awarded without a tender (repeat clients, negotiated work).

**Pipeline:**
- By stage: count, value and **weighted value** (value × probability).
- By expected month for the next 12 months.
- Leads with no interaction for 30 days ("going cold"), and overdue follow-ups.
- Conversion rate by source.

**Screens:** "CRM", with three tabs: the pipeline (a board by stage, with value and weighted totals), leads (a list
with filters; a lead's page with its interactions, follow-ups and conversion), and contacts.

**Rights:** a new permission, `crm.edit` (managers by default). Everyone reads; owners edit their own leads.

**Tests:**
- Unit: weighted value, default probabilities and the stage rules.
- An integration test:
  - A lead from a referral with a contact, two interactions and a follow-up (with its notice and reminder).
  - Qualified, then converted to a tender with a new party created.
  - The tender won, so the lead is won.
  - A second lead lost with a reason.
  - The pipeline numbers checked by hand; a lead going cold; rights.
- A browser test: a lead created, an interaction logged, converted, and the pipeline showing it.

## Step 1 delivered

[Certain] As planned (migration 0065, schema `crm`, permission `crm.edit`):
- **Contacts** per party. **Leads** LD-001… with source, segment, value, probability, expected month, owner and stage.
- **The stage in effect:** a converted lead follows its tender. It is computed when read, from the tender's status
  (won, then won; lost, no-bid, withdrawn or cancelled, then lost), not copied. Every way a tender's status changes is
  covered without hooks.
- **Probability:**
  - A lead's own, else its stage's default (new 10, qualified 25, proposal 40, negotiation 60, tender 30). Won is
    always 100 and lost 0.
  - Weighted value is kept in paise.
- **Moves by hand:** any way between new, qualified, proposal and negotiation, plus won, lost or dropped (lost and
  dropped need a reason). A dropped lead can be revived. Nothing moves in or out of "tender" by hand.
- **Interactions:**
  - Recorded only when they have happened, not in the future.
  - A follow-up gives the owner a notice and a reminder at 09:00 on the day. "Done" removes both.
- **Conversion:**
  - Allowed from qualified, proposal or negotiation, and needs `tender.edit` too.
  - A new organisation becomes a client party, or an existing party of that name is reused and marked a client.
  - The tender takes the title, value, location, vertical (real estate maps to buildings) and owner, with "From lead
    LD-…" in its description.
- **Pipeline:**
  - Open count, value and weighted value, by stage.
  - Weighted value by expected month, for 12 months.
  - Win rate of closed leads by source.
  - Leads untouched for 30 days, and follow-ups due within a week.
- **Screen:** CRM, with Pipeline, Leads (each lead's card with its moves, conversion and interactions) and Contacts
  tabs.
- **Tests:**
  - `crm-rules.spec.ts`.
  - `crm.int.spec.ts`: referral to won tender, a follow-up's notices, a lost lead, and the pipeline checked by hand.
  - The tender test's permission lists updated for `crm.edit`.
  - The browser test `crm.spec.ts`.

## Step 2 in detail (planned before building)

**What is there.** [Certain] Projects with schedules and measured progress (Wave 2a), the ledger with party ledgers,
roles and GST output accounts, bank and cash ledgers (Wave 3a). Nothing for selling units.

**[Certain] The rules this step relies on, Maharashtra first:**
- RERA §13: no more than **10% of the cost** is taken before a registered agreement for sale.
- RERA §4(2)(l)(D): **70% of amounts realised** from allottees go into a separate **designated account**. Withdrawals
  are allowed in proportion to completion, as certified by the engineer, the architect and a chartered accountant
  (MahaRERA Forms 1, 2 and 3).
- MahaRERA rules: interest on delayed payment at **SBI's highest MCLR + 2%**, kept as a rate per project.
- [Likely] GST on under-construction units:
  - 5% for residential, 1% for affordable, 12% for commercial.
  - These are effective rates, with the one-third land deduction already counted.
  - Charged on each demand, intra-state (CGST and SGST halves).

**[Guessing] Taken as defaults, each a project setting:**
- 70% share.
- 15 days to pay a demand.
- Interest at 10.75% a year (MCLR 8.75% + 2), simple, by day.
- GST is excluded from the 70% (it is the government's money, not the allottee's price).

**Schema `re`:**
- **Sales setup per project:** the RERA registration number and date, the declared completion date, the designated
  bank ledger and the collection bank ledger, the share, interest rate and days to pay.
- **Towers and units:**
  - A unit has a tower, a floor, a number, a kind (flat, shop or office) and a carpet area in m².
  - Its price: a rate per m² of carpet area, parking, other charges, and a GST rate.
  - Its status: available, held, booked, agreement, cancelled.
  - A unit's price is its own; a price list is a bulk update.
- **Buyers:** name, co-applicant, phone, email, PAN and address.
  - Each booking opens a party (flagged **buyer**, not client, so buyers stay out of client lists).
  - The party's ledger sits under debtors, named "<unit> <buyer> (<booking>)", so two buyers with one name never
    clash.
- **Bookings** (BK-001…): the unit, the buyer, the agreement value (carpet area × rate + parking + charges), the
  booked-on date, and the agreement date and registration number once registered. Cancelling frees the unit; the
  refund is outside this step.
- **Payment plans:**
  - A project's stages, each a percentage of the agreement value. The stages total 100%.
  - Each stage is due on booking, on agreement, or on a **construction milestone** (for example "plinth", "slab 3",
    "possession").
  - Site marks a milestone **reached on a date** (optionally with the schedule activity that shows it).
- **Demands** (DM-001…):
  - When a milestone is reached, a demand is raised for every live booking whose plan has that stage. The amount is
    that percentage of the value, plus GST, due in the project's days.
  - Before the agreement is registered, a demand that would take collections past 10% is held back until the
    agreement is registered.
  - Each demand **posts**: buyer Dr; advances from flat buyers Cr (a new ledger and role); output CGST and SGST Cr.
- **Receipts:**
  - Posted Dr the collection bank, Cr the buyer, then allocated to that buyer's demands oldest first.
  - Each receipt's **RERA share** (70% of the part that is not GST) is added to what must be deposited.
- **Delay interest:** worked out by day on each overdue demand until paid. "Raise interest" posts it as a demand of
  its own (buyer Dr, interest income Cr).
- **The designated account:**
  - Deposits are contra entries from the collection bank to the designated bank. The screen shows what is required
    against what has been deposited.
  - Withdrawals are contra entries from the designated bank to another bank, each with the three certificates'
    references and the completion % they certify.
  - **Refused:** withdrawing past (deposited × certified completion %) less what has already been withdrawn.

**Reports:**
- Inventory by tower and status.
- Sales (booked, agreement value, demanded, collected, outstanding, overdue).
- A buyer's statement.
- The **MahaRERA quarterly update** in Excel: units booked in the quarter and to date, amounts collected, the
  designated account's deposits and withdrawals, and each tower's construction progress (from the milestones
  reached).

**Screen:** "Sales", with tabs for Inventory (a grid of units by floor, coloured by status), Bookings, Demands and
receipts, and RERA.

**Rights:** a new `sales.edit` (managers). Postings also need `accounts.post`, as other money steps do.

**Tests:**
- Unit: the agreement value, demand amounts with GST, the 10% rule, interest by day, the RERA share and the
  withdrawal limit.
- An integration test:
  - A tower of units and a plan (10% on booking, 20% on agreement, 30% plinth, 40% possession).
  - A booking, with the agreement's demand held until registration.
  - Milestones reached and demands posted; a receipt allocated, with the 70% due.
  - A deposit, a withdrawal refused past the limit and allowed within it.
  - Interest on a late demand.
  - The vouchers checked in the trial balance, and the quarterly workbook read back.
- A browser test: units, a booking, a milestone, a demand and a receipt, and the RERA tab's numbers.

## Risks

1. [Likely] Portals change the security model (outside users in a tenant's database); they need their own
   penetration test before release (Phase 9 security).
2. [Certain] Offline sync is where data conflicts and duplicate postings happen; it is kept to a few forms on purpose.
3. [Guessing] Real estate sales may pull the product toward developers and away from contractors.

## Questions for you before Wave 6 starts

1. Are developers (real estate sales and RERA) a target segment?
2. Are external portal users priced, and how (Phase 6)?
3. Which site forms must work offline?
