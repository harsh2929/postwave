# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-only

# Tags are documentary; digests are the build inputs. WAL-G is built from an
# exact source archive with a current Go security toolchain because the latest
# upstream release binary contains dependencies rejected by the image gate.
ARG POSTGRES_IMAGE="postgres:16.15-alpine3.23@sha256:421b84e07a72bb8f3715f20501a1fdbe1219aad1fa4af7786a49d9a3f2480296"
ARG GO_IMAGE="golang:1.26.8-trixie@sha256:771f3162219f7a66bb6be3fea1ba31f418932946a99ad9eac26ffd555dfcf393"

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS walg-builder
ARG TARGETOS
ARG TARGETARCH
ARG WALG_COMMIT="50dd35de57245a907d7261b0110124e17ba4efe5"
ARG WALG_SOURCE_SHA256="9affd8f948fd3da1d8c7914e795a94a7a9e7aa08cdab83280329d1bb5be473c5"
ARG WALG_VERSION="v3.0.8+postwave.20260714"
RUN set -eux; \
    mkdir -p /src/wal-g /out; \
    curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
      --output /tmp/wal-g.tar.gz \
      "https://github.com/wal-g/wal-g/archive/${WALG_COMMIT}.tar.gz"; \
    printf '%s  %s\n' "${WALG_SOURCE_SHA256}" /tmp/wal-g.tar.gz | sha256sum --check --strict; \
    tar -xzf /tmp/wal-g.tar.gz --strip-components=1 -C /src/wal-g; \
    rm /tmp/wal-g.tar.gz
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    set -eux; \
    cd /src/wal-g/main/pg; \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" GOEXPERIMENT=jsonv2 \
      go build -mod=readonly -trimpath -buildvcs=false -o /out/wal-g \
      -ldflags "-s -w -X github.com/wal-g/wal-g/cmd/pg.buildDate=2026.07.14_00:00:00 -X github.com/wal-g/wal-g/cmd/pg.gitRevision=${WALG_COMMIT} -X github.com/wal-g/wal-g/cmd/pg.walgVersion=${WALG_VERSION}"

FROM ${POSTGRES_IMAGE}
ARG AWSCLI_APK_VERSION="2.32.7-r0"
ARG BASH_APK_VERSION="5.3.3-r1"
ARG CA_CERTIFICATES_APK_VERSION="20260611-r0"
ARG COREUTILS_APK_VERSION="9.8-r1"
ARG JQ_APK_VERSION="1.8.1-r0"
ARG OPENSSL_APK_VERSION="3.5.8-r0"
ARG LIBUUID_APK_VERSION="2.41.6-r1"

LABEL org.opencontainers.image.title="Moosewave PostgreSQL backup runtime" \
      org.opencontainers.image.description="Pinned PostgreSQL client, WAL-G, AWS CLI, and Moosewave backup verification scripts" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="Moosewave"

# The statically linked WAL-G build cannot resolve a numeric UID through
# os/user on musl. Workloads always run as the postgres UID; make that identity
# explicit without requiring CGO or NSS and keep tool caches on the tmpfs.
ENV USER=postgres \
    HOME=/tmp

RUN set -eux; \
    apk add --no-cache \
      "aws-cli=${AWSCLI_APK_VERSION}" \
      "bash=${BASH_APK_VERSION}" \
      "ca-certificates=${CA_CERTIFICATES_APK_VERSION}" \
      "coreutils=${COREUTILS_APK_VERSION}" \
      "jq=${JQ_APK_VERSION}" \
      "libuuid=${LIBUUID_APK_VERSION}" \
      "openssl=${OPENSSL_APK_VERSION}"; \
    rm -f /usr/local/bin/gosu
COPY --from=walg-builder --chmod=0555 /out/wal-g /usr/local/bin/wal-g
RUN set -eux; \
    wal-g --version; \
    aws --version 2>&1 | grep -F "aws-cli/${AWSCLI_APK_VERSION%-r*}"; \
    aws s3 cp /etc/hosts s3://postwave-build-check/object --checksum-algorithm SHA256 --dryrun; \
    timeout --signal=TERM --kill-after=2 1 true; \
    date -u -d '+2555 days' +%FT%TZ; \
    pg_dump --version

COPY --chmod=0555 common.sh /usr/local/lib/postwave-backup/common.sh
COPY --chmod=0555 base-backup-once.sh /usr/local/bin/postwave-base-backup
COPY --chmod=0555 base-backup-loop.sh /usr/local/bin/postwave-base-backup-loop
COPY --chmod=0555 logical-backup.sh /usr/local/bin/postwave-logical-backup
COPY --chmod=0555 sign-base-backup-evidence.sh /usr/local/bin/postwave-sign-base-backup-evidence
COPY --chmod=0555 monitor-backups.sh /usr/local/bin/postwave-monitor-backups
COPY --chmod=0555 monitor-wal-integrity.sh /usr/local/bin/postwave-monitor-wal-integrity
COPY --chmod=0555 wal-push-wrapper.sh /usr/local/bin/postwave-wal-push
COPY --chmod=0555 wal-fetch-wrapper.sh /usr/local/bin/postwave-wal-fetch

ARG BUILD_REVISION="unknown"
LABEL org.opencontainers.image.revision="${BUILD_REVISION}"

# Kubernetes workloads set a non-root security context. The inherited
# docker-entrypoint remains available so this same immutable image can boot an
# isolated PostgreSQL recovery target during a restore drill.
