# Aerolith Core: Construction ERP (SaaS + Self-hosted)

Planning is split into 10 phases. Each phase is a document; a phase is "locked" once its decisions are agreed.

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | MVP | [01-mvp.md](01-mvp.md) | **Locked (rev 3)** |
| 2 | Tech Stack | [02-tech-stack.md](02-tech-stack.md) | **Locked (rev 3)** |
| 3 | Architecture | [03-architecture.md](03-architecture.md) | **Locked (rev 3)** |
| 4 | Features / Modules | [04-features.md](04-features.md) | **Locked (rev 1)** |
| 5 | Database | [05-database.md](05-database.md) | Draft v0 |
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

| Accounting | Full double-entry GL + Tally export + optional Tally link (connector). Live bank transactions are tenant opt-in, OFF by default, not enabled until the app is complete and deployed |
| Tender programme | Standalone submission document, unlinked to projects, XER/MSPDI import-export |
| Takeoff | None in v1 (manual + Excel only) |
| Segments | Buildings, Interiors, Joineries, MEP, then others |
| Sole-admin recovery | Email reset link; support email with identity verification if email is lost |
| **Licensing** | **No paid tools; permissive licences only, CI-enforced. See [licensing-policy.md](licensing-policy.md)** |

| Existing infra | GoDaddy domain+mail, Vercel site, GitHub, GitHub Releases, Supabase (control plane only). See [infra-existing-stack.md](infra-existing-stack.md) |
| Payments | Razorpay as a per-transaction operating service behind an adapter (explained to owner; confirm in Phase 7) |
| .mpp | Best-effort via LGPL sidecar, MSPDI XML fallback |

| Tenant DB | One Supabase project per tenant, created in the background at signup; all tenant activity and files in that project (owner decision). Owning organisation still open |
| Trial | 120 days, 3 named seats (Admin, Manager, Worker). Owner can extend/shorten with email + in-app notice |
| Seats | Named users; seat cap per tier, enforced server-side |
| Retention | Control plane kept 3-5 years. Tenant data not held by us. Owner-run backups deferred until commercial release |

## Next: Phase 5 sign-off, then Phase 6 (Pricing)
