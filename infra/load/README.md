# Load testing — k6 baseline

These scripts establish the throughput / latency baseline for Moosewave's
critical hot paths. They are **not** correctness tests — they assume the
endpoints behave correctly and only measure how fast they behave.

## Install

[k6](https://k6.io) is a separate binary; we deliberately do not vendor it.

```sh
# macOS
brew install k6

# Linux: use the official package-repository instructions, or mirror the
# checksum-verified v0.54.0 installer in .github/workflows/load-baseline.yml.
# Never pipe an unverified mutable release download into tar or a shell.
sudo mv k6-*/k6 /usr/local/bin/
```

Verify:

```sh
k6 version
```

## Running locally

Bring up the docker-compose stack first — the scripts assume the API is
listening on `http://localhost:8080` and authenticate via the dev tenant
slug header `X-Tenant-Slug: demo`.

```sh
docker compose -f infra/docker-compose.full.yml up -d
# wait ~10s for the API to come up

# Then any of:
k6 run infra/load/dashboard.k6.js
k6 run infra/load/send-loop.k6.js
k6 run infra/load/migration.k6.js
GOWORK=off go run ./tests/e2e/cmd/sse-load \
  -base-url http://localhost:8080 -clients 500 -hold 10s
k6 run infra/load/subscriber-crud.k6.js
k6 run infra/load/abuse-rate-limit.k6.js

# Local gate wrapper for the load + abuse smoke subset:
pnpm test:load:local
```

You can override target + tenant via env vars:

```sh
POSTWAVE_LOAD_BASE_URL=https://staging.moosewave.com \
POSTWAVE_LOAD_API_KEY='<scoped staging API key>' \
  k6 run infra/load/dashboard.k6.js
```

To override the VU profile from the CLI (handy when iterating):

```sh
k6 run --vus 50 --duration 30s infra/load/dashboard.k6.js
```

## Interpreting results

k6 prints a per-script summary at the end. The lines that matter:

| Metric                | Means                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| `http_req_duration`   | end-to-end time, server + network + json parse. Reported as avg / p(90) / p(95) / max. |
| `http_req_failed`     | rate of non-2xx + transport errors. We threshold this at < 1%.                         |
| `iteration_duration`  | one full iteration (default function call) — useful for "how many user trips/sec".     |
| `checks`              | logical assertions inside the script. Should be 100%; below that means data shape changed. |

`THRESHOLDS` in each script encode the acceptable p95s and error rates.
A run that breaches any threshold exits non-zero — which is exactly what
the nightly `.github/workflows/load-baseline.yml` smoke uses to flag a
regression.

## Production sanity targets

These are the numbers we _want_ to hit in staging/production. Local-dev
laptops will not reach them; treat the script thresholds as ceiling for
local runs, not floor.

| Path                                       | p(95) target | Error rate | Throughput target |
| ------------------------------------------ | ------------ | ---------- | ----------------- |
| `GET /api/v1/dashboard/stats`              | < 400 ms     | < 0.1%     | 250 req/s         |
| `GET /api/v1/campaigns?per_page=20`        | < 400 ms     | < 0.1%     | 150 req/s         |
| Campaign send-loop (queue → first dispatch) | < 5 s P95    | < 0.5%     | 50 sends/s        |
| Migration discovery (dry-run plan)         | < 8 s P95    | < 1%       | (single-tenant)   |
| Events SSE first byte + 10-second hold     | < 1 s P95    | < 0.5%     | 500 concurrent    |
| Subscriber CRUD mixed                      | < 250 ms P95 | < 0.5%     | 200 req/s         |
| Public form/API abuse smoke                | < 500 ms P95 | < 1% uncontrolled statuses | controlled 4xx/429, no 5xx |

## Local-dev caveat

50 VUs against a single-laptop docker-compose stack is **not realistic**.
You will saturate the postgres on your loopback before any code path
matters. For meaningful numbers run from a separate machine on the same
network, or against staging.

Use the local runs to spot regressions in _relative_ latency:
a P95 that jumps from 80 ms → 250 ms on the same hardware between commits
is meaningful even if 250 ms is nowhere near production.

## Adding new scripts

1. Place under `infra/load/<name>.k6.js`.
2. Always set a `thresholds` block — k6 has no notion of pass/fail without it.
3. Tag each request with `tags: { name: 'GET /foo' }` so the summary stays
   readable (otherwise every URL with an id becomes a separate row).
4. Add the script + targets to the table above.

## CI staging contract

The scheduled workflow requires all three GitHub settings below. It fails
closed when any is absent; a localhost or reserved `.test` result is never
accepted as release evidence.

- repository variable `POSTWAVE_LOAD_BASE_URL`: deployed HTTPS API origin;
- repository variable `POSTWAVE_LOAD_ALLOWED_HOST`: its one exact DNS host;
- secret `POSTWAVE_LOAD_API_KEY`: tenant-scoped key with the read/write scopes
  needed by the selected probes.

Remote scripts use only `Authorization: Bearer ...`. Development-only
`X-Tenant-Slug`/`X-Postwave-Role` authentication is limited to loopback runs.
The SSE baseline uses the stdlib Go probe because k6 waits for a streaming
response to finish and therefore cannot report trustworthy first-byte latency.
