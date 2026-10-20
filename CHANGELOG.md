# Changelog

What changed in each release of Aerolith Core, newest first.

## 0.9.0 (2026-10-20)

### Other changes

- Add phases 1-3 planning docs: MVP, tech stack, architecture
- Revise phases 1-3: 7-wave plan, Electron, large-scale data layer, identity model, performance architecture
- Lock phases 1-3 (rev 3): licence gate, staff reset flow, key-delivery automation, v1/v2 release plan
- Phase 4 draft, licensing policy, tender programme decision, bank/Tally design, admin recovery
- Lock phase 4; document existing infrastructure and Supabase hardening plan
- Revise tenant provisioning modes, seat/tier model, control-plane retention draft
- Phase 5 database draft; record trial, seat and retention decisions
- Lock phase 5 (tenant-owned Supabase orgs, multi-GSTIN entities); add phase 6 pricing framework
- Lock phase 6 pricing; add phase 7 payments draft
- Lock phase 7 payments; add phase 8 dashboard draft
- Lock phase 8 dashboard (KPI picker, opt-in telemetry); add phase 9 security draft
- Lock phase 9 security; add phase 10 deployment draft
- Lock phase 10 deployment: Windows-only signed desktop, owner-PC stage 0 hosting rules
- Supabase OAuth setup guide; use non-deprecated create-project fields; load .env on start
- API support for app shells: browser refresh cookie, CORS for desktop, inbox and reminders
- Allow rest-sibling omission in lint rule (fixes lint on refresh-cookie routes)
- Browser app: activation, sign-in with MFA enrolment, password flows, shell, inbox, users
- CI: install Playwright Chromium without apt deps and with a 5-minute cap
- e2e: bind Vite preview to 127.0.0.1
- Email worker: SMTP delivery with retries, suppression and owner controls
- Email test: pin the clock a second ahead to avoid millisecond-precision flake
- Owner decisions: search index for every tenant, admin-set role permissions
- Import check: drop the smooth auto-scroll to the result
- Bid decision: keep scores being clicked while the tender refetches
- CI: pull Docker Hub images through Google's public mirror
- CI: take the Docker stack's base images from the mirror too
- Third-party notices and SBOM in every image and installer
- Notices: run pnpm through Node, so the Windows desktop build finds it
- BOQ: provisional sums, rate-only items, alternates, templates, bulk edit
- BOQ: items priced in another currency
- Tenders: company bid criteria and checklist, month calendar, names
- RFQ: negotiation rounds, quotes-due reminders, quote documents
- Documents: company folders, folders moved, deleting for good, links
- Documents: search inside PDFs, thumbnails
- BOQ grid: anywhere in a BOQ of a million lines
- Fix the Windows desktop build: two modules named alike but for case
- Docs: bring Wave 1's not-built lists up to date
- Plans for every wave before it is built
- Browser tests: exact menu links now that Procurement reports and Chart of accounts exist
- Remove an unused helper from the transmittal service
- Demo company seeder, walkthrough tests, and fixes they found
- Demo: Docker-only setup on any OS; never lose the printed sign-ins
- Menu: groups that fold, an Estimation group, and a sidebar that scrolls on its own
- Demo: replay two and a half years of the company's history through the API
- Demo: profitable bids, a cash-credit limit, unique supplier bill numbers
- Workers no longer fetch a bill's GST; a hidden project's page says why
- Browser tests: find buttons inside the page, not the new menu groups
- Demo: Sai Residency is active from April 2026
- Serve pages with no-cache so a new release shows at once
- Improvement plan through each role's eyes
- Demo: history for the wave 7 registers; dashboard chart legend on top
- Demo: keep the recurring entries page out of everyone's walkthrough
- Daily report photos: never hold the upload waiting on the phone's position
- i18n: one translation per English string across screens; senses for words that differ

### Wave 0

- Wave 0 step 1: monorepo scaffold with CI and licence gate
- Wave 0 step 2: performance benchmark for 1M-line BOQ and 50k-activity schedule
- Wave 0 step 3: control plane with licence keys, trials, seats and devices
- Wave 0 step 4: tenant provisioning, Supabase onboarding and migration orchestrator
- Wave 0 step 5: authentication, mandatory MFA, sessions, staff resets and seat enforcement
- Wave 0 step 6: Windows desktop shell, browser e2e, accessibility fix, CI jobs
- Wave 0 step 7: Docker Compose stack for the owner PC
- Wave 0 step 8: owner console

### Wave 1

- Wave 1 step 1: tender register
- Wave 1 step 2: BOQ engine (API)
- Wave 1 step 3: BOQ grid
- Wave 1 step 4: BOQ import from Excel/CSV and export
- Wave 1 step 5: rate library and rate analysis
- Wave 1 step 6: measurement sheets and bid pricing
- Wave 1 step 7: BOQ revisions (copy-on-write), compare, lock on submission, archiving
- Wave 1 step 8 (part 1): tender management detail
- Wave 1 step 8 (part 2): import a client's revised BOQ into a revision
- Wave 1 step 9: RFQs to vendors and subcontractors
- Wave 1 step 10: tender documents
- Wave 1 step 11 (part 1): the tender programme
- Wave 1 step 11 (part 2): MS Project and Primavera files
- Wave 1 step 12 (part 1): reports
- Wave 1 step 12 (part 2): dashboards

### Wave 2a

- Wave 2a step 1: projects
- Wave 2a step 2: contract BOQ and budget
- Wave 2a step 3: WBS and cost codes
- Wave 2a step 4: project schedules
- Wave 2a step 5: macro plans
- Wave 2a step 6: progress measurement
- Wave 2a step 7: project dashboard and reports

### Wave 2b

- Wave 2b step 1: approvals and purchase requisitions
- Wave 2b step 2: material budget and demand
- Wave 2b step 3: vendor enquiries for a project
- Wave 2b step 4: purchase and work orders
- Wave 2b step 5: goods receipt and inspection
- Wave 2b step 6: inventory
- Wave 2b step 7: daily site reports
- Wave 2b steps 8 and 9: project documents, procurement reports

### Wave 3

- Wave 3 step 1: ledger core
- Wave 3 step 2: client RA bills
- Wave 3 step 3: receivables
- Wave 3 step 4: vendor bills and payables
- Wave 3 step 5: subcontract bills
- Wave 3 step 6a: GST
- Wave 3 step 6b: TDS deposited and returned
- Wave 3 step 7: bank and reconciliation
- Wave 3 step 8: statements, year end, Tally export, 3a exit check
- Wave 3 step 9: fixed assets
- Wave 3 step 10: equipment and fleet
- Wave 3 step 11: HR
- Wave 3 step 12: payroll
- Wave 3 step 13: labour contractors
- Wave 3 step 14: quality
- Wave 3 step 15: safety

### Wave 4

- Wave 4: record the answers taken at the start
- Wave 4 step 1: cost control
- Wave 4 step 2 (in progress): cash flow engine, service and screen
- Wave 4 step 2: cash flow
- Wave 4 step 3: earned value
- Wave 4 step 4: variations and change orders
- Wave 4 steps 5-7: contracts and claims, risk register, portfolio and MEP

### Wave 5

- Wave 5: record the answers taken at the start
- Wave 5: own review engine; drawn canvas signatures only, DSC step dropped
- Wave 5 step 1 (in progress): review workflows on the dms engine
- Wave 5 steps 1-2, step 3 API: reviews tested, mark-up, transmittals, RFIs, submittals
- Wave 5 step 3: transmittals screen, the recipient's link page, RFIs and submittals
- Wave 5 steps 4-5 and exit check: controlled revisions, drawn-signature sign-off

### Wave 6

- Wave 6 step 1: CRM
- Wave 6 step 2 (in progress): real estate sales and RERA
- Wave 6 step 2 tested: real estate sales and RERA; step 3 query builder
- Wave 6 steps 3 and 4: report builder, offline site forms, mobile shell
- Wave 6 step 5 (API): vendor, subcontractor and client portals
- Wave 6 step 5 (web): portal screens, staff screens, owner cap, tests
- Wave 6 step 6: public API, webhooks, Tally agent
- Wave 6 exit: exact nav locators in browser tests; wave table updated
- Wave 6 exit recorded: full check and 64/64 browser tests green

### Wave 7

- Wave 7 build plan with a progress list

### Wave 7a

- Wave 7a.1: leave opening balances, test criteria, payables tolerance screens
- Wave 7a.2: Parties with kind filters, Suppliers and Subcontractors in the menu, one RFQ list
- Wave 7a.3: company-wide registers
- Wave 7a.4: project workspace in the menu
- Wave 7a.5: New menu in the header
- Wave 7a.6: search everything
- Wave 7a.7: My work on Home
- Wave 7a.8: audit trail
- Wave 7a exit: full check passed; browser suite 71 of 72, the one failure a spec superseded by 7b's print links

### Wave 7b

- Wave 7b: letterhead and printable documents
- Wave 7b exit: full check passed; browser suite 73 of 73

### Wave 7c

- Wave 7c: close the loops; 7d.1-7d.2 meetings and correspondence

### Wave 7d

- Wave 7d.3-7d.9 (work in progress): registers, imprest, recurring, checklists, company dashboard
- Wave 7d.3-7d.9 tested: fixes from the first test run; 7c exit ticked
- Wave 7d exit: full check, browser suite, demo seed and crawl

### Wave 8

- Wave 8 plan (draft for review): gaps found by a department audit
- Wave 8 agreed, with its progress list; Wave 9 plan (interface and production readiness)
- Wave 8 exit: licence-notice test follows the shipped ECharts version (D-21); Wave 8 done

### Wave 8a

- Wave 8a.1: revenue on work done (Ind AS 115)
- Wave 8a.2: material at site and month-end accruals
- Wave 8a test: drop unused staff from the setup (lint)
- Wave 8a.3: free-issue material to subcontractors
- Wave 8a.4: budget check on purchase orders
- Wave 8a.5: debit notes proposed from store acceptance and order rates
- Wave 8a exit and 8b.2-8b.5 tested

### Wave 8b

- Wave 8b.1: GST reverse charge and Rule 37 input credit reversal
- Wave 8b.2-8b.5 (tests written, not yet run): GST TDS, TDS returns, MSME, 194-IA
- Wave 8b exit and 8c.3 tested

### Wave 8c

- Wave 8c.1: contract labour compliance as principal employer
- Wave 8c.2: a worker muster from the phone, placed and photographed
- Wave 8c.3 (tests written, not yet run): statutory challans, PT return, Form 16
- Wave 8c.4: payroll gaps: overtime, bonus, loans and tax declarations
- Wave 8c.5: approvals to the reporting manager, and stand-ins on leave

### Wave 8d

- Wave 8d: escalation indices, make-ready, handover and DLP, geotagged offline site entry, deviation statement
- Wave 8d exit: full check (604 API tests) and browser suite green

### Wave 8e

- Wave 8e.1-8e.3: vendor master, delivery follow-up, receipts and transfers as they happen
- Wave 8e.4: buying with history
- Wave 8e.5: scrap and tools
- Wave 8e exit: full check, build and browser suite green (79 passed)

### Wave 8f

- Wave 8f.1, 8f.2, 8g.1: booking life after sale, SOR tendering, staff two-factor
- Wave 8f exit green; 8g.2-8g.5 pass their integration tests

### Wave 8g

- Wave 8g.5: Marathi and Hindi for the stores screens (receipts, issues, transfers, counts)
- Wave 8g.5: Marathi and Hindi for the labour muster and my attendance and leave
- Wave 8g.5: Marathi and Hindi for the quality and safety screens
- Wave 8g.5: Marathi and Hindi for the daily report screens

### Fixes

- Debug pass after Wave 8: findings logged (docs/debug-log.md)
- Debug fixes D-4, D-5, D-12 (integration tests for D-5/D-12 pending)
- Debug: over-budget message names the amount; demo seeder gives budget reasons and records contractor PF/ESI challans
- Debug: upgrade echarts, csv-parse and exceljs's uuid; clock-independent backup test; debug log actions
- Debug D-20: FIFO stores test gets the 90-second limit of other provisioning tests

### Wave 9

- Wave 9: progress list written before building

### Wave 9a

- 9a.1/9a.2 foundation: token scale with AA contrast test, Dialog, confirmations, toasts, error dialog with request reference, empty state, tabs
- 9a.3 sign-in and sign-out: welcome with last sign-in time and place, signed-out notice, idle warning; outbox entries sent only under their author
- 9a.2 sweep (screens A–M, BOQ): confirmations, success toasts, dialogs, empty states; 9a.4 leaving: unsaved-changes warning in app and browser, desktop asks before closing
- 9a.2 sweep (accounts, payroll, HR, labour): confirmations before posting, reversing, closing and cancelling; success toasts; empty states
- 9a.2 sweep (control, sales, documents, CRM, quality, safety, portals, owner console): confirmations, toasts, empty states
- 9a.2 sweep (purchase, stores, tenders, projects, registers): confirmations, toasts, dialogs, empty states
- 9a.5 menus and bars: favourite and recent pages, status bar; per-person settings kept on the server; one product version
- 9a.6 charts: one theme from the design tokens, colour-blind-safe palette, full-figure tooltips, a table view and CSV of every chart, drill-down
- 9a.5 data grids: column choice, resize, reorder, freeze, density, sort, saved views and Excel export, remembered per person, on the main lists; legal links under the sign-in form
- 9a.7 process flows: where a document stands (requisition to payment, measurement to receipt, booking to possession) with links before and after

### Wave 9b

- 9b.3 legal pages: terms of service, privacy policy, terms and conditions, licence terms (drafts for a lawyer's review); accepted at first sign-in, versioned, append-only record of who accepted what; admin marks a version reviewed
- 9b.4 updates (server): signed release manifest checked daily against the release key; status open to the sign-in screen; publisher's keygen and signing tools
- 9b.4 updates (desktop): checks the signed release with its own key, downloads and verifies the installer, installs on restart; automatic or manual
- 9b.4 updates (app): new-release notice on the status bar and the sign-in screen, with release notes and restart-to-update in the desktop app
- 9b.1 settings: one Settings area (you, this device, company) with theme, date and amount formats, desktop and server updates, legal review and acceptances; links to the company's own settings screens
- 9b.5 hardening: readiness check with connection budget, configurable pool size, JSON logs with request references, security headers on API answers, HSTS and cross-origin policies, location allowed for site photos (D-23), dependency audit in CI, load-test script, restore drill
