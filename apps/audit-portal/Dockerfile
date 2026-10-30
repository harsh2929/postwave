# syntax=docker/dockerfile:1.7
#
# apps/audit-portal — embeddable customer-facing audit portal (Vite SPA).
#
# Note: unlike apps/web (Next.js), audit-portal is a pure static SPA. The
# Next.js `output: "standalone"` knob does not apply here — Vite already
# produces a self-contained static `dist/` tree with no Node runtime
# dependency. This Dockerfile is the moral equivalent of the web app's
# standalone image: a slim, non-root container that runs the built SPA.
#
# Two consumption modes:
#   1. Standalone container (this image): nginx serves /portal/audit/ on
#      :8080. Use behind the gateway when running audit-portal as its own
#      pod / service.
#   2. Co-located with API (default in compose): the Go API serves the
#      `dist/` tree directly via POSTWAVE_PORTAL_SPA_DIR — the API image
#      can COPY --from=postwave/audit-portal /usr/share/nginx/html/portal
#      to bundle the assets next to the binary. In that mode this image
#      is just an artifact carrier and nginx never runs.
#
# Audit-driven hardening (mirrors apps/web/Dockerfile):
#   * Pinned base images by digest so a malicious tag rotation can't swap
#     in a compromised layer.
#   * Explicit non-root USER 101:101 in the runtime stage (nginx-unprivileged
#     listens on :8080 by default — no CAP_NET_BIND_SERVICE needed).
#   * HEALTHCHECK so orchestrators detect liveness.
#   * .dockerignore (sibling file) keeps secrets out of build context.

# -----------------------------------------------------------------------------
# Stage 1 — build the Vite SPA
# -----------------------------------------------------------------------------
FROM node:20.19.5-alpine3.22@sha256:6178e78b972f79c335df281f4b7674a2d85071aae2af020ffa39f0a770265435 AS build

WORKDIR /app

RUN corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

# Copy workspace root metadata first so the lockfile is honoured even
# though we only build a single filter. `--filter postwave-audit-portal...`
# (with the trailing `...`) installs the portal package plus any workspace
# dependencies it transitively requires.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches patches
COPY apps/audit-portal/package.json apps/audit-portal/package.json

RUN pnpm install --frozen-lockfile --filter postwave-audit-portal...

# Copy only this package's build inputs. Keeping the rest of the repository out
# of the layer prevents unrelated workspace or operator artifacts from being
# readable by build steps and makes cache invalidation package-local.
COPY apps/audit-portal apps/audit-portal

RUN pnpm --filter postwave-audit-portal build

# -----------------------------------------------------------------------------
# Stage 2 — runtime (nginx static server)
# -----------------------------------------------------------------------------
# nginxinc/nginx-unprivileged ships listening on :8080 as UID 101 so the
# image needs no CAP_NET_BIND_SERVICE and runs cleanly under non-root
# PodSecurityPolicy / PSA restricted.
FROM nginxinc/nginx-unprivileged:1.30.4-alpine3.24@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce AS runtime

# Copy the built SPA into nginx's served root. The Vite config sets
# `base: "/portal/audit/"`, so the SPA assets resolve under that prefix.
# We replicate that prefix on disk so requests like
# GET /portal/audit/assets/index-abcd.js map to a real file.
COPY --from=build --chown=101:101 /app/apps/audit-portal/dist /usr/share/nginx/html/portal/audit

# The upstream and exact frame-ancestor allowlist are validated before the
# stock nginx entrypoint envsubst pass renders this template.
#
# The hook is installed with an `.envsh` suffix on purpose: the nginx entrypoint
# *sources* `*.envsh` and *executes* `*.sh` in a child process. As a `.sh` the
# validator's exports died with that child, so envsubst rendered whatever was in
# the container environment — including an empty frame-ancestors source list.
ENV POSTWAVE_PORTAL_FRAME_ANCESTORS="'none'"
COPY apps/audit-portal/nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 apps/audit-portal/validate-runtime-env.sh /docker-entrypoint.d/10-validate-postwave-runtime.envsh

# Keep the runtime identity explicit even if the upstream image changes its
# default user metadata. UID/GID 101 owns the copied SPA and is the documented
# nginx-unprivileged runtime account.
USER 101:101

# nginx-unprivileged listens on :8080 by default.
EXPOSE 8080

# Liveness — the SPA index must be reachable under its prefix.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8080/portal/audit/" >/dev/null 2>&1 || exit 1
