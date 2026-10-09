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
| 10 | Tender documents: storage, per-tender vault, folders, versions, search, preview | Next |
