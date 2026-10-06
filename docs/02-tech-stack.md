# Phase 2: Tech Stack

Principle: one language, boring open-source parts, and everything must also run in Docker on a customer's server.

| Layer | Choice | Why / note |
|-------|--------|-----------|
| Language | TypeScript | One language across web, API, desktop UI, workers |
| Monorepo | pnpm + Turborepo | Shared types, one CI |
| Web app | React + Vite SPA, TanStack Router/Query, shadcn/ui + Tailwind | An SPA wraps cleanly in a desktop shell. ERP screens don't need SSR. |
| Marketing/download site | Next.js (separate app) | SEO, trial signup, download page |
| Desktop | Tauri 2 | Small installers (~10 MB vs ~100 MB Electron), signed auto-update. Online-only at MVP. |
| API | NestJS (modular monolith) on Fastify | Modules map to ERP domains, DI, guards for RBAC |
| API style | REST + OpenAPI (generated client); WebSocket for notifications | Simple to integrate with third parties |
| DB | PostgreSQL 16 | Free, open source, runs anywhere a tenant brings it |
| Data access | Drizzle ORM (or Kysely) | **Not Prisma**: per-request dynamic connections to many databases is awkward there |
| Migrations | Drizzle Kit run by our own orchestrator | Fan-out across tenant databases, see 03-architecture |
| Connection pooling | PgBouncer | Many tenant DBs mean many connections |
| Cache/queue | Redis + BullMQ | Jobs, rate limits, sessions |
| Files | S3-compatible (Cloudflare R2 / MinIO self-hosted) | Same API in cloud and self-host |
| Search | Postgres full-text first; Meilisearch later | Avoid extra infra at the start |
| Auth | Own module on the control plane (Argon2id, TOTP, OIDC for SSO) | Avoid per-seat vendor pricing |
| PDF/reports | Headless Chromium render for invoices and RA bills | Pixel-accurate GST invoices |
| Payments | Razorpay (subscriptions + payment links) | See Phase 7 |
| Observability | OpenTelemetry, Grafana/Loki/Prometheus, Sentry | Open source, self-hostable |
| CI/CD | GitHub Actions, Docker images, Tauri signed releases | |
| Hosting | One Indian region (e.g. Mumbai) on a VPS/cloud with managed Postgres | Data residency, latency |

## Risks

- [Likely] Tauri webviews differ per OS (WebView2/WKWebView/WebKitGTK). Test the matrix early.
- [Likely] NestJS modular monolith is the right call. Microservices on a small team would sink you.
