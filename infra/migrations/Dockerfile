# syntax=docker/dockerfile:1.7

# Immutable one-shot database migrator. Unlike the application/service image,
# this artifact bakes the complete SQL set and a SHA-256 manifest into the
# image. Its entrypoint refuses missing/extra/changed files and verifies the
# final database count, latest version, and every recorded checksum.
FROM golang:1.26.8-alpine3.23@sha256:33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc AS build

WORKDIR /src
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
    go mod download all

COPY . .

WORKDIR /src/apps/api
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags='-s -w' -o /out/postwave-migrate ./cmd/migrate && \
    go build -trimpath -ldflags='-s -w' \
      -o /out/postwave-verify-migrations \
      ../../scripts/release/verify-migration-state.go && \
    go build -trimpath -ldflags='-s -w' \
      -o /out/postwave-verify-consent-evidence \
      ../../scripts/release/verify-consent-evidence.go

WORKDIR /src
RUN scripts/release/build-migration-manifest.sh \
      infra/migrations \
      /out/migration-manifest.sha256 \
      /out/migration-manifest.env

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

RUN apk add --no-cache \
        ca-certificates \
        libcrypto3=3.5.8-r0 \
        libssl3=3.5.8-r0 \
    && addgroup -S -g 10001 postwave \
    && adduser -S -u 10001 -G postwave -h /home/postwave -s /sbin/nologin postwave

COPY --from=build /out/postwave-migrate /usr/local/bin/postwave-migrate
COPY --from=build /out/postwave-verify-migrations /usr/local/bin/postwave-verify-migrations
COPY --from=build /out/postwave-verify-consent-evidence /usr/local/bin/postwave-verify-consent-evidence
COPY --from=build /out/migration-manifest.sha256 /usr/local/share/postwave/migration-manifest.sha256
COPY --from=build /out/migration-manifest.env /usr/local/share/postwave/migration-manifest.env
COPY --from=build /src/infra/migrations/*.sql /migrations/
COPY --from=build /src/infra/migrations/checksum-supersessions.json /migrations/checksum-supersessions.json
COPY scripts/release/run-migrator.sh /usr/local/bin/postwave-run-migrator

RUN chmod 0555 \
      /usr/local/bin/postwave-migrate \
      /usr/local/bin/postwave-verify-migrations \
      /usr/local/bin/postwave-verify-consent-evidence \
      /usr/local/bin/postwave-run-migrator \
    && chmod -R a+rX,a-w /migrations /usr/local/share/postwave

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/postwave-run-migrator"]
