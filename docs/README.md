# Aerolith Core: Construction ERP (SaaS + Self-hosted)

Planning is split into 10 phases. Each phase is a document; a phase is "locked" once its decisions are agreed.

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | MVP | [01-mvp.md](01-mvp.md) | **Locked (rev 3)** |
| 2 | Tech Stack | [02-tech-stack.md](02-tech-stack.md) | **Locked (rev 3)** |
| 3 | Architecture | [03-architecture.md](03-architecture.md) | **Locked (rev 3)** |
| 4 | Features / Modules | _next_ | Not started |
| 5 | Database | _pending_ | Not started |
| 6 | Pricing | _pending_ | Not started |
| 7 | Payments | _pending_ | Not started |
| 8 | Dashboard | _pending_ | Not started |
| 9 | Security | _pending_ | Not started |
| 10 | Deployment | _pending_ | Not started |

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

## Next: Phase 4 (Features / modules)
