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
| @tanstack/react-router, @tanstack/react-query | MIT | web | Routing and server-state caching (02-tech-stack) |
| lucide-react | ISC | web | Icons |
| qrcode | MIT | web | QR code for authenticator enrolment (generated locally; the secret never leaves the device) |
| @fastify/cors | MIT | api | CORS allow-list for the desktop app's origin |
| nodemailer | MIT-0 | api | SMTP delivery and .eml file output for the email worker |
| postgres | Unlicense | api, bench | PostgreSQL driver (tagged-template queries, COPY streaming). The control plane uses it directly; Kysely is re-evaluated when tenant-module CRUD starts |
| zod | MIT | api | Request validation and environment/config validation |
| @node-rs/argon2 | MIT | api | Argon2id password hashing (prebuilt binaries; Node 22 has no built-in Argon2) |
| fastify | MIT | api | Already used through @nestjs/platform-fastify; declared directly for redirect types and the fake Supabase server in tests |

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
| @types/node, @types/react, @types/react-dom, @types/qrcode | MIT | Type definitions |
| tailwindcss, @tailwindcss/vite | MIT | Styling |
| happy-dom, @testing-library/react | MIT | Web unit tests (happy-dom instead of jsdom: jsdom 30 needs Node ≥ 22.22.2) |
| electron | MIT | Desktop runtime (bundled into the installer; its Chromium licences ship with it) |
| electron-builder | MIT | Windows installer packaging. Pulls in `truncate-utf8-bytes` (WTFPL) at build time only; accepted under the build-tooling rule in licensing-policy §2 |
| smtp-server, mailparser, @types/nodemailer, @types/smtp-server, @types/mailparser | MIT-0 / MIT | Real SMTP conversations and parsing in email tests and e2e |
| @playwright/test | Apache-2.0 | Browser end-to-end tests. CI installs its own Chromium; sandboxed machines can point `PW_CHROMIUM_PATH` at a pre-installed one |
