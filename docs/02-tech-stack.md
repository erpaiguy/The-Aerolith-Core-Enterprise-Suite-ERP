# Phase 2: Tech Stack (rev 2)

Principle: one language, open-source parts, everything also runs in Docker on a customer's server.
Changes from rev 1: **Electron** for desktop, and a **large-scale data access layer** replacing the ORM-first approach.

| Layer | Choice | Why / note |
|-------|--------|-----------|
| Language | TypeScript | One language across web, API, desktop, workers |
| Monorepo | pnpm + Turborepo | Shared types, one CI |
| Web app | React + Vite SPA, TanStack Router/Query, Tailwind + shadcn/ui | SPA wraps cleanly in Electron |
| Heavy grids | **Canvas-based virtual grid** (Glide Data Grid, MIT) or a custom canvas grid; **server-side row model** | DOM grids stall far below 1M rows. AG Grid's server-side row model is paid. |
| Gantt/scheduling UI | **Custom canvas/WebGL Gantt** with virtualized rows and time axis | Off-the-shelf Gantts struggle at 50+ pages of activities |
| Marketing/download site | Next.js | SEO, trial signup, download page, customer portal |
| Desktop | **Electron** (your decision) | Consistent Chromium on every OS, so one rendering engine to test for the grid and Gantt. Installers ~100+ MB and higher RAM; auto-update via electron-updater, code-signed. |
| API | NestJS (modular monolith) on Fastify | Modules map to ERP domains |
| API style | REST + OpenAPI; WebSocket for live updates; **binary/streamed responses (NDJSON/Arrow) for bulk** | Large data must stream |
| DB | PostgreSQL 16+ | Free, open source, runs anywhere |
| **Data access** | **Kysely (typed SQL builder) + `postgres`/`pg` driver; hand-written SQL for hot paths; `COPY` for bulk load; no ORM in bulk or hot paths** | ORMs hide N+1 and row-by-row inserts that kill 1M-row workloads. Typed SQL keeps control per tenant connection. |
| Schema migrations | Plain SQL migrations (ordered, checksummed) run by our orchestrator | Reviewable, DBA-friendly, works on BYO-DB |
| DB techniques for scale | Hash/range **partitioning** of line tables by BOQ or tenant, **ltree/materialized path** for hierarchy, covering indexes, **keyset pagination**, rollup tables maintained incrementally, `pg_trgm` for search | See 03 §13 |
| Compute workers | Node worker threads; **Rust (napi-rs or WASM) for CPM/schedule and rollup engines** if profiling demands it | Critical-path calc on tens of thousands of activities |
| Connection pooling | PgBouncer | Many tenant databases |
| Cache/queue | **Valkey** (BSD-3) + BullMQ (MIT) | Redis licence changed; Valkey is the open fork |
| Files | S3-compatible API behind an adapter. Default **SeaweedFS** (Apache-2.0), tenants may use any S3 store they already own | MinIO is AGPL; R2 is a paid service |
| Search | Postgres FTS + trigram first; Meilisearch/OpenSearch if benchmarks require | Avoid infra before it is needed |
| Auth | Own module (Argon2id, TOTP, signed tokens) | See 03 §6 |
| PDF/reports | Headless Chromium render, streamed Excel (exceljs streaming writer) | Large exports must not hold everything in memory |
| Payments | Razorpay behind a gateway adapter (an operating service, no licence cost; per-transaction fees) | Phase 7 |
| Observability | OpenTelemetry + Prometheus (Apache-2.0), **GlitchTip** (MIT) for errors | Sentry is FSL. Grafana/Loki are AGPL: internal ops only, never bundled |
| CI/CD | GitHub Actions, Docker images, signed Electron releases (Windows/macOS/Linux), **licence scan + SBOM gate** | Code-signing certs are a real cost, see licensing-policy |
| Hosting | India region (e.g. Mumbai). An operating cost, not an embedded tool | Data residency, latency |
| AI (v2) | Permissively licensed models only; classical ML (ONNX) | See licensing-policy §4 |

## Risks

- [Certain] Electron means a bigger download and memory footprint than Tauri. Accepted. Consistent rendering is worth more for grid and Gantt performance.
- [Likely] Dropping the ORM costs developer speed on ordinary CRUD. Mitigation: generate typed query helpers, use plain Kysely for CRUD and hand SQL only where benchmarks demand it.
- [Likely] Building a custom canvas Gantt is months of work on its own. Budget it as a product inside the product.

## Licence compliance (new in rev 3)

All embedded dependencies must satisfy [licensing-policy.md](licensing-policy.md): permissive licences only, enforced in CI.
Verified-permissive choices in this stack: Electron, React, Vite, TanStack, Tailwind, shadcn/ui (MIT); NestJS, Fastify,
Kysely, BullMQ, exceljs (MIT); PostgreSQL and contrib `ltree`/`pg_trgm` (PostgreSQL licence); PgBouncer (ISC);
Glide Data Grid (MIT); Meilisearch community core (MIT, never the BUSL enterprise features) or OpenSearch (Apache-2.0);
Chromium/Puppeteer (BSD/Apache-2.0). [Likely] each was permissive at my last check, but licences change, so the CI scan is the real guarantee.
