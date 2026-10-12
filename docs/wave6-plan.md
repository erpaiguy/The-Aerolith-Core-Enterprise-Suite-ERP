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

## Step 2 delivered

[Certain] As planned (migrations 0066 and 0067, schema `re`, permission `sales.edit`):
- **Inventory:** towers, units and agreement values (carpet × rate + parking + charges, in paise). Units are shown by
  floor, coloured by status.
- **Bookings** BK-001…:
  - The buyer is recorded, and a **buyer party** opened (`is_buyer`, ledger under debtors, named
    "<tower>-<unit> <buyer> (BK-…)") so buyers stay out of client lists.
  - Booking raises the booking stage at once.
  - Registering the agreement raises the agreement stage and any milestone already reached that RERA §13 held back.
  - Cancelling frees the unit.
- **Plan:**
  - Stages must total 100%. A stage falls due on booking, on the agreement or on a milestone (of one tower or all).
  - Site marks a milestone reached, which raises a demand for every live booking it applies to.
  - The plan cannot be replaced once anything has been demanded on it.
- **Demands** DM-…:
  - The stage's % of the value, plus GST at the unit's rate (5, 1 or 12%) split into CGST and SGST halves, due in the
    project's days.
  - Posted as a sales voucher: buyer Dr; advances from flat buyers (a new role and ledger) Cr; output CGST and SGST
    Cr.
- **Receipts** RC-…:
  - Posted Dr the collection bank, Cr the buyer, and allocated oldest first.
  - The GST inside each allocation is in proportion.
  - The RERA share (70% of what is not GST) is recorded on the receipt.
- **Interest:**
  - Simple, by day, at the project's rate, on each payment made late and on what is still open.
  - "Raise interest" posts it to interest income, less whatever was raised before.
- **The designated account:**
  - Required against deposited. Deposits and withdrawals are contra vouchers.
  - A withdrawal needs the completion % and the three certificate references, and is refused above deposits ×
    completion % less what has been withdrawn.
- **MahaRERA quarterly update** in JSON and Excel: bookings by tower in the quarter and to date, milestones reached,
  collections, deposits and withdrawals.
- **Fixed while testing:** 0066 gave the new ledger the code L4006, which payroll already uses, so it was skipped.
  0067 adds it as L4020; 0066 was not edited, being committed.
- **Tests:**
  - `re-rules.spec.ts`.
  - `realestate.int.spec.ts`: one flat end to end with every figure worked by hand (the §13 hold, ₹5,139.68 + ₹7,709.52
    interest, the buyer's ledger at ₹26,30,499.20, advances at ₹49,86,000, the 20%-completion withdrawal limit of
    ₹3,49,020, the quarterly workbook).
  - The browser test `sales.spec.ts`.
- [Guessing] **For a CA to confirm before a tenant relies on it:** demands booked as advances (revenue left to
  possession or percentage completion, outside this step), and GST charged on each demand.

## Step 3 in detail (planned before building)

**What is there.** [Certain] Fixed reports and dashboards with a KPI picker (Wave 1 step 12), ECharts in the web app,
ExcelJS on the server, notifications in the inbox, and hourly background loops over tenants (the documents janitor).
Nothing lets a manager build their own report.

**The reporting model** (code, not tables):
- A registry of **views**, each a fixed, reviewed SQL source over one module, with its **fields**: a name, a label, a
  type (text, number, money, date or month), and whether it can be grouped or summed. The first views:
  - Projects.
  - Purchase orders.
  - Goods receipts.
  - Vendor bills.
  - Client (RA) bills.
  - The ledger's lines.
  - CRM leads.
  - Flat bookings.
  - RFIs.
- **Access as on the screens:**
  - A view with a project column returns only the projects the person may see (their team, or every project with
    `projects.all`).
  - A view may need a permission: the ledger's lines need `accounts.view`.
- **No SQL from the browser, ever.** A report is a **spec**: the view, the chosen fields, filters (equals, not equal,
  greater or less, between, contains, in), group-by fields, sums, counts and averages, a sort and a limit.
  - The server builds the query from the registry's identifiers only. Values are bound as parameters, and every field
    name is checked against the view.
  - [Certain] Results are capped at 10,000 rows on screen and 100,000 in Excel.

**Saved reports** (`bi.report`):
- A name and the spec, shown as a **table or a chart** (bar, line or pie, choosing the label field and the value
  field).
- **Shared** with nobody, managers, or everyone. Whoever opens a shared report still sees only their own projects'
  rows.
- Copied, renamed, deleted by their owner or an admin.

**Scheduled exports** (`bi.schedule`):
- Daily, weekly (a day of the week) or monthly (a day of the month), at 07:00 IST.
- The background loop (hourly, like the documents janitor) runs what is due **as the report's owner**. Their access
  applies, and an owner who has left gets no export.
- The Excel file is kept for 30 days (`bi.export`, at most 5 MB). The owner and the people chosen get an inbox notice
  with a link to download it (staff have no email, docs/03-architecture.md §6).

**Screen:** "Report builder":
- Saved reports on the left.
- The builder: the view, then fields, filters, grouping and sums as chips and selects.
- The result as a table or a chart, with "Save", "Share", "Excel" and "Schedule".

**Rights:** everyone may build and run (within their access); saving and sharing are for anyone; scheduling is for
managers and admins.

**Tests:**
- Unit: the query builder.
  - Spec to SQL fragments, refusing an unknown field, an unknown view, a group-by without a sum, and a filter of the
    wrong type.
  - Identifiers are never interpolated from input.
- An integration test:
  - Purchase orders grouped by vendor with summed value, checked against the orders made.
  - A worker on one project sees only that project's rows; the ledger view refused without `accounts.view`.
  - Saved, shared with managers, opened by a manager.
  - A schedule run by calling the runner with a clock, the export downloaded and parsed, and a schedule whose owner
    is deactivated skipped.
- A browser test: a report built (bookings by tower, value summed), shown as a bar chart, saved, exported to Excel.

## Step 4 in detail (planned before building)

**What is there.** [Certain] One web app, served by Caddy, with the desktop app (Electron) wrapping it. No manifest,
no service worker; a lost connection fails a save with "network error".

[Certain] **This container has no Android SDK or Xcode.** Store packages can be built and signed only on a machine
that has them. So the step ships two things:
1. The web app as an **installable PWA** with the offline outbox. This is what phones use from day one ("Add to Home
   screen"), and what the store app wraps.
2. **`apps/mobile`**, a Capacitor (MIT) project: its configuration, and the steps to generate and sign the Android
   and iOS projects where the SDKs are.

**PWA:**
- A web manifest (name, icons, standalone display, theme) and a hand-written service worker. The worker caches the
  app shell (the page and its hashed assets) so the app opens with no signal. API calls are never cached: data stays
  live or comes from the outbox.

**The offline outbox** (in the browser, IndexedDB):
- Only these forms queue, the owner's list:
  - The daily site report: create and save its sections.
  - Attendance at a site.
  - A goods receipt against an order.
  - A store issue.
  - A quality checklist.
- With no signal (offline, or a network error), the request is kept with an **idempotency key** made on the phone.
  The screen says "Saved on this phone; it will be sent when there is signal". An "Outbox" chip shows how many are
  waiting.
- Sending happens on regaining signal, every 30 seconds, and from the Outbox page:
  - Oldest first, one at a time.
  - Stopped at the first refusal, which stays in the outbox with its reason for the person to fix or discard.
  - Nothing else is retried behind a refused item, so the order holds.

**The server's half: idempotency** (`platform.idempotency`):
- Those routes accept an `Idempotency-Key`. The first request's status and response are stored against
  (key, user, route) for 7 days, and a repeat returns the stored response without running again.
- [Certain] **A receipt cannot be posted twice however many times the phone retries.**
- The daily report already merges by section: each save updates its sections of that day's report.

**Camera and location** come with the store app (Capacitor plugins, MIT). The PWA uses the browser's file input with
`capture`, which opens the camera on phones, and `navigator.geolocation` for the site check-in.

[Likely] **No push notifications** in this step. Push needs Firebase Cloud Messaging or APNs: an account and keys per
deployment, against "no paid tools" for anyone without one. The inbox keeps notifying in the app.

**Tests:**
- Unit: the outbox (queue, order, stop at the first refusal, discard) against a fake IndexedDB and fake fetch.
- An integration test: the idempotency layer, the same key twice making one receipt and returning the same body; a
  different user with the same key not seeing the first user's response; a key reused on a different route refused.
- A browser test in a poor-signal area: the browser set offline, a daily report and a goods receipt saved into the
  outbox, the page reloaded offline (the app shell from the cache), back online, both sent once, the outbox empty,
  and the receipt appearing once.

## Step 3 delivered

- **Reporting model** (`apps/api/src/bi/views.ts`): nine views (projects, purchase orders, goods receipts, vendor
  bills, client bills, ledger lines, CRM leads, flat bookings, RFIs). Each has typed fields and its own access: a
  project column scoped to the person's projects, and the ledger behind `accounts.view`.
- **Query builder** (`bi/query.ts`):
  - A spec becomes SQL only from registry identifiers.
  - Every value is a bound parameter.
  - Refused with a reason: an unknown view or field, a wrong-typed filter, and a group-by without a sum.
  - Capped at 10,000 rows on screen and 100,000 in Excel.
- **Saved reports, sharing, scheduled exports** (migration `0068_bi.sql`: `bi.report`, `bi.schedule`, `bi.export`):
  - Schedules run daily, weekly or monthly at 07:00 IST.
  - The hourly runner (`REPORTS_WORKER`, off in tests) runs each report as its owner and skips an inactive owner with
    a reason.
  - Files are kept 30 days. Recipients get an inbox notice with the download link.
- **Screen:** "Report builder" (`/reports/builder`): view, fields, filters, grouping and sums; table or bar, line or
  pie chart; save, share, Excel, schedule.
- **Tests:**
  - Unit: the query builder and the next-run clock.
  - Integration (`bi.int.spec.ts`): grouped sums checked against the data made, a worker's scope, the ledger refused,
    share and open, the runner with a clock, the file parsed, the inactive owner skipped.
  - Browser (`report-builder.spec.ts`).
- **Departure from the plan:**
  - The browser test groups **CRM leads by source**, not bookings by tower. A booking needs the whole sales setup
    first, and the sales spec already covers bookings.
  - The integration test also groups leads, not purchase orders, for the same reason. The purchase-orders view is
    covered by the unit tests only. [Likely] That is enough because every view shares one builder; the per-view
    risk is in its source SQL, which runs in the scope test.

## Step 4 delivered

- **Installable app:**
  - `apps/web/public/manifest.webmanifest` and an icon.
  - A hand-written service worker (`public/sw.js`):
    - On install it caches the page and the assets the page names. Later assets are cached as they load.
    - Pages are network-first, with the last good copy when there is no signal.
    - `/api` is never cached.
  - Registered in production builds, not in the desktop app.
- **Offline resume:** the last signed-in user is kept on the device. A reload with no signal opens the app signed in,
  and the first request after the signal returns refreshes the session, or signs out if it is gone. Signing out
  forgets it.
- **The outbox** (`apps/web/src/offline`, IndexedDB):
  - Used by the goods receipt, store issue, site attendance and quality checklist.
  - Each is sent with an idempotency key made on the phone, or kept with "Saved on this phone".
  - The header chip shows how many are waiting; the Outbox page lists them.
  - Sending is in order and stops at the first refusal.
- **The daily report keeps its own path.** Since Wave 2 it has saved a local draft and retried every 10 seconds with
  no signal. Its saves carry the row version, so a repeat is refused rather than applied twice. Its routes also accept an idempotency key, for the store app.
  - **Departure from the plan:** a new day's report must be opened once with signal. [Likely] This is rare in
    practice, because the site opens the day's report in the morning.
- **Idempotency on the server** (migration `0069_idempotency.sql`, `common/idempotency.ts`):
  - On the six site-form routes, the first success is kept per person and key for 7 days and replayed.
  - The same key on another route is refused (409).
  - A request still running is told to wait.
  - A refusal is not kept, so the person can fix the form and resend.
- **`apps/mobile`:**
  - A Capacitor 8 (MIT) shell that opens one deployment's web app, configured by `AEROLITH_SERVER_URL`.
  - `pnpm --filter @aerolith/mobile android|ios` where the SDKs are. The generated projects and signing keys are not
    committed.
  - [Likely] Apple's review may refuse a wrapper (guideline 4.2). The README gives the fallback: bundle the web app
    and keep the refresh token in native secure storage.
- **Tests:**
  - Unit: the outbox.
  - Integration (`idempotency.int.spec.ts`):
    - One report however often it is sent, with the same answer each time.
    - A stale-version save replayed, not refused.
    - Another person's same key runs as their own.
    - A key reused on another route is refused.
    - A bad key is refused.
  - Browser (`offline.spec.ts`): offline, a receipt saved on the phone, the page reloaded with no signal (the app from
    its cache, still signed in, the outbox listing it), signal back, sent once, the outbox empty, one GRN on the
    order.

## Step 5 in detail (planned before building)

**What is there.** [Certain]
- Staff accounts (`platform."user"`, seats) sign in with a device licence.
- A transmittal can be shared by an unguessable link (`/share/:tenant/:token`, Wave 5).
- These already exist and portals hang off them:
  - Vendors are invited to RFQs (`tender.rfq_vendor`) and staff type their quotes.
  - Orders and work orders carry a `party_id` and an acknowledgement.
  - Work-order measurements are append-only.
  - Vendor bills have an outstanding figure derived from paid runs.
  - Client RA bills reach the client through `proj.project.client_id`.
- Outbound email exists only on the control plane (owner accounts). The tenant side sends none.

**Identity, kept apart from staff by construction:**
- `portal.user` in the tenant database:
  - A party, a kind (vendor, subcontractor or client), an email (unique), a name, and an argon2 password hash.
  - Status: invited, active or deactivated. Failed-login lockout after 5 tries for 15 minutes, as for staff.
- `portal.session`: refresh sessions, as for staff.
- The access token is a new kind, **`portal`** (`{ten, sub, party, pk, sid}`, 15 minutes).
  - [Certain] **The existing staff guard refuses every token that is not `tenant`, so a portal user can reach no staff
    route.**
  - A new `PortalGuard` admits only `portal` tokens to `/api/portal/*`, and every portal query filters by the token's
    party.
- The refresh cookie is `aerolith_prt` on `/api/portal/auth`.
- Sign-in is at `/portal/<tenant>` with email and password. No device licence is needed. The tenant's licence must not
  be revoked or suspended, and when it is read-only the portal is read-only too.

**Invitations and the fair-use cap:**
- Staff with the new permission **`portal.manage`** (admins and managers by default) invite an email for a party and
  a kind. The party must carry that role, for example a vendor for the vendor portal.
- The invite link is shown once (`/portal/<tenant>/accept#<token>`, valid 7 days, its hash kept). Staff send it the
  way they send share links. Accepting sets a password, and possession of the link is the proof.
  - [Likely] Sending it by email from the tenant needs a tenant mail setup, which does not exist. That is a later
    addition.
- **Cap:**
  - `core.licence.portal_cap` (control-plane migration 0005): default 50 **per kind**, counting invited and active
    users.
  - Inviting past it is refused with `portal_cap_reached`.
  - The owner console changes it on the licence page (`POST owner/licences/:id/portal-cap`, with a reason), recorded
    as a `portal_cap_changed` licence event.
  - Portal users never count as seats.
- Staff can resend (a new link), deactivate (sessions revoked) and see the last sign-in.

**Submissions are checked by staff before they count** (`portal.submission`):
- Kinds:
  - A **quote** against an RFQ the vendor was sent.
  - A **measurement** against a work order.
  - An **invoice** (a PDF or image, with number, date and amount) against an order.
- The flow:
  - Staff on that project are notified in the inbox.
  - On "Submissions from portals", staff **accept** or **reject** with a reason. Accepting a quote saves it through
    the RFQ's own quote entry (a new round). Accepting a measurement records the work-order measurements.
  - Accepting an invoice marks it received for the accounts team, who post the vendor bill as today with the file
    attached. [Likely] Posting bills straight from a vendor's figures is the wrong control.
  - The submitter sees the status and any reason.
- **Order acknowledgement** is the vendor's own act and counts directly (recorded as "Portal: name"), as it would on
  paper.

**What each portal shows** (read-only unless stated):
- **Vendor:**
  - Enquiries sent to them, open until due: lines and quantities, and their quote (submit).
  - Their orders: lines, and acknowledge.
  - Their invoices with status (submit).
  - Their bills: amount, TDS, paid and outstanding.
- **Subcontractor:**
  - Their work orders: lines, measured to date, and submit a measurement.
  - Their RA bills: status and certified amount.
  - Bills and payments, as for a vendor.
- **Client:**
  - Their projects: contract value, billed, certified and received, and the latest site photos from daily reports
    (30 days).
  - Their RA bills with status and received.
  - Transmittals addressed to their party: acknowledge and respond, through the same service as the share link.

**Screens:**
- Staff: "Portal users" (invite, resend, deactivate, cap used of 50) and "Submissions from portals".
- Outside users: `/portal/<tenant>`, a small separate shell in the same web bundle with its own session. Sign in,
  then tabs for what their kind sees.

**Tests:**
- Unit: invite and cap rules.
- Integration:
  - The cap at 50 per kind, raised by the operator.
  - Invite, accept and sign in. Lockout after 5 failures.
  - A portal token refused on a staff route, and a staff token on a portal route.
  - Vendor A cannot see vendor B's enquiry or order (404).
  - A quote submitted, accepted and visible in the RFQ comparison.
  - A measurement submitted and accepted into the work order.
  - A client sees only their own project's bills.
  - A deactivated user's session refused.
- Browser: a vendor invited, accepting, quoting and uploading an invoice. Staff accept the quote and see it in the
  comparative statement.

## Step 5 delivered

- **Identity apart from staff:**
  - `portal.user` and `portal.session` (migration `0070_portal.sql`).
  - A `portal` token kind. The staff guard already refuses it, and `PortalGuard` admits nothing else to `/api/portal/*`.
  - The guard checks on every request that the session is live and the user active, so deactivating someone ends
    their access at once, not when their 15-minute token expires.
  - Their own refresh cookie (`aerolith_prt`, `/api/portal/auth`, HttpOnly, SameSite=Strict, plus the client header).
  - Lockout after 5 failures for 15 minutes.
- **Invitations and the cap:**
  - Staff with `portal.manage` invite an email for a party of the right kind.
  - The link (`/portal/<tenant>/accept#token`, 7 days) is shown once, and "New link" replaces it.
  - The fair-use cap is `core.licence.portal_cap` (control-plane migration 0005, default 50 per kind). It is changed
    on the owner console's licence page with a reason and recorded as a `portal_cap_changed` event.
  - [Certain] Portal users are never seats; the test proves the seat count is unchanged.
- **Vendor and subcontractor portal:**
  - Enquiries sent to them, open until due, and a quote online.
  - Their orders (supply orders for vendors, work orders for subcontractors), and acknowledge, recorded as
    "Portal: name".
  - Measurements (subcontractors).
  - Invoices: a PDF or photo, recognised by content, at most 10 MB.
  - Bills with TDS, outstanding and last paid. RA bills for subcontractors.
- **Client portal:**
  - Their projects: contract value, billed, certified and paid.
  - RA bills with status.
  - Site photos from daily reports, last 30 days.
  - Transmittals addressed to their party: download, acknowledge, respond. These use the same transmittal service
    as the share link; the view was factored out (`outward`).
- **Checked before it counts** (`portal.submission`, numbered PS-000001):
  - Staff on "Portal submissions" accept or reject with a reason. Project leads, or the order's author, are notified
    in the inbox.
  - A submission is claimed first, so two people cannot both accept it, and released if the module refuses it.
  - Accepting a quote saves it through `RfqService.saveQuote` as a new round, which needs `rfq.edit`.
  - Accepting a measurement books all its lines in one transaction (`SubcontractService.measureMany`), with the
    book's own checks.
  - Accepting an invoice marks it received. The accounts team posts the bill as today, with the file.
  - Invoice files are protected from the document purge (`lifecycle.service.ts`).
- **Screens:**
  - Staff: "Portal users" and "Portal submissions" (shown with `portal.manage`).
  - Outside users: `/portal/<tenant>`, its own sign-in, session and tabs for their kind.
  - The owner console's licence card: "Portal users per kind".
- **Tests:**
  - Unit: the cap and party rules.
  - Integration (`portal.int.spec.ts`, 7 tests):
    - The cap at 1 refused, then raised by the operator with its event.
    - Accept, sign in, lockout.
    - Tokens kept apart, both ways.
    - Vendor B gets 404 on vendor A's enquiry.
    - A quote accepted into the RFQ with its reference; accepting twice refused.
    - A work order acknowledged; a measurement accepted into the book.
    - A non-invoice file refused; a PDF fetched back byte for byte, then rejected with a reason.
    - A client seeing only their own project and transmittal, and acknowledging it.
    - A deactivated user's session refused at once; a worker cannot invite.
  - Browser (`portal.spec.ts`): an RFQ subcontractor invited, the link opened in a separate browser, a password set,
    a quote sent; the estimator accepts it and it appears in the RFQ's comparative statement.
- **Departures from the plan:**
  - The browser test does not upload an invoice, because an issued order through the screens doubles its length. The
    integration test covers the upload, the type check and fetching the file back.
  - Invitations are not emailed. The tenant side has no mail setup, so staff send the link.
  - [Likely] Portal users have no second factor in this step. Lockout and short sessions (2 hours idle) stand in for
    it until the security review (Risk 1).

## Step 6 in detail (planned before building)

**What is there.** [Certain]
- Wave 3 makes **files**: Tally XML (masters and vouchers for a period) and e-invoice JSON. The IRN that comes back
  from the portal is typed in by hand.
- The report builder (step 3) has a reviewed model of nine views with access as on the screens.
- There are no API keys, no webhooks and no Tally connection.

**Public API** (`/api/v1`):
- **API keys** (`platform.api_key`):
  - Made by an admin, each with a name and scopes. The secret is shown once and kept as an HMAC.
  - The key format is `aek1.<tenant>.<id>.<secret>`, so the tenant comes from the key, never from the caller.
  - A key acts **as the admin or manager who made it**, so their project access applies, and a deactivated maker's
    keys stop working.
  - Revocable; the last use is recorded.
- **Scopes:** `reports:read` (the report views) and `tally` (the Tally agent).
- **Endpoints:**
  - `GET /v1/views` and `POST /v1/views/:view/query`: the report builder's spec, so the read API is the same reviewed
    model with the same access rules and caps. No SQL from outside.
  - `GET /v1/openapi.json`, generated from the same zod schemas with zod's own JSON Schema output (MIT, no new
    dependency).
- **Rate limit:** 120 requests a minute per key, on top of the per-IP limit.

**Webhooks** (`platform.webhook`, `platform.webhook_delivery`):
- Admins add an https URL and choose events. The signing secret is shown once.
- **Events:**
  - `order.issued`: an order or work order issued, or re-issued after an amendment.
  - `receipt.posted`: a goods receipt.
  - `bill.certified`: a client RA bill or a subcontract bill.
  - `portal.submission`: something sent from a portal.
- Each event is written **in the same transaction** as the change (an outbox), so nothing is sent for a change that
  rolled back.
- **The sender:** a background loop (`WEBHOOK_WORKER`, off in tests, which call it directly).
  - Each delivery is signed: `x-aerolith-signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">`.
  - 10-second timeout; success is any 2xx.
  - Retries at 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then given up and shown as failed.
  - Redirects are not followed.
  - **SSRF guard:** the host is resolved and private, loopback and link-local addresses are refused (allowed only
    by `WEBHOOK_ALLOW_PRIVATE` for tests and on-premises installs).
- **Screen:** recent deliveries with their status and a "Send a test" button.

**Tally link** (the connector agent, `tools/tally-agent`):
- A single Node script with no dependencies, MIT like the rest, run on a PC on the tenant's LAN beside Tally Prime.
- With a `tally` key it asks the server for vouchers not yet in Tally (`GET /v1/tally/pending`), each as its own Tally
  XML message (Wave 3's generator, unchanged), and posts each to Tally's HTTP server (default
  `http://localhost:9000`).
- It reads Tally's reply (CREATED, ALTERED, ERRORS, LINEERROR) and reports it back (`POST /v1/tally/results`).
- `acc.tally_sync` keeps, per voucher, when it went and Tally's answer. A failed voucher stays pending with Tally's
  error shown in the app.
- Masters (ledgers and parties) are sent first, the same way.
- [Likely] Tally must have the company open and its HTTP server enabled (F1 > Settings > Connectivity). The agent
  says so when it cannot connect.

**e-invoice and e-way bill adapters:**
- [Certain] **Not built in this step.** A GSP or ASP API needs the tenant's contract, sandbox credentials and the
  provider's own authentication (NIC's uses RSA and AES session keys). Writing it without a sandbox would ship
  untested code against a tax system.
- What is built: the boundary (`EInvoiceProvider`, with today's file workflow as the default provider) and a setting
  for which provider a company uses. The first real adapter is written against a tenant's sandbox when one is
  available.

**Rights:** API keys and webhooks are admin-only. Tally sync status is shown to `accounts.view`.

**Tests:**
- Unit: the signature, the retry schedule, the private-address check, and Tally's reply parsed.
- Integration:
  - A key made, used and revoked.
  - A scope refused.
  - A maker's project access applied, and a deactivated maker's key refused.
  - The OpenAPI document served.
  - A webhook to a local server: a receipt posted gives one signed `receipt.posted`, verified with the secret.
  - A 500 retried on schedule, then succeeding.
  - A private address refused without the test flag.
  - Tally: pending vouchers fetched as XML, results recorded, and a voucher no longer pending once created.
- The agent against a fake Tally HTTP server.
- Browser: an admin makes a key, a request with it returns rows, and after revoking it the request is refused.

**Exit check for Wave 6:**
- A manager builds a report without help: the step 3 browser test.
- A vendor quotes and invoices through the portal: the step 5 browser test, plus the integration test for the
  invoice.
- A site submits from the phone in poor signal: the step 4 browser test, for a receipt. The daily report keeps its
  own draft and retry. The run of the whole suite is recorded under "Wave 6 exit".

## Step 6 delivered

- **Public API** (`/api/v1`, migration `0071_integrations.sql`):
  - API keys (`aek1.<tenant>.<id>.<secret>`) with the HMAC kept, the last four shown, scopes, last use and revoke.
  - Each key acts as the admin who made it, through the same services and checks as the screens.
  - `GET /v1/views` and `POST /v1/views/:view/query` are the report builder's reviewed model, so no SQL comes from
    outside, and access and caps are those of the screens.
  - `GET /v1/openapi.json` is built from the same zod schemas (zod's own `toJSONSchema`).
  - Rate limits: 120 requests a minute per key, plus the per-IP limit.
  - A key is never accepted on staff routes, and a staff token never on `/v1`.
- **Webhooks:**
  - Events: `order.issued`, `receipt.posted`, `bill.certified` (client and subcontract bills) and
    `portal.submission`.
  - Each is written in the same transaction as the change (`integrations/events.ts`).
  - Signed with HMAC-SHA256 over the timestamp and body. 10-second timeout; redirects are not followed.
  - Retries at 1, 5, 30, 120 and 720 minutes, then marked failed.
  - https only, and private, loopback and link-local addresses are refused after DNS. Both are relaxed only by
    `WEBHOOK_ALLOW_PRIVATE`.
  - The sending loop runs every 30 seconds behind `WEBHOOK_WORKER`.
  - The screen has "Send a test", "Turn off" and the last 50 deliveries.
- **Tally link:**
  - `tools/tally-agent/agent.mjs`: Node 20 or later, no dependencies, with a README.
  - It sends each pending voucher as its own Tally import, reads Tally's reply, and reports back.
  - `acc.tally_sync` keeps what went in. A refused voucher stays pending with Tally's message, which the
    Integrations screen shows.
  - Wave 3's voucher XML is unchanged; it was factored into `voucherXml`.
- **Screen:** Settings › Integrations (admins): API keys, webhooks, and Tally progress.
- **Tests:**
  - Unit: signature and tolerance, the retry schedule, private addresses (IPv4, IPv6, mapped), key format, and
    Tally's reply.
  - Integration (`integrations.int.spec.ts`):
    - A key made by an admin only, reading the projects view sorted.
    - An injected field name refused.
    - Keys and staff tokens kept apart.
    - A missing scope refused (403); a revoked key refused (401), with its last use recorded.
    - The OpenAPI paths.
    - A webhook to a local server: the test ping verified with the secret.
    - An order issued gives exactly one delivery, written with it. The first try gets a 500, the retry is not early,
      it is sent two minutes later, and the signature verifies.
    - The real agent against a fake Tally: one voucher created, one refused and still pending with Tally's message,
      and the counts on the screen.
  - The suites whose services now emit events pass unchanged: orders, receipts, client and subcontract bills,
    portals, BI and Tally.
  - Browser (`integrations.spec.ts`): an admin makes a key, a request with it returns the project, and after "Revoke"
    the same request gets 401.
- **Departures from the plan:**
  - **Keys are admin-only and act as that admin**, so they see every project. "A deactivated maker's keys stop" is in
    the code (the maker must be active and not a worker) but not tested: a tenant's admin is its owner account,
    which cannot be deactivated from inside the tenant.
  - **No e-invoice or e-way bill adapter, and no provider boundary.** With one provider (today's file workflow) an
    interface would be speculation. The adapter is written against a tenant's GSP sandbox, with its credentials,
    when one exists.
  - **Masters are not pushed by the agent.** The README says to import the masters file once, from Wave 3's
    existing export. [Likely] Ledgers change rarely, and Tally merges masters better by hand than by an unattended
    agent.

## Wave 6 exit (2026-10-12)

- **Full check green:**
  - API: 549 tests in 107 files.
  - Web: 32. Owner: 3. Desktop: 4. Shared: 19. Bench: 3.
  - Format, lint, types and the licence gate: 617 third-party packages, all allowed.
- **Browser suite: 64 of 64**, on a clean run of 23.9 minutes. A first run failed 2 of 64: three tests looked for the
  "Users" link by substring, and the new "Portal users" link matched too. The locators were made exact and the whole
  suite was run again.
- **The exit criteria:**
  - **A manager builds a report without help:** `report-builder.spec.ts` (leads grouped by source, charted, saved,
    sent to Excel).
  - **A vendor quotes and invoices through the portal:** `portal.spec.ts` covers the quote, from invitation to the
    comparative statement. `portal.int.spec.ts` covers the invoice upload, the type check, staff fetching it and
    the rejection.
  - **A site submits from the phone in poor signal:** `offline.spec.ts` covers a receipt saved offline, the page
    reloaded with no signal, and the receipt sent once when the signal returns. The daily report keeps its Wave 2
    draft-and-retry; a new day's report needs signal once.
- [Certain] **None of this has met a real pilot site, vendor or client.** As with Waves 1 to 5, the exit criteria are
  proven in tests, not in use.
- **Open items carried forward:**
  1. The e-invoice and e-way bill GSP adapter waits for a tenant's sandbox credentials.
  2. The portal's security review before release (Risk 1). There is no second factor for portal users yet.
  3. Apple's review of the store wrapper (guideline 4.2) is untested until a build is submitted.
  4. **The Wave 7 outline counted on "a model-serving interface behind a feature flag (to be added in Wave 6 at the
     latest)". It was not built in Wave 6.** It is the first item to decide before Wave 7 or before v1 is called
     complete.

## Risks

1. [Likely] Portals change the security model (outside users in a tenant's database); they need their own
   penetration test before release (Phase 9 security).
2. [Certain] Offline sync is where data conflicts and duplicate postings happen; it is kept to a few forms on purpose.
3. [Guessing] Real estate sales may pull the product toward developers and away from contractors.

## Questions for you before Wave 6 starts

1. Are developers (real estate sales and RERA) a target segment?
2. Are external portal users priced, and how (Phase 6)?
3. Which site forms must work offline?
