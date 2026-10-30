# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Audit-driven hardening pass (container-security audit):
#   * Pinned base image by digest so a malicious image rotation can't
#     swap in a compromised layer (the Dockerfile.go for the API
#     already does this; web was the laggard).
#   * Non-root USER 10001 in the runtime stage. Container escape
#     post-RCE no longer grants UID 0.
#   * HEALTHCHECK so orchestrators detect liveness without external
#     polling infrastructure.
#   * The repository .dockerignore keeps .git/.env/secrets out of
#     the build context.

FROM node:24.16.0-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS build

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches patches
COPY apps/web/package.json apps/web/package.json
COPY packages/ai-disclosure/package.json packages/ai-disclosure/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/errors/package.json packages/errors/package.json
COPY packages/nav/package.json packages/nav/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/offline-outbox/package.json packages/offline-outbox/package.json
COPY packages/onboarding-schema/package.json packages/onboarding-schema/package.json
COPY packages/query-contract/package.json packages/query-contract/package.json
COPY packages/route-map/package.json packages/route-map/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/step-up/package.json packages/step-up/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json

RUN --mount=type=cache,id=postwave-web-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter @postwave/web...

# Copy only source that can affect the web artifact. Keeping the rest of the
# monorepo out of this stage reduces the provenance/build-context surface and
# prevents unrelated native artifacts from entering the trace accidentally.
COPY apps/web apps/web
COPY packages/ai-disclosure packages/ai-disclosure
COPY packages/design-tokens packages/design-tokens
COPY packages/errors packages/errors
COPY packages/nav packages/nav
COPY packages/notifications packages/notifications
COPY packages/offline-outbox packages/offline-outbox
COPY packages/onboarding-schema packages/onboarding-schema
COPY packages/query-contract packages/query-contract
COPY packages/route-map packages/route-map
COPY packages/schema packages/schema
COPY packages/step-up packages/step-up
COPY packages/telemetry packages/telemetry
# mcp-catalog:check compares the web MCP catalog with the API's tool catalog
# (and the MCP server's tool sources, copied below); copy just that one API file.
COPY apps/api/internal/apikeycalls/tool-catalog.json apps/api/internal/apikeycalls/tool-catalog.json
COPY packages/openapi packages/openapi
COPY packages/mcp-server packages/mcp-server
COPY packages/sdk-ts packages/sdk-ts
COPY packages/cli packages/cli
COPY packages/migrate packages/migrate
COPY packages/email-react packages/email-react
COPY packages/claude-code-plugin packages/claude-code-plugin
COPY packages/vscode-extension packages/vscode-extension

# Domain the NEXT_PUBLIC_* origins are checked against. Production builds keep
# the default; a staging build passes its own domain and origins on it.
ARG POSTWAVE_WEB_CANONICAL_DOMAIN=moosewave.com
ARG POSTWAVE_RELEASE
ARG NEXT_PUBLIC_POSTWAVE_RELEASE
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_DOCS_URL
ARG NEXT_PUBLIC_FORMS_ORIGIN
ARG NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL
ARG NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN
ARG NEXT_PUBLIC_WEB_VITALS_ENDPOINT
ARG NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY
ARG NEXT_PUBLIC_POSTWAVE_API_BASE_URL
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_SENTRY_DSN_WEB
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    POSTWAVE_ENV=production \
    NEXT_PUBLIC_POSTWAVE_ENV=production \
    POSTWAVE_WEB_CANONICAL_DOMAIN=${POSTWAVE_WEB_CANONICAL_DOMAIN} \
    POSTWAVE_RELEASE=${POSTWAVE_RELEASE} \
    NEXT_PUBLIC_POSTWAVE_RELEASE=${NEXT_PUBLIC_POSTWAVE_RELEASE} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_DOCS_URL=${NEXT_PUBLIC_DOCS_URL} \
    NEXT_PUBLIC_FORMS_ORIGIN=${NEXT_PUBLIC_FORMS_ORIGIN} \
    NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL=${NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL} \
    NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN=${NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN} \
    NEXT_PUBLIC_WEB_VITALS_ENDPOINT=${NEXT_PUBLIC_WEB_VITALS_ENDPOINT} \
    NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY=${NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY} \
    NEXT_PUBLIC_POSTWAVE_API_BASE_URL=${NEXT_PUBLIC_POSTWAVE_API_BASE_URL} \
    NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
    NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST} \
    NEXT_PUBLIC_SENTRY_DSN_WEB=${NEXT_PUBLIC_SENTRY_DSN_WEB} \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY}

RUN node apps/web/scripts/check-container-build-env.mjs \
 && pnpm --filter '@postwave/web^...' build \
 && pnpm --filter @postwave/web mcp-catalog:check \
 && pnpm --filter @postwave/web build

# Sanitize before crossing the stage boundary. Deleting these files in a later
# runtime layer would hide them from the merged filesystem while retaining
# their bytes in the published OCI layers. The trace also carries the root
# build files copied in for pnpm install; the server never reads them.
RUN rm -rf /app/apps/web/.next/standalone/apps/web/src \
           /app/apps/web/.next/standalone/apps/web/.next/cache \
           /app/apps/web/.next/standalone/packages/mcp-server \
           /app/apps/web/.next/standalone/pnpm-lock.yaml \
           /app/apps/web/.next/standalone/pnpm-workspace.yaml \
           /app/apps/web/.next/standalone/turbo.json \
 && find /app/apps/web/.next/standalone \
         -path '*/node_modules/typescript' -prune -exec rm -rf '{}' + \
 && find /app/apps/web/.next/standalone \
         /app/apps/web/.next/static \
         /app/apps/web/public \
         -type f -name '*.map' -delete \
 && chmod -R a-w /app/apps/web/.next/standalone \
                  /app/apps/web/.next/static \
                  /app/apps/web/public

FROM node:24.16.0-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS runtime

WORKDIR /app

RUN apk upgrade --no-cache \
 && addgroup -S -g 10001 postwave \
 && adduser -S -u 10001 -G postwave -h /home/postwave -s /sbin/nologin postwave \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /opt/yarn-v* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
          /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    POSTWAVE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# The standalone trace contains only the production server and packages it can
# reach. Source, tests, workspace tooling, the pnpm store, and dev dependencies
# remain in the build stage.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

RUN mkdir -p /app/apps/web/.next/cache \
 && chown 10001:10001 /app/apps/web/.next/cache \
 && chmod 0700 /app/apps/web/.next/cache

WORKDIR /app/apps/web

# Drop privileges. Even if Next.js (or a dependency) is RCE'd, the
# attacker lands on UID 10001 with no write access outside /app.
USER 10001:10001

EXPOSE 3000

# Process liveness only. API/dependency readiness has a separate rollout gate;
# coupling it here would recycle healthy web tasks during an upstream outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:3000/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
