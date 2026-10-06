# Aerolith Core: Construction ERP (SaaS + Self-hosted)

Planning is split into 10 phases. Each phase is a document; a phase is "locked" once its decisions are agreed.

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | MVP | [01-mvp.md](01-mvp.md) | Draft v0 |
| 2 | Tech Stack | [02-tech-stack.md](02-tech-stack.md) | Draft v0 |
| 3 | Architecture | [03-architecture.md](03-architecture.md) | Draft v0 |
| 4 | Features / Modules | _next_ | Not started |
| 5 | Database | _pending_ | Not started |
| 6 | Pricing | _pending_ | Not started |
| 7 | Payments | _pending_ | Not started |
| 8 | Dashboard | _pending_ | Not started |
| 9 | Security | _pending_ | Not started |
| 10 | Deployment | _pending_ | Not started |

## Decisions locked from the discovery round

| Topic | Decision |
|-------|----------|
| Customer | Small/mid construction contractors, single country |
| Launch market | India (GST, TDS, RERA, RA bills, INR) |
| Desktop app | Online-only desktop shell (Tauri) around the web app. Offline sync is out of scope. |
| Tenancy | Database-per-tenant for every tenant, plus BYO-DB and fully self-hosted modes |
| Stack | TypeScript end to end |
| Payments | Regional gateway (Razorpay) |
| Licensing | Cloud entitlements by default, signed offline license for self-hosted tenants |
| Scope | Full module suite is the target, delivered in waves (see 01-mvp.md) |
