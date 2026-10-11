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

## Risks

1. [Likely] Portals change the security model (outside users in a tenant's database); they need their own
   penetration test before release (Phase 9 security).
2. [Certain] Offline sync is where data conflicts and duplicate postings happen; it is kept to a few forms on purpose.
3. [Guessing] Real estate sales may pull the product toward developers and away from contractors.

## Questions for you before Wave 6 starts

1. Are developers (real estate sales and RERA) a target segment?
2. Are external portal users priced, and how (Phase 6)?
3. Which site forms must work offline?
