# API image: NestJS API + email worker + provisioning worker (docs/deployment-docker.md).
# Build stage compiles the workspace; `pnpm deploy` then produces a standalone folder with production dependencies
# only (workspace packages included), so the runtime image has no compilers, dev tools or source.

# Base image overridable (CI pulls it through a mirror of Docker Hub); the default is the official image.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# Optional: behind a TLS-inspecting proxy, pass its CA with `--secret id=extra_ca,src=<file>`. Unused when absent.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm fetch --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY tools/notices.mjs tools/
RUN pnpm install --offline --frozen-lockfile --filter @aerolith/api... \
 && pnpm --filter @aerolith/shared build \
 && pnpm --filter @aerolith/api build \
 && pnpm --filter @aerolith/api deploy --prod --legacy /out \
 && node tools/notices.mjs --product "Aerolith Core API" --filter "@aerolith/api..." --out /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Development email output (EMAIL_TRANSPORT=file) and tender documents go to volumes mounted here. A new named volume
# takes the folder's owner from the image, so the app (user node) can write to it.
RUN mkdir -p /app/.mail-outbox /app/documents /app/backups && chown node:node /app/.mail-outbox /app/documents /app/backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply control-plane migrations (idempotent, checksummed), then start.
CMD ["sh", "-c", "node dist/cli/migrate-control.js && exec node dist/main.js"]
