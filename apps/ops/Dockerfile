# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.16.0-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS build
WORKDIR /app

RUN corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches patches
COPY apps/ops/package.json apps/ops/package.json
RUN --mount=type=cache,id=postwave-ops-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter @postwave/ops...

COPY apps/ops apps/ops
ENV NEXT_TELEMETRY_DISABLED=1 \
    OPS_API_ORIGIN=https://api.invalid \
    OPS_API_ALLOWED_HOSTS=api.invalid \
    OPS_PUBLIC_ORIGIN=https://ops.invalid \
    OPS_RUNBOOK_BASE_URL=https://runbooks.invalid/production/
RUN pnpm --filter @postwave/ops build

FROM node:24.16.0-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS runtime
WORKDIR /app

# Keep patch selection reproducible: exact repository package versions fail
# closed when unavailable instead of allowing an unversioned full upgrade to
# resolve to different runtime bytes over time.
RUN apk add --no-cache \
      libcrypto3=3.5.8-r0 \
      libssl3=3.5.8-r0 \
 && addgroup -S -g 10001 postwave \
 && adduser -S -u 10001 -G postwave -h /home/postwave -s /sbin/nologin postwave \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3100

COPY --from=build /app/apps/ops/.next/standalone ./
COPY --from=build /app/apps/ops/.next/static ./apps/ops/.next/static
COPY apps/ops/scripts/validate-runtime-env.mjs ./apps/ops/scripts/validate-runtime-env.mjs

RUN chmod -R a-w /app

USER 10001:10001
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:3100/api/ready" >/dev/null 2>&1 || exit 1

CMD ["sh", "-c", "node apps/ops/scripts/validate-runtime-env.mjs && exec node apps/ops/server.js"]
