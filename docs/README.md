# Aerolith Core: Construction ERP (SaaS + Self-hosted)

Planning is split into 10 phases. Each phase is a document; a phase is "locked" once its decisions are agreed.

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | MVP | [01-mvp.md](01-mvp.md) | **Locked (rev 3)** |
| 2 | Tech Stack | [02-tech-stack.md](02-tech-stack.md) | **Locked (rev 3)** |
| 3 | Architecture | [03-architecture.md](03-architecture.md) | **Locked (rev 3)** |
| 4 | Features / Modules | [04-features.md](04-features.md) | **Locked (rev 1)** |
| 5 | Database | [05-database.md](05-database.md) | **Locked (rev 1)** |
| 6 | Pricing | [06-pricing.md](06-pricing.md) | **Locked (rev 1)**, prices set at commercial release |
| 7 | Payments | [07-payments.md](07-payments.md) | **Locked (rev 1)** |
| 8 | Dashboard | [08-dashboard.md](08-dashboard.md) | **Locked (rev 1)** |
| 9 | Security | [09-security.md](09-security.md) | **Locked (rev 1)** |
| 10 | Deployment | [10-deployment.md](10-deployment.md) | **Locked (rev 1)** |

## Decisions locked (rev 3)

| Topic | Decision |
|-------|----------|
| Customer / market | Small/mid construction contractors, India (GST, TDS, RERA, INR) |
| Releases | **v1 = Waves 0-6**, **v2 = Wave 7** (AI, chat, productivity). Public deployment only after all 10 phases and v1 are done. |
| Waves | 0 Platform (incl. basic notifications/reminders/pending inbox); 1 Estimation + Bid/Tender + documents; 2 Execution (2a projects+scheduling, 2b procurement+inventory+DSR); 3 Operations (incl. finance); 4 Control; 5 Document signing/approval; 6 Growth; 7 v2 |
| Desktop | Electron, online-only |
| Data access | Typed SQL (Kysely) + hand SQL + COPY, partitioning, rollups, server-side row model |
| Scale target | 1M+ BOQ lines across multiple BOQs; 50+ pages micro/macro schedules; validated by Wave 0 benchmark |
| Tenancy | Database-per-tenant, plus BYO-DB and self-hosted modes |
| Login | Admin: email + password. Staff: username + password. Licence key unlocks features (entered once per device). |
| Password reset | Admin: email link. Staff: request to Tenant Admin, who issues a one-time temporary password. No email/mobile required for staff. |
| Key delivery | Automatic from the website's domain email after email verification; owner-side automation console |
| Payments | Regional gateway (Razorpay) |
| Licensing | Cloud entitlements; signed offline licence for self-hosted |
| AI / chat / productivity | v2; approach decided at the start of v2 |

| Accounting | Full double-entry GL + Tally export + optional Tally link (connector). Live bank transactions are tenant opt-in, OFF by default, not enabled until the app is complete and deployed |
| Tender programme | Standalone submission document, unlinked to projects, XER/MSPDI import-export |
| Takeoff | None in v1 (manual + Excel only) |
| Segments | Buildings, Interiors, Joineries, MEP, then others |
| Sole-admin recovery | Email reset link; support email with identity verification if email is lost |
| **Licensing** | **No paid tools; permissive licences only, CI-enforced. See [licensing-policy.md](licensing-policy.md)** |

| Existing infra | GoDaddy domain+mail, Vercel site, GitHub, GitHub Releases, Supabase (control plane only). See [infra-existing-stack.md](infra-existing-stack.md) |
| Payments | Razorpay as a per-transaction operating service behind an adapter (explained to owner; confirm in Phase 7) |
| .mpp | Best-effort via LGPL sidecar, MSPDI XML fallback |

| Tenant DB | Each tenant owns their own Supabase organisation + project (one-time OAuth consent at signup, then background provisioning). All tenant activity and files live there |
| Feature parity | Same screens and features for every tenant; roles limit permissions only. Tiers differ by seats, not modules |
| Entities | Multi-GSTIN entity/branch support for all tenants in v1 |
| Trial | 120 days, 3 named seats (Admin, Manager, Worker). Owner can extend/shorten with email + in-app notice |
| Seats | Named users; seat cap per tier, enforced server-side |
| Retention | Control plane kept 3-5 years. Tenant data not held by us. Owner-run backups deferred until commercial release |

| Pricing model | Seat tiers only; immediate seat reuse with an owner-console abuse report |

| Payments | Pvt Ltd, GST-registered; demo/test mode only until commercial; auto-renew with pre-debit notice and self-service cancel; no refunds by default (disputes still handled) |

| Dashboards | Fixed per role/module + per-user KPI picker from a catalog in v1; custom dashboards v2; telemetry opt-in |

| Security | MFA mandatory for all tenant admins and owner; idle timeout 30 min browser / 12 h desktop; single owner with break-glass codes |

| Deployment | Windows-only desktop, Windows code signing; API in Docker: owner's PC for local testing only, tenants served directly from a free VM (revised in step 7) |

**All 10 planning phases are locked.**

## Wave plans

Every wave has a written plan here **before its first step is built**; each step is re-read with you before it
starts, and what changed while building is recorded in the plan's "delivered" sections. Plans for later waves are
the least certain and are revised as earlier waves reach pilots.

| Wave | Plan | State |
|------|------|-------|
| 0 Platform | [01-mvp.md](01-mvp.md), [03-architecture.md](03-architecture.md) | Built |
| 1 Estimation, Bid/Tender, Documents | [wave1-plan.md](wave1-plan.md) | Built; pilot not yet |
| 2a Projects and scheduling | [wave2a-plan.md](wave2a-plan.md) | Built; pilot not yet |
| 2b Procurement, inventory, site reports | [wave2b-plan.md](wave2b-plan.md) | Steps 1-9 built; the exit criterion waits on a pilot site |
| 3 Operations and finance (3a Money, 3b People and equipment, 3c Quality and safety) | [wave3-plan.md](wave3-plan.md) | Built (steps 1-15); professional reviews open |
| 4 Control | [wave4-plan.md](wave4-plan.md) | Building: steps 1-4 done |
| 5 Document workflow | [wave5-plan.md](wave5-plan.md) | Planned |
| 6 Growth (completes v1) | [wave6-plan.md](wave6-plan.md) | Planned |
| 7 v2: AI, collaboration, productivity | [wave7-plan.md](wave7-plan.md) | Outline; rewritten at its start |

## Wave 0 build progress

| Step | What | Status |
|------|------|--------|
| 1 | Monorepo scaffold (pnpm + Turborepo, lint, format, typecheck, tests, licence gate, CI) | **Done** |
| 2 | Performance benchmark: 1M-line BOQ + 50k-activity schedule on local Postgres | **Done**: all 7 targets met ([results](benchmarks/wave0-benchmark.md)). Findings: 1M lines = ~784 MB (exceeds free Supabase); revisions must be copy-on-write |
| 3 | Control plane: `core` schema, licence keys, trial/seat rules, owner console API | **Done** ([API](control-plane-api.md)). Owner auth is an interim token until step 5 |
| 4 | Tenant onboarding: Supabase OAuth connect, provisioning, migration orchestrator | **Done** ([details](tenant-provisioning.md)). Supabase calls unverified until the owner registers the OAuth app |
| 5 | Auth: login, mandatory admin MFA, staff reset requests, roles | **Done** ([details](authentication.md)). Interim owner token removed |
| 6 | Electron + browser shells; notifications/reminders/pending inbox | **Done** ([details](app-shells.md)). Browser journey covered end to end; Windows installer built in CI (unsigned) |
| 6b | Email worker: SMTP delivery, retries, suppression, owner controls | **Done** ([details](email.md)). Check your GoDaddy mailbox type before December 2026 |
| 7 | Docker Compose stack for the owner PC with tunnel | **Done** ([details](deployment-docker.md)). Browser journey runs through the stack in CI; owner routes unreachable from the public port. Decision: tenants go straight to a VM |
| 8 | Owner console: tenants, licences, databases, email, migrations, audit | **Done** ([details](owner-console.md)). Served only on the loopback owner port; break-glass reset by server command |

## Wave 1 build progress ([plan](wave1-plan.md))

| Step | What | Status |
|------|------|--------|
| 1 | Tender register: clients, numbering, pipeline, bid/no-bid scoring, reminders | **Done** |
| 2 | BOQ engine (API): windows, collapsed sections, batched edits, totals by delta | **Done** |
| 3 | BOQ grid: keyboard editing, formulas, paste from Excel, fold, outline, search, sliding window | **Done** |
| 4 | Import/export: units, Excel/CSV import wizard with dry run, Excel/CSV export | **Done** |
| 5 | Rate library + rate analysis: resources with dated rates, price books, analyses, BOQ rates from analyses | **Done** |
| 6 | Measurement sheets; bid pricing: scenarios, markups, GST, % against estimate, quoted rates, bid summary | **Done** |
| 7 | Revisions: copy-on-write versions, freeze on submission, compare, version export, archiving | **Done** |
| 8 | Tender management detail: pre-bid queries, addenda (with revised-BOQ import), EMD/BG, checklist, win/loss | **Done** |
| 9 | RFQs: enquiry packs to vendors, quotes, comparative statement, price into the estimate | **Done** |
| 10 | Tender documents: storage, per-tender vault, folders, versions, search, preview | **Done** (Supabase Storage not built) |
| 11 | Tender programme: CPM engine, Gantt, calendars, PDF, MSPDI/XER | **Done** (MS Project/P6 files not yet tried with a real contractor's file) |
| 12 | Reports + dashboard: cost summary, priced/unpriced BOQ, rate analysis, bid pipeline; PDF/Excel | **Done** |
| 13 | The rest of Wave 1: notices/SBOM, item kinds, templates, bulk edit, currencies, company tender settings, RFQ rounds, document lifecycle, PDF search, thumbnails, jumping anywhere in a huge BOQ | **Done** (Supabase Storage and anything Cloudflare excluded; no .mpp or OCR, by decision) |

Wave 1's exit criterion, a pilot contractor pricing and submitting a real tender on it, is **not met yet**.

## Wave 2a build progress ([plan](wave2a-plan.md))

| Step | What | Status |
|------|------|--------|
| 1 | Projects: register, from a won tender, sites, team, project-scoped visibility, status | **Done** |
| 2 | Contract BOQ and budget from the won tender | **Done** |
| 3 | WBS and cost codes; BOQ items mapped to them | **Done** |
| 4 | Project schedules: baselines, progress as of a data date, resources, look-ahead; 50k activities | **Done** |
| 5 | Macro plans: schedules rolled up through the WBS, by package, trade and zone; milestones | **Done** |
| 6 | Progress measurement: measurement books, progress report, activities' physical progress | **Done** |
| 7 | Project dashboard: money, progress three ways, S-curve, look-ahead; progress report in Excel | **Done** |

Wave 2a's exit criterion, a won tender running as a live project on a baseline schedule, needs the pilot as well:
nothing here has run on a real project yet.

## Wave 2b build progress ([plan](wave2b-plan.md))

| Step | What | Status |
|------|------|--------|
| 1 | Approvals (rules by amount, levels, stand-ins) and purchase requisitions | **Done** |
| 2 | Material budget from the tender's rate analyses, revised under approval; requisitions against it, from BOQ items and the look-ahead | **Done** |
| 3 | Vendor enquiries for a project, from approved requisitions | **Done** |
| 4 | Purchase and work orders: GST on top (CGST + SGST or IGST from the site and the supplier's GSTIN), approvals, amendments, acknowledgement; made from an enquiry's chosen vendors | **Done** |
| 5 | Goods receipt: partial receipts, rejections at the gate, quality hold and inspection, returns to the supplier; the order closes when all has come | **Done** |
| 6 | Inventory: stores, stock ledger (weighted average or FIFO), issues to WBS, returns, transfers, stock take under approval, reorder levels, consumption | **Done** |
| 7 | Daily site reports: phone first, saved as you go through a dropped signal, photos, the day's receipts and issues, acknowledged by the lead, corrections with a reason, weekly figures | **Done** |
| 8 | Project documents: the project's own vault kept to its team, the drawings register (each revision a version, the last superseded), receipt challans, quote documents on a project's enquiry | **Done** |
| 9 | Procurement reports: requisition to order to receipt, open orders, material reconciliation with wastage against the norms, supplier performance; each as Excel | **Done** |


## Wave 3 build progress ([plan](wave3-plan.md))

Built on the plan's recommended answers (full double-entry books, a generic RA bill format, payroll in-house,
Joineries later). **Nothing in 3a is to be relied on for filing until a chartered accountant has reviewed it.**

| Step | What | Status |
|------|------|--------|
| 1 | Ledger core: companies, one chart of accounts, the account map, vouchers that always balance (the database refuses anything else), reversals, locked months, opening balances from Excel, day book, ledger, trial balance | **Done** |
| 2 | Client RA bills: contract terms (GST, retention to a cap, the mobilisation advance and its recovery, CPWD-style escalation); bills from the measurement book less the last certified bill; submitted under the approval rules; certified for less; a tax invoice posted on certification | **Done** |
| 3 | Receivables: client receipts with TDS and deductions, allocated to certified bills, retention released and advances; cancelled by reversal; ageing as at a date | **Done** |
| 4 | Payables: suppliers' bills matched to orders and receipts (held, passed), TDS by section with catch-up, debit notes; payment runs under approval with a bank file; advances | **Done** |
| 5 | Subcontract bills: a work order's measurement book (entries reversed, never changed); RA bills with retention to a cap, advance recovery, back-charges, labour cess and TDS; certified under approval into payables; retention released | **Done** |
| 6a | GST: credit notes to clients; outward and inward registers; GSTR-1 for the offline tool and GSTR-3B; e-invoice JSON and IRNs; input tax blocked by ledger; GSTR-2B matched against the purchase book | **Done** |
| 6b | TDS: challans depositing each deduction once, 26Q data for the return utility, clients' TDS matched against 26AS | **Done** |
| 7 | Bank: statements imported (mapped CSV or Excel, OFX, MT940) once; lines matched to vouchers (suggested, picked, or posted in one click); the reconciliation as at a date | **Done** |
| 8 | Statements (Schedule III P&L and balance sheet, cash flow), project P&L, year end with closing stock; Tally XML export and the accounts mode; the 3a exit check | **Done** |
| 9 | Fixed assets: register from bills or opening balances, transfers, depreciation runs (Companies Act, by project), Income Tax blocks, disposals with gain or loss | **Done** |
| 10 | Equipment: register (own or hired), allocation, log sheets (in the daily report), fuel against the norm, maintenance, the month costed (own charged to projects, hire bills from the logs) | **Done** |
| 11 | HR: employees (DPDP Aadhaar rule, masked PAN and bank), designations that add permissions and approve, calendars, deployment, attendance (register, biometric file, phone with location), leave (types, balances, applications through approvals, carry forward), the month's payable days | **Done** |
| 12a | Payroll: compliance rules with effective dates, pay components, salaries, the monthly run (PF, ESI, PT, LWF, TDS), approval, posting by project, the bank file, payslips | **Done** |
| 12b | Payroll: PF ECR, ESI data, Form 16 (Form 130) data, full and final (gratuity, encashment, notice), the 3b exit check | **Done** (practitioner review open) |
| 13 | Labour contractors: licences, workers, minimum wages as data, the daily muster (in the daily report), wage sheets checked against the minimum wage and verified as paid, CLRA registers, BOCW cess | **Done** |
| 14 | Quality: inspection requests (holding uninspected work from bills), checklists with photos, tests against criteria held as data, NCRs closed by someone else, snags, material approvals an order needs | **Done** |
| 15 | Safety: incidents investigated to closure, permits to work issued only with their precautions and never to oneself, toolbox talks, safety inspections, man-hours from attendance and musters, frequency and severity rates; the 3c exit check | **Done** |

**Wave 3 is complete.** Professional reviews still open: a chartered accountant (3a), a payroll practitioner (statutory figures), a quality engineer (acceptance criteria) and a safety officer (IS 3786 rates, permit precautions).

## Wave 4 build progress ([plan](wave4-plan.md))

Built on the recommended answers: cost to complete entered by planning (computed when blank), the forecast by the CPI
method, variations billed once the client approves.

| Step | What | Status |
|------|------|--------|
| 1 | Cost control: budget (original, changes, current), committed on orders, actual from the ledger, cost to complete, forecast and variance by cost code and WBS element; costs placed by rules (allocation, the voucher's cost code, the requisition behind an order, company defaults) with the rest shown as not placed; month closes compared; alerts; Excel | **Done** |
| 2 | Cash flow: per project and for the company, by month or week, actual back (receipts, payments, payroll, wages; the bank) and forecast ahead from cash terms (certification and payment delays, client TDS, supplier and cost days): bills owed, work done and to come, supplier bills, open orders, cost not yet ordered, overheads, GST to the government | **Done** |
| 3 | Earned value: PV from the baseline at budget value, EV from the measurement book at budget rates, AC from the ledger; SV, CV, SPI, CPI; four estimates at completion side by side and the one the project uses; by WBS element; S-curves | **Done** |
| 4 | Variations: new items (priced from rate analyses with the project's markup) and changed quantities; approved inside and by the client (for less); carried into the contract BOQ (a new revision if frozen) and its budget, keyed together, and the schedule; billing while pending where the contract allows; the register with work executed but not approved | **Done** |
| 5 | Contracts and claims | Next |
