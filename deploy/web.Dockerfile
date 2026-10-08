# syntax=docker/dockerfile:1
# Web image: the browser app served by Caddy (Apache-2.0), which also proxies /api to the API container.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
# Optional: behind a TLS-inspecting proxy, pass its CA with `--secret id=extra_ca,src=<file>`. Unused when absent.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm fetch --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm install --offline --frozen-lockfile --filter @aerolith/web... \
 && pnpm --filter @aerolith/shared build \
 && pnpm --filter @aerolith/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
