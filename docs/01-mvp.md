# Phase 1: MVP and Wave Plan (rev 2)

## Strategy

The **platform (Wave 0)** is built once. Product ships in **7 waves**. Each wave is sellable on its own.
Wave 1 is an **Estimation and Tender/Bid Management** product, which is the entry point (pre-construction), before
any project execution exists.

## Waves

| Wave | Theme | Contents | Exit criteria |
|------|-------|----------|---------------|
| 0 | Platform | Control plane, tenant provisioning, licence service, auth (see 03 §6), RBAC, audit log, file storage, **generic approval engine (basic)**, numbering series, Electron shell, **performance spike (see 03 §13)** | Tenant created, licensed, logged in from browser and Electron; 1M-row BOQ benchmark passes |
| 1 | **Core MVP: Estimation + Bid/Tender** | See below | A pilot contractor prices and submits a real tender |
| 2 | Execution | Projects, scheduling (macro/micro plans), procurement, inventory, daily site reports, project documents | Won tender converts to a live project with baseline schedule |
| 3 | Operations | Client RA billing, subcontractor/vendor bills, accounts-lite (GST/TDS), equipment, HR/payroll, labour contractors, quality, safety | Money flows end to end |
| 4 | Control | Cost control and forecasting, earned value, variations/change orders, contracts and claims | Planned vs actual vs forecast per project |
| 5 | Document workflow | E-signature, document approval workflows, transmittals, controlled issue | Signed and approved documents end to end |
| 6 | Growth | CRM, real-estate sales/RERA, BI/report builder, mobile app, integrations (Tally, e-invoice, e-way bill) | Self-serve analytics |
| 7 | AI | Company-owned AI inside the ERP (see "AI" below) | Features in "AI" below, measured |

## Wave 1 scope (Core MVP)

**Estimation**
- Multiple BOQs per tender/project, unlimited levels (sections, sub-sections, items), **target 1M+ lines across BOQs**
- Rate library and rate analysis (material, labour, equipment, subcontract, overhead, profit)
- Quantity takeoff entries linked to BOQ items; measurement sheets
- BOQ import/export (Excel/CSV) at bulk scale; templates
- Revisions, versions, compare two versions, scenario pricing
- Markups, escalation, contingency, GST, currency
- Cost breakdown and summary reports (PDF/Excel)

**Bid / Tender management**
- Tender register, lead intake, bid/no-bid decision with scoring
- Tender calendar, pre-bid meeting, queries and clarifications, addenda tracking
- EMD/bid security, bank guarantees, document checklist, submission tracker
- Subcontractor/supplier RFQs and quote comparison (comparative statement)
- Competitor bids, win/loss analysis, bid pipeline dashboard

**Dedicated documents (basic)**
- Per-tender document vault, folders, versioning, tags, search, permissions, templates
- Preview, bulk upload/download, retention rules
- Not in Wave 1: e-signature and approval workflow (Wave 5)

## Scope risks I'm flagging

1. [Likely] **Wave 1 has no accounting, so it earns less per tenant.** An estimation-only product competes with Excel and
   existing tools. Pricing and the pilot customer must be validated before Wave 2 is funded.
2. [Certain] **Wave 2 is too big for one release.** Split it: **2a** projects + scheduling, **2b** procurement + inventory +
   daily site reports. Documents already exist from Wave 1.
3. [Certain] **Procurement approvals (Wave 2) need an approval engine, but document approvals are Wave 5.** Resolved by
   building a basic generic approval engine in Wave 0 and extending it in Wave 5.
4. [Certain] **The finance modules had no wave.** I placed billing, bills, accounts, equipment, HR and quality in Wave 3.
   Correct me if you want them elsewhere.
5. [Likely] Site staff need to submit daily reports in Wave 2 before the mobile app exists in Wave 6. Wave 2 ships a
   mobile-responsive web UI (PWA) for site forms.

## AI (Wave 7), your own AI

[Certain] Training a general-purpose language model from scratch costs millions of dollars and large GPU clusters.
That is not feasible here. What is feasible and still "yours":

- **Classical ML on your own data:** rate prediction, cost estimating from past BOQs, delay-risk scoring, anomaly
  detection on bills. Trained on tenant-approved data.
- **Self-hosted open-weight models** (fine-tuned and run on your own servers, branded as your AI), for BOQ item
  matching, tender-document extraction, and search. No third-party API calls, so tenant data never leaves your servers or theirs.
- **Decision deferred to Wave 7.** Platform commitments now: store clean structured history, keep tenant data
  exportable for training only with opt-in consent, and keep a model-serving interface behind a feature flag.

If "own AI" means "no open-weight models either", say so, and I'll scope it as classical ML only.

## Non-goals (until stated otherwise)

Offline-first sync, native mobile before Wave 6, multi-country tax, payroll statutory filing before Wave 3.

## Success metrics

- Pilot runs a live tender on it end to end.
- 1M-line BOQ: scroll, filter, and edit stay interactive (targets in 03 §13).
- Tenant provisioning under 2 min (shared cluster) and 15 min (BYO-DB).
- Zero cross-tenant data access in the isolation test suite.
