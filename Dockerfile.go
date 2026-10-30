# syntax=docker/dockerfile:1.7

ARG SERVICE_PATH=./apps/api

FROM node:20.19.5-alpine3.22@sha256:6178e78b972f79c335df281f4b7674a2d85071aae2af020ffa39f0a770265435 AS portal-build

ARG SERVICE_PATH
WORKDIR /portal
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches patches
COPY apps/audit-portal/package.json apps/audit-portal/package.json
COPY apps/audit-portal apps/audit-portal
RUN if [ "${SERVICE_PATH}" = "./apps/api" ]; then \
      corepack enable \
      && corepack prepare pnpm@9.12.0 --activate \
      && pnpm install --frozen-lockfile --filter postwave-audit-portal... \
      && pnpm --filter postwave-audit-portal build; \
    else \
      mkdir -p /portal/apps/audit-portal/dist; \
    fi

FROM golang:1.26.8-alpine3.23@sha256:33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc AS build

WORKDIR /src

RUN apk add --no-cache ca-certificates

ENV GOTOOLCHAIN=local \
    GOPROXY=https://proxy.golang.org,direct \
    CGO_ENABLED=0

COPY go.work* ./
COPY apps/api/go.* apps/api/
COPY packages/kms/go.* packages/kms/
COPY packages/migrate/go.* packages/migrate/
COPY packages/runtime/go.* packages/runtime/
COPY packages/secrets/go.* packages/secrets/
COPY services/automation/go.* services/automation/
COPY services/deliverability/go.* services/deliverability/
COPY services/migration/go.* services/migration/
COPY services/voice/go.* services/voice/

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    for attempt in 1 2 3; do \
      go mod download all && break; \
      if [ "$attempt" = "3" ]; then exit 1; fi; \
      sleep $((attempt * 5)); \
    done

COPY . .
COPY --from=portal-build /portal/apps/audit-portal/dist /tmp/postwave-audit-portal

ARG SERVICE_PATH

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    mkdir -p /out/bin \
    && go build -trimpath -ldflags='-s -w' -o /out/bin/postwave-service ${SERVICE_PATH} \
    && case "${SERVICE_PATH}" in \
         ./apps/api|apps/api) \
           go build -trimpath -ldflags='-s -w' -o /out/bin/campaign-assurance-worker ./apps/api/cmd/campaign-assurance-worker \
           && go build -trimpath -ldflags='-s -w' -o /out/bin/campaign-assurance-image-broker ./apps/api/cmd/campaign-assurance-image-broker \
           && go build -trimpath -ldflags='-s -w' -o /out/bin/campaign-assurance-model-sandbox ./apps/api/cmd/campaign-assurance-model-sandbox \
           && go build -trimpath -ldflags='-s -w' -o /out/bin/campaign-assurance-provider-gateway ./apps/api/cmd/campaign-assurance-provider-gateway \
           && go build -trimpath -ldflags='-s -w' -o /out/bin/campaign-assurance-ocr-sandbox ./apps/api/cmd/campaign-assurance-ocr-sandbox \
           && go build -trimpath -ldflags='-s -w' -o /out/bin/campaign-assurance-content-scanner ./apps/api/cmd/campaign-assurance-content-scanner ;; \
       esac \
    && mkdir -p /out/runtime/proprietary \
                /out/runtime/audit-portal \
    && case "${SERVICE_PATH}" in \
         ./apps/api) \
           cp -a /tmp/postwave-audit-portal/. /out/runtime/audit-portal/ ;; \
         ./services/deliverability) \
           mkdir -p /out/runtime/proprietary/prompts /out/runtime/proprietary/eval \
           && cp -a proprietary-stubs/prompts/diagnostician /out/runtime/proprietary/prompts/ \
           && cp -a proprietary-stubs/eval/diagnostician-cases /out/runtime/proprietary/eval/ ;; \
         ./services/voice) \
           mkdir -p /out/runtime/proprietary/prompts /out/runtime/proprietary/templates \
           && cp -a proprietary-stubs/prompts/voice /out/runtime/proprietary/prompts/ \
           && cp -a proprietary-stubs/templates/voice-templates /out/runtime/proprietary/templates/ ;; \
       esac

# The assurance runtime is published separately from the API image. It contains
# only the six role-specific Go binaries and base TLS/timezone data: no API
# binary, audit portal, proprietary prompt tree, OCR model, or scanner database.
FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS campaign-assurance-core

RUN apk add --no-cache \
        ca-certificates \
        libcrypto3=3.5.8-r0 \
        libssl3=3.5.8-r0 \
        tzdata \
    && addgroup -S -g 10001 postwave \
    && adduser -S -u 10001 -G postwave -h /home/postwave -s /sbin/nologin postwave

COPY --from=build /out/bin/campaign-assurance-worker /usr/local/bin/campaign-assurance-worker
COPY --from=build /out/bin/campaign-assurance-image-broker /usr/local/bin/campaign-assurance-image-broker
COPY --from=build /out/bin/campaign-assurance-model-sandbox /usr/local/bin/campaign-assurance-model-sandbox
COPY --from=build /out/bin/campaign-assurance-provider-gateway /usr/local/bin/campaign-assurance-provider-gateway
COPY --from=build /out/bin/campaign-assurance-ocr-sandbox /usr/local/bin/campaign-assurance-ocr-sandbox
COPY --from=build /out/bin/campaign-assurance-content-scanner /usr/local/bin/campaign-assurance-content-scanner

USER 10001:10001

# Download ClamAV's signed, architecture-independent database once on the
# BuildKit host platform. In a multi-platform build every target copies this
# same stage artifact; the exact expected daily revision below independently
# prevents separate release jobs from crossing a database publication boundary.
FROM --platform=$BUILDPLATFORM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS clamav-database

ARG CLAMAV_DATABASE_REFRESH

RUN test -n "${CLAMAV_DATABASE_REFRESH}" \
    && apk add --no-cache ca-certificates freshclam=1.4.4-r0 \
    && freshclam --stdout --no-warnings \
    && chmod -R a-w,go+rX /var/lib/clamav

# OCR/scanner dependencies are isolated to this separately published target.
# CLAMAV_DATABASE_REFRESH is a required publisher-supplied cache buster (for
# example, the UTC release timestamp). CLAMAV_DATABASE_VERSION is the exact
# numeric daily-signature revision expected in every target architecture.
# Freshclam runs only in the build-platform stage; its signed database is frozen
# into the image and the runtime updater is removed. The runtime scanner has no
# network and reports the embedded database revision in its fail-closed identity.
FROM campaign-assurance-core AS campaign-image-services

ARG CLAMAV_DATABASE_VERSION

USER root

RUN case "${CLAMAV_DATABASE_VERSION}" in \
      ''|*[!0-9]*) echo "CLAMAV_DATABASE_VERSION must be an exact numeric revision" >&2; exit 1 ;; \
    esac \
    && apk add --no-cache \
         clamav-scanner=1.4.4-r0 \
         tesseract-ocr=5.5.1-r0 \
         tesseract-ocr-data-eng=5.5.1-r0 \
    && test -x /usr/bin/clamscan \
    && test -x /usr/bin/tesseract \
    && test -s /usr/share/tessdata/eng.traineddata

COPY --from=clamav-database /var/lib/clamav/ /var/lib/clamav/

RUN actual_database_version="$(clamscan --version | awk -F/ 'NF >= 3 { print $2; exit }')" \
    && test "${actual_database_version}" = "${CLAMAV_DATABASE_VERSION}" \
    && chmod -R a-w,go+rX /var/lib/clamav /usr/share/tessdata \
    && rm -f /usr/bin/freshclam

USER 10001:10001

# Keep the existing ordinary service image as the final/default target so
# callers that do not pass --target retain the current build and runtime shape.
FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS ordinary-service

ARG SERVICE_PATH
ARG SERVICE_PORT=8080
ARG HEALTHCHECK_PATH=/api/ready

RUN case "${SERVICE_PATH}:${SERVICE_PORT}:${HEALTHCHECK_PATH}" in \
      ./apps/api:8080:/api/ready|apps/api:8080:/api/ready|\
      ./services/migration:8081:/health|services/migration:8081:/health|\
      ./services/deliverability:8082:/health|services/deliverability:8082:/health|\
      ./services/voice:8083:/health|services/voice:8083:/health|\
      ./services/automation:8084:/health|services/automation:8084:/health) ;; \
      *) echo "unsupported service health contract: ${SERVICE_PATH}:${SERVICE_PORT}:${HEALTHCHECK_PATH}" >&2; exit 1 ;; \
    esac \
    && apk add --no-cache \
         ca-certificates \
         libcrypto3=3.5.8-r0 \
         libssl3=3.5.8-r0 \
         tzdata \
         wget \
    && addgroup -S -g 10001 postwave \
    && adduser -S -u 10001 -G postwave -h /home/postwave -s /sbin/nologin postwave

COPY --from=build /out/bin/postwave-service /usr/local/bin/postwave-service
COPY --from=build /out/runtime/audit-portal /opt/postwave/audit-portal
COPY --from=build /out/runtime/proprietary /etc/postwave/proprietary

ENV PORT=${SERVICE_PORT} \
    POSTWAVE_HEALTHCHECK_PATH=${HEALTHCHECK_PATH} \
    POSTWAVE_PORTAL_SPA_DIR=/opt/postwave/audit-portal

# Drop privileges. Container escape post-RCE no longer grants UID 0.
USER 10001:10001

EXPOSE ${SERVICE_PORT}

# The API uses dependency/configuration readiness; sidecars use their own
# process-specific /health route. The build contract above prevents a service
# image from silently inheriting another service's port or probe path.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}${POSTWAVE_HEALTHCHECK_PATH}" >/dev/null 2>&1 || exit 1

CMD ["postwave-service"]
