# Aerolith Core

Construction ERP for Indian contractors: multi-tenant SaaS, browser + Windows desktop, each tenant's data in their own Supabase project.

- Planning (10 phases, all locked): [docs/README.md](docs/README.md)
- Licensing rule (no paid or restrictive dependencies): [docs/licensing-policy.md](docs/licensing-policy.md)
- Dependency register: [docs/dependencies.md](docs/dependencies.md)

## Layout

| Path              | What                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/api`        | NestJS + Fastify API (modular monolith)                                          |
| `apps/web`        | React + Vite SPA (also the UI inside the Electron shell, added in Wave 0 step 6) |
| `packages/shared` | Types and helpers shared by api and web                                          |
| `tools/`          | Licence gate and repo tooling                                                    |
| `docs/`           | Phase documents                                                                  |

## Develop

Requires Node 22.12+ and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm build
pnpm --filter @aerolith/api start   # http://127.0.0.1:3000/api/health
pnpm --filter @aerolith/web dev     # http://localhost:5173 (proxies /api)
pnpm check                          # format, lint, typecheck, test, licence gate (what CI runs)
```
