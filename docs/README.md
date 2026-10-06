# Aerolith Core: Construction ERP (SaaS + Self-hosted)

Planning is split into 10 phases. Each phase is a document; a phase is "locked" once its decisions are agreed.

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | MVP | [01-mvp.md](01-mvp.md) | Draft v1 |
| 2 | Tech Stack | [02-tech-stack.md](02-tech-stack.md) | Draft v1 |
| 3 | Architecture | [03-architecture.md](03-architecture.md) | Draft v1 |
| 4 | Features / Modules | _next_ | Not started |
| 5 | Database | _pending_ | Not started |
| 6 | Pricing | _pending_ | Not started |
| 7 | Payments | _pending_ | Not started |
| 8 | Dashboard | _pending_ | Not started |
| 9 | Security | _pending_ | Not started |
| 10 | Deployment | _pending_ | Not started |

## Decisions locked (rev 2)

| Topic | Decision |
|-------|----------|
| Customer / market | Small/mid construction contractors, India (GST, TDS, RERA, INR) |
| Waves | 0 Platform; 1 Estimation + Bid/Tender + documents; 2 Execution (projects, scheduling, procurement, inventory, DSR); 3 Operations; 4 Control; 5 Document signing/approval; 6 Growth; 7 Own AI |
| Desktop | Electron, online-only |
| Data access | Typed SQL (Kysely) + hand SQL + COPY, partitioning, rollups, server-side row model |
| Scale target | 1M+ BOQ lines across multiple BOQs; 50+ pages micro/macro schedules; validated by Wave 0 benchmark |
| Tenancy | Database-per-tenant, plus BYO-DB and self-hosted modes |
| Identity | Admin: email + password + licence key. Staff: username + password. Forgot/change password for all. |
| Payments | Regional gateway (Razorpay) |
| Licensing | Cloud entitlements; signed offline licence for self-hosted |
| AI | Own AI in Wave 7: classical ML + self-hosted open-weight models (pending your confirmation) |
