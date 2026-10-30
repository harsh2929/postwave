# syntax=docker/dockerfile:1.7

ARG GO_IMAGE=golang:1.26.8-alpine3.23@sha256:33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc

FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 \
    GOFLAGS="-buildvcs=false -mod=readonly" \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local \
    GOVCS=*:off

RUN mkdir -p /out
COPY collector/go.mod collector/go.sum ./collector/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd collector \
    && for attempt in 1 2 3; do \
      go mod download all && break; \
      if [ "${attempt}" = "3" ]; then exit 1; fi; \
      sleep $((attempt * 5)); \
    done

COPY collector/ ./collector/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd collector \
    && go mod verify \
    && go build -tags=grpcnotrace -trimpath -ldflags='-s -w -buildid=' -o /out/postwave-otelcol .

COPY healthcheck/ ./healthcheck/
RUN cd healthcheck \
    && go build -trimpath -ldflags='-s -w -buildid=' -o /out/healthcheck .

FROM scratch
LABEL org.opencontainers.image.description="Minimal OpenTelemetry Collector for Moosewave production metrics" \
      org.opencontainers.image.version="0.156.0-postwave.1"
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/postwave-otelcol /otelcol
COPY --from=build /out/healthcheck /healthcheck
USER 10001:10001
ENTRYPOINT ["/otelcol"]
CMD ["--config=env:AOT_CONFIG_CONTENT"]
