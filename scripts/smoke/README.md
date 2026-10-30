# 2026 white-space features — live smoke

Turnkey end-to-end smoke for the five features shipped on this branch:

| # | Feature | Spec |
|---|---|---|
| 1 | AI-Output Regression Harness | `docs/superpowers/specs/2026-06-15-regression-harness-design.md` |
| 2 | Consent-Safe Activation Firewall | `…-consent-firewall-design.md` |
| 3 | Surfacing Analytics | `…-surfacing-analytics-design.md` |
| 4 | Segment P&L | `…-segment-pnl-design.md` |
| 5 | Segment Decay Radar | `…-decay-radar-design.md` |

This is the verification layer that the unit/package/typecheck gates can't cover:
running each feature's flow against a **live API gateway + Postgres**.

## What it proves vs. what it can't

- **Real assertions (Postgres only):** every new endpoint responds, the four
  `ai_regression` tables + settings defaults exist, a golden example can be
  captured and read back, the activation firewall computes a pre-flight
  exclusion count, the engagement panel returns its hard signals, segment P&L
  returns revenue + honest (null-when-no-holdout) lift, and decay-events /
  definition-history are reachable. A missing table 500s the endpoint, so this
  doubles as a **migration-applied check** for 0402–0412.
- **Gated behind `POSTWAVE_SMOKE_LLM=1`:** the #1 *replay* step calls the voice
  service → Gemini/OpenAI. Without the flag it **skips with a warning** (never a
  false pass). It needs the voice service running with `GEMINI_API_KEY` +
  `OPENAI_API_KEY`.

## 1. Bring up the stack

```bash
docker compose -f infra/docker-compose.yml up -d        # Postgres + Redis + Listmonk
go run -C apps/api ./cmd/migrate up                      # apply migrations (or let the gateway do it at boot)
# start the API gateway with DATABASE_URL / REDIS_ADDR / LISTMONK_* set (see docs/DEVELOPING.md)
```

## 2. Provide auth + (optionally) resource ids

```bash
export POSTWAVE_BASE_URL=http://localhost:3000
export POSTWAVE_TENANT_ID=<tenant-uuid>
export POSTWAVE_API_KEY=<api-key-with-admin+read-reports scopes>
#   …or:  export POSTWAVE_AUTH_HEADER="Cookie: session=…"

# Optional — otherwise auto-discovered from list endpoints:
export POSTWAVE_SEGMENT_ID=<segment-uuid>
export POSTWAVE_CAMPAIGN_ID=<campaign-uuid>
export POSTWAVE_AUDIENCE_SYNC_ID=<audience-sync-uuid>

# Optional — enable the LLM/voice replay step:
export DATABASE_URL=postgres://postgres:public-local-demo-only@localhost:5432/postwave   # enables DB preflight
export POSTWAVE_SMOKE_LLM=1
```

## 3. Run

```bash
bash scripts/smoke/run-whitespace-2026-smoke.sh      # preflight + smoke
# or just the HTTP smoke:
node scripts/smoke/whitespace-2026-smoke.mjs         # add --strict to fail on warnings
# or via pnpm:
pnpm test:smoke:whitespace
```

## Output & exit codes

Prints a JSON summary (`{status, blockers, warnings, checks:[…]}`) like the
existing `pilot-certification-smoke.mjs`. Exit **1** if any `blocker` (or any
`warning` under `--strict`/`POSTWAVE_SMOKE_STRICT=1`), else **0**. Each check
carries `detail` + `evidence` so a failure tells you exactly what and where.

`warning` is expected (not failure) when a resource id is absent (no segments /
campaigns / audience syncs seeded yet) or the LLM step is disabled — those are
honest "couldn't exercise" signals, not regressions.
