# Dependency Register

Required by [licensing-policy.md](licensing-policy.md) §3: every direct dependency is listed with its licence and reason.
The CI licence gate (`pnpm licenses:check`) checks transitive dependencies automatically.

## Production

| Package | Licence | Used by | Why |
|---------|---------|---------|-----|
| @nestjs/common, @nestjs/core, @nestjs/platform-fastify | MIT | api | Modular-monolith API framework on Fastify (02-tech-stack) |
| reflect-metadata | Apache-2.0 | api | Decorator metadata for NestJS dependency injection |
| rxjs | Apache-2.0 | api | NestJS peer dependency |
| react, react-dom | MIT | web | UI |
| postgres | Unlicense | api, bench | PostgreSQL driver (tagged-template queries, COPY streaming). The control plane uses it directly; Kysely is re-evaluated when tenant-module CRUD starts |
| zod | MIT | api | Request validation and environment/config validation |

## Development only

| Package | Licence | Why |
|---------|---------|-----|
| typescript | Apache-2.0 | Language. Pinned to 6.0.x because typescript-eslint does not yet support 7.x |
| turbo | MIT | Monorepo task runner |
| eslint, @eslint/js, typescript-eslint | MIT | Lint |
| prettier | MIT | Formatting |
| vitest | MIT | Tests |
| vite, @vitejs/plugin-react | MIT | Web build |
| @nestjs/testing | MIT | API tests |
| @swc/core, unplugin-swc | Apache-2.0, MIT | Compile API tests with decorator metadata |
| @types/node, @types/react, @types/react-dom | MIT | Type definitions |
