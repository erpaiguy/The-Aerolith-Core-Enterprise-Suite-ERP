# Phase 1: MVP

## Scope tension (read first)

The target is the full construction suite. The team is tiny. Both are true only if the *architecture* covers every
module and the *build* ships modules in waves. Anything else produces a half-finished suite nobody can sell.

**Rule:** the platform (Wave 0) and tenancy are built once and correctly. Modules ship in waves. A wave is
sellable on its own.

## What "MVP" means here

The first version a paying Indian contractor can run a real project on, end to end:
**plan the project, budget it, buy materials, pay subcontractors, bill the client, see profit.**

## Waves

| Wave | Contents | Exit criteria |
|------|----------|---------------|
| 0. Platform | Control plane, tenant provisioning, auth/RBAC, licensing, billing hooks, audit log, file storage, desktop shell | Create a tenant, get its own database, log in from browser and desktop |
| 1. Core (MVP) | Projects, BOQ/estimating, procurement (PR/PO/GRN), inventory, subcontractor + vendor bills, client RA billing, accounts-lite with GST, daily site reports, documents | One real project run end to end by a pilot customer |
| 2. Operations | Equipment/fleet, HR + attendance + payroll (PF/ESI/PT), labour contractors, quality (QA/QC, snag), safety (HSE) | Site-to-payroll loop closed |
| 3. Control | Scheduling (Gantt/CPM), cost control and forecasting, change orders/variations, contracts and tenders, approvals engine v2 | Planned vs actual per project |
| 4. Growth | CRM and lead pipeline (developers), real estate sales/RERA, BI/report builder, mobile site app, integrations (Tally export, e-way bill, e-invoice) | Self-serve analytics |

## MVP user stories (Wave 1)

1. As an owner I create a project with a budget and see committed cost vs budget.
2. As an estimator I build a BOQ from a rate library and revise it.
3. As a site engineer I raise a purchase request and log a GRN against a PO.
4. As accounts I record a subcontractor bill with retention, TDS and GST, and approve it.
5. As accounts I raise a client RA bill and generate a GST invoice.
6. As a PM I submit a daily progress report with photos.
7. As an owner I see project P&L and cash position on one dashboard.

## Non-goals for the MVP

Offline-first sync, native mobile apps, payroll statutory filings, scheduling engine, multi-country tax.

## Success metrics

- Pilot customer runs a live project on it for 60 days.
- Tenant provisioning under 2 minutes (shared cluster) and under 15 minutes (BYO-DB).
- Zero cross-tenant data access in the isolation test suite.
