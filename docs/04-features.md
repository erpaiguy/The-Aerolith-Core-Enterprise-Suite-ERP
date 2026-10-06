# Phase 4: Features and Modules (draft v0)

Legend: **W#** = wave. **Dep** = must exist first. All modules obey [licensing-policy.md](licensing-policy.md).
Segments in priority order: **1 Buildings, 2 Interiors, 3 Joineries, 4 MEP, 5 Others** (see §V).

## P. Cross-cutting platform (W0)

| ID | Module | Key features |
|----|--------|--------------|
| P1 | Tenant and organisation | Company profile, multiple legal entities/branches, financial year, currency (INR first), GSTIN/PAN per entity |
| P2 | Users, roles, permissions | Admin-created staff (username + password), custom roles, project scope, seat limits, admin-issued reset (03 §6) |
| P3 | Licence and entitlements | Key activation per device, feature gating, grace/read-only, device management (03 §10) |
| P4 | Audit log | Immutable record of who/what/when per entity, login events, exports |
| P5 | Approval engine (basic) | Multi-level, role/amount-based rules, delegate, comments. Extended in W5 |
| P6 | Notifications, reminders, pending inbox (basic) | In-app + email, due-date reminders, "waiting on me" list. Chat and richer productivity are v2 |
| P7 | Numbering series | Per document type, per entity, per FY, gap-controlled |
| P8 | Attachments and files | Storage adapter, virus-scan hook, size limits, thumbnails |
| P9 | Import/export framework | Excel/CSV mapping, validation, dry-run, chunked streaming, error report. Used by every module |
| P10 | Master data | Units, tax codes, HSN/SAC, currencies, cost codes, locations, party master (clients, vendors, subcontractors, labour contractors) |
| P11 | Custom fields, tags, saved filters (basic) | Per entity, tenant-defined |
| P12 | Search | Global, trigram + full-text |
| P13 | Tenant data export and backup/restore | Full tenant export, one-tenant restore |
| P14 | Owner console (our side) | Tenants, licences, key-delivery automation, trial rules, health (03 §10) |

## W1 Estimation, Bid/Tender, Documents (core MVP)

| ID | Module | Key features | Dep |
|----|--------|--------------|-----|
| E1 | Rate library | Own item/resource masters (material, labour, equipment, subcontract), rate versions with effective dates, tenant imports its own price books. **No bundled third-party SORs** | P9, P10 |
| E2 | Rate analysis | Build item rate from resources x productivity + wastage + overheads + profit, reusable analyses, rollup to BOQ rate | E1 |
| E3 | BOQ / Estimate | Multiple BOQs per tender, unlimited hierarchy, **1M+ lines**, bill/section/item, per-vertical templates, Excel import/export, bulk edit, formulas, notes, alternates/options, provisional sums | E1, E2, P9 |
| E4 | Measurement sheets (manual) | Dimension rows (nos x L x B x H), quantity from sheet to BOQ, Excel import. **No drawing takeoff in v1** | E3 |
| E5 | Pricing and markups | Overhead/profit/contingency/escalation/GST, scenario pricing, bid summary, price-vs-budget | E3 |
| E6 | Revisions | Versions, compare two versions (added/removed/changed, value delta), lock on submission | E3 |
| E7 | Tender management | Tender register, intake, bid/no-bid scoring, calendar, pre-bid queries, addenda, EMD/bank guarantee tracking, submission checklist, status pipeline, win/loss, competitor bids | P5, P6 |
| E8 | Vendor/subcontractor enquiry (RFQ) | Send enquiry packs, collect quotes, comparative statement, price into estimate | P10, E3 |
| E9 | **Tender programme** | Standalone submission programme: activities, links, durations, calendars, milestones, bar chart, critical path, **print/PDF**, import/export (§X). **Not linked to any live project, not used by other modules** (see below) | W0 scheduling engine |
| E10 | Tender documents (dedicated) | Per-tender vault, folder templates, version history, tags, permissions, search, bulk upload/download, preview, retention. No signing/approval workflow (W5) | P8 |
| E11 | Reports and exports | Cost summary, BOQ priced/unpriced, rate analysis report, bid pipeline, PDF/Excel | all E |

**Tender programme decision (yours):** it is a *submission document* only. Winning a tender does not convert it into a project
schedule. The project's baseline programme is created in W2a from scratch, or the user explicitly *imports a file* using the normal import path.
There is no live link and no shared data. [Likely] This is simpler and avoids the usual bug class where a bid-time programme
silently drives execution.
**Consequence to accept:** W1 now needs the Gantt canvas and CPM engine, which I had in W2. Build them as a shared
engine in W1 and reuse in W2a. W1 grows.

## W2a Projects and Scheduling

| ID | Module | Key features | Dep |
|----|--------|--------------|-----|
| J1 | Projects | Project master, entities, sites, team, project-scoped permissions, **create from a won tender (copies the priced BOQ as the contract BOQ, not the programme)** | E3, E7 |
| J2 | Contract BOQ and budget | Contract BOQ (baseline), internal budget (cost BOQ), versions, 1M+ lines | J1 |
| J3 | WBS / cost codes | WBS tree, mapping BOQ items to WBS and cost codes | J2 |
| J4 | Scheduling: micro plans | Activities, relationships (FS/SS/FF/SF, lag), calendars, constraints, resources, CPM, baselines (multiple), progress update, look-ahead, 50k+ activities | J3, shared engine |
| J5 | Scheduling: macro plans | Roll-up of micro plans via WBS, milestones, summary views, per-package/trade/zone views | J4 |
| J6 | Progress measurement | Physical % per BOQ item/activity, measurement-based progress | J2, J4 |

## W2b Procurement, Inventory, Site Reports

| ID | Module | Key features | Dep |
|----|--------|--------------|-----|
| R1 | Purchase requisition | From BOQ/schedule demand, approvals | J2, P5 |
| R2 | Vendor RFQ and comparative | Reuses E8 per project | E8 |
| R3 | Purchase orders / work orders | Terms, taxes, amendments, approvals, supplier acknowledgement | R1 |
| R4 | Goods receipt (GRN) and inspection | Partial receipts, quality hold, returns | R3 |
| R5 | Inventory | Stores, bins, issues to site/WBS, transfers, returns, stock ledger, valuation (FIFO/weighted avg), reorder levels, stock take | R4 |
| R6 | Daily site reports (DSR) | Manpower, equipment, materials, weather, work done, delays, safety remarks, photos, issues. **Mobile-responsive PWA** | J1 |
| R7 | Project documents | Project vault, drawings register, revisions | E10 |

## W3 Operations and Finance

| ID | Module | Key features | Dep |
|----|--------|--------------|-----|
| F1 | General ledger (full double entry) | Chart of accounts, journals, cost centres (project/site), multi-entity, period close, trial balance, P&L, balance sheet, cash flow | P1 |
| F2 | Payables | Vendor/subcontractor bills, 3-way match, retention, advances, TDS, payment runs | R4, F1 |
| F3 | Receivables and client billing | **RA bills with measurement**, escalation, retention, advances/mobilisation, deductions, price variation, GST invoices | J6, F1 |
| F4 | Subcontract management | Work orders, measurement, bills, back-charges, retention release | R3, F2 |
| F5 | GST and TDS | GST invoices, credit/debit notes, GSTR-ready data, e-invoice and e-way bill file generation (portal upload by tenant), TDS sections, 26Q/Form data | F1 |
| F6 | Bank and reconciliation | Statement import, matching, reconciliation. **Live bank = tenant opt-in, off by default** (03 §14) | F1 |
| F7 | Tally export and link | Export vouchers/masters; optional link via connector; accounts mode (a)/(b)/(c) (03 §14) | F1 |
| F8 | Fixed assets | Register, depreciation (Companies Act and Income Tax), disposal | F1 |
| F9 | Equipment and fleet | Register, allocation, hours, maintenance, fuel, own vs hired, costing to project | J1 |
| F10 | HR and payroll | Employees, attendance, leave, site deployment, payroll, PF/ESI/PT/TDS on salary, payslips, F&F | P2 |
| F11 | Labour contractors | Muster, wage sheets, labour compliance records, BOCW/CLRA-type registers (verify exact rules per state in Phase 5/9) | F10 |
| F12 | Quality | Inspection requests, checklists, test records, NCR, snag lists, material approvals | R4 |
| F13 | Safety (HSE) | Incidents, permits to work, toolbox talks, inspections, statistics | J1 |

## W4 Control

| ID | Module | Key features |
|----|--------|--------------|
| C1 | Cost control | Budget vs committed vs actual, cost-to-complete, cash flow |
| C2 | Forecasting and earned value | EV/PV/AC, SPI/CPI, forecast at completion |
| C3 | Variations and change orders | Requests, pricing, approvals, impact on contract BOQ/schedule |
| C4 | Contracts and claims | Contract register, obligations calendar, claims, EOT, notices |
| C5 | Risk register | Probability/impact, mitigation, link to cost and schedule |
| C6 | Project dashboards | Planned vs actual vs forecast (detailed in Phase 8) |

## W5 Document workflow

| ID | Module | Key features |
|----|--------|--------------|
| D1 | Document approval | Multi-stage review/approve, status codes, comments, deadlines. Extends P5 |
| D2 | E-signature | Draw/typed signature for internal sign-off; **PAdES digital signatures using the signer's own certificate/DSC** with free libraries; audit certificate. Aadhaar eSign is a paid per-use service and is **not** in the free baseline |
| D3 | Transmittals, RFIs, submittals | Controlled issue, acknowledgement tracking, response deadlines |
| D4 | Controlled revisions | Drawing/document revision control, superseded marking |

## W6 Growth

| ID | Module | Key features |
|----|--------|--------------|
| G1 | CRM | Leads, opportunities, client contacts, interactions (feeds tender intake) |
| G2 | Real estate sales and RERA | Units, booking, payment plans, demand letters, RERA project accounts |
| G3 | BI and report builder | Self-serve reports and charts, scheduled exports |
| G4 | Mobile app | Native wrapper/offline-tolerant forms for site (offline sync was a non-goal for v1; revisit here) |
| G5 | Portals | Subcontractor/vendor/client portals (quotes, bills, progress) |
| G6 | Integrations | Public REST API, webhooks, e-invoice/e-way helpers |

## W7 (v2)
AI, chat, to-dos, calendar, personal dashboards, productivity options (01-mvp.md).

## V. Vertical packs (segments, in your priority order)

A pack is **templates + measurement conventions + rate-library structure + schedule templates + reports**, mostly configuration. Packs 1 to 3 add one or more real modules.

| Order | Pack | What it adds |
|-------|------|--------------|
| 1 | **Buildings** | Civil/structural/finishes BOQ templates, bill structures, building WBS, typical programme templates, floor/zone breakdown |
| 2 | **Interiors** | Room-wise and package-wise BOQ, finishes and material schedules, sample/mock-up approvals, design-change log, snagging |
| 3 | **Joineries** | Door/window/furniture schedules, bill of materials and cutting lists, workshop/production tracking (job cards, stages, delivery to site). **Needs a Production module** |
| 4 | **MEP** | System-wise BOQ (HVAC, electrical, plumbing, fire, ELV), equipment schedules, coordination/clash log, testing and commissioning records |
| 5 | **Others** | Roads/infrastructure (chainage-based quantities), industrial, etc. |

**Placement proposal (confirm or change):** Buildings pack ships with W1/W2. Interiors with W2/W3. Joineries pack plus
the Production module with W3. MEP in W4. Others after v1 or as demanded. Every wave's features must work for Buildings
first.

## X. Import/export formats (decided)

| Format | Import | Export | Notes |
|--------|--------|--------|-------|
| Excel/CSV | Yes | Yes | All modules (P9) |
| MS Project XML (MSPDI) | Yes | Yes | Documented, public XML schema. Our own parser. |
| Primavera P6 XER | Yes | Yes | Implemented from public structure and behaviour, validated against sample files from tenants. [Likely] Round-trip fidelity of calendars and resource data is the hard part. |
| MS Project .mpp (binary) | Best-effort via an LGPL-licensed reader run as a separate process, or ask users to save as MSPDI XML | No (export MSPDI) | Proprietary binary. Decide in Phase 10 whether the sidecar is worth its weight. |
| Tally XML | n/a | Yes | See 03 §14 |
| PDF | n/a | Yes | Reports, programmes, invoices |

## Cross-module flows (the spine)

```
Tender (E7) -> BOQ/Estimate (E3) -> [WON] -> Project (J1) -> Contract BOQ (J2) -> WBS (J3)
                                                                       |             \
Tender programme (E9): stays a document, NO link          Schedule (J4/J5)       Procurement (R1-R4) -> Inventory (R5)
                                                                       |             |                 |
                                                          Progress (J6) -> Client RA bill (F3)   Vendor bill (F2) -> GL (F1)
                                                                                        |
                                                          Cost control (C1) <- committed + actual
```

## Risks I'm flagging

1. [Certain] W1 is bigger than "estimation and tenders": 1M-row grid, rate analysis, canvas Gantt + CPM engine for the tender programme, XER/MSPDI import-export, and a document vault. Re-plan after the Wave 0 benchmark.
2. [Likely] Full double-entry GL with GST/TDS is a product of its own. Budget it like one and get a practising accountant to review.
3. [Likely] The Joineries Production module is a manufacturing system. It is bigger than it looks, so scope it separately in Phase 5.
4. [Guessing] Payroll and labour compliance rules differ by state and change often. Needs a compliance-rules data layer, not hardcoded logic.
