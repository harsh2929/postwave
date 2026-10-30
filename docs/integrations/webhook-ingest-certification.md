# Webhook-ingest certification & promotion runbook

Originally covered the push-only / webhook-ingest providers across the land-only
domains; it now also records the generic fallback path for providers that later
gained a native REST/OpenAPI puller. Domains include **loyalty, support, review,
subscription** (generic — any sanitized provider) and **analytics**, which serves
both the CDP-keyed sources (Segment, RudderStack —
Segment-spec identify/track) AND a **generic** webhook-ingest path
(`analytics_ingest_token`, migration 1617) for any other "profile + event" tool —
**payments, events (webinars), cms** and the like. The generic analytics handler
maps an arbitrary webhook body to a profile + event (email-gated; Segment-spec
honored first), so payments/events/cms desks are set-up-able without a per-
category subsystem. The web catalog routes those categories to the analytics
surface (`catalog-connect-map.ts`).

Webhook ingest is *inbound*: a provider POSTs events to a per-integration public
URL whose opaque token resolves the owning tenant via a SELECT-only RLS lookup
(`infra/migrations/1612–1615`). There is no outbound puller to certify, so
certification here is two things:

1. **Mapper fidelity** — the tolerant webhook→canonical mapper extracts the right
   fields from each provider's *real* documented payload.
2. **Runtime correctness** — provision → public webhook → tenant-by-token →
   land → sync-run, with FORCE-RLS enforced.

## What is certified in code (runs in CI, no creds)

| Check | Where | Status |
|---|---|---|
| Credential-free EvidenceContract / ValidateCompleteness per provider | `internal/*/[name]_livecert_test.go` | ✅ pass |
| Mapper fidelity vs **real** provider payloads (Growave, LoyaltyLion, Tidio, Freshchat) | `*_realpayload_test.go` plus provider-specific signed webhook tests | ✅ pass |
| End-to-end provision→ingest→land→sync-run vs real Postgres + FORCE RLS | `loyalty_integrations/ingest_e2e_db_test.go` (env-gated `DATABASE_URL`) | ✅ pass |
| SQL fixes (reconnect token, pull-row clobber, RLS exclusion) vs real PG16 | same e2e test + `testdata/ingest_e2e_setup.sql` | ✅ pass |

## Per-provider honesty notes (from official docs, 2026-06-21)

- **Growave** — real HMAC webhooks. Email `customer.email`; **points at root
  `currentBalance`**; **event name is header-only (`X-Growave-Topic`)**, not in
  the body, so the canonical event name is not mapped (the member + balance
  still land). Mapper covers email + points.
- **LoyaltyLion** — real webhooks. **Email path differs by event**: root
  `customer.email` (`customers/update`) vs `payload.properties.customer.email`
  (`program_events/*`); topic in the body. Mapper covers both + nested tier.
- **Marsello** — ⚠️ **NO outbound webhooks.** Public API is REST pull-only; their
  "webhooks" are *inbound* from Shopify/etc. Marsello is **not** webhook-ingestable
  — it needs a REST poller (OAuth2-password + by-id), a separate follow-on.
  Listed in the loyalty webhook-ingest provider list for completeness but will
  never deliver.
- **Tidio** — real webhooks. **Every event nests under a top-level `content`
  envelope**; email is `content.email` (contact) or `content.contact_email`
  (ticket); conversation events carry only `content.contact_id`. The generic
  mapper covers email-bearing contact/ticket payloads, and the provider-specific
  signed webhook handler now verifies `x-tidio-signature`, routes by
  `project_public_key`, and sparse-refreshes tickets or contacts through OpenAPI.
- **Freshchat** — real webhooks often lack customer email and carry only
  `conversation_id`/`user_id`. The generic mapper still ignores those sparse
  payloads, but the provider-specific signed webhook handler now verifies
  `X-Freshchat-Signature` and enriches through Freshchat Users/Conversations/
  Messages REST before writing support rows.

## Promoting a provider to `available` (the live gate)

`available` (vs the default `partial`) requires a real provider account and is an
ops action — it cannot be faked:

1. Stand up a sandbox/real account on the provider; create a webhook pointing at
   the provisioned ingest URL (`/api/public/{domain}-integrations/{provider}/ingest/{token}`).
2. Trigger a real event; confirm a member/ticket lands and a `*_sync_runs` row is
   recorded (the e2e test mirrors this against a fixture DB).
3. For the read-path puller domains, run the env-gated harness with real creds:
   `LOYALTY_LIVE_CERTIFICATION=1 LOYALTY_LIVE_<PROVIDER>='{...creds...}' go test ./internal/loyalty_integrations/ -run LiveCert`
   then `..._VALIDATE_REPORT=1` for ReportCompleteness.
4. Only then flip `RuntimeStatus` in `apps/api/internal/integrations/catalog.go`
   and add the slug to the `isNativeRuntimeCompleteLiveCertificationPending`
   allowlist (`contracts.go`) as appropriate.

Until step 4, every native webhook-ingest provider stays at `partial` — honest:
the path is built, mapper-certified against documented payloads, and runtime-
verified, but not certified against a live account.
