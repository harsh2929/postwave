# apps/api — Moosewave API gateway

AGPL-3.0-only Go gateway that fronts the Next.js admin app. Talks to the
separately deployed Listmonk process only over HTTP (see
`LICENSE-BOUNDARY.md`) and proxies
domain-specific calls to the four internal services: `migration`,
`deliverability`, `voice`, `automation`.

## Run

```sh
cp .env.example .env
go run .
```

Then `curl http://localhost:8080/api/health`.

### Campaign Assurance send-gate rollout

`POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT` accepts only `off`, `shadow`,
`warn`, or `block`. Every active mode requires the durable Campaign Assurance
runtime. The API composes one exact-hash evaluator across the unified pre-send
verdict and every canonical queue entry point; block mode also reauthorizes the
complete live waiver set immediately before raw-RFC822 provider dispatch and
withholds every unbound row. The older
`POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE=true` remains an exact alias for
`block`; conflicting values fail startup. See the
[send-gate runbook](../../docs/runbooks/campaign-assurance-send-gate.md).

The API is control plane only. Durable execution runs in
`cmd/campaign-assurance-worker`; model calls traverse the authenticated
`campaign-assurance-model-sandbox` → `campaign-assurance-provider-gateway`
Unix-socket boundary, and remote images traverse
`campaign-assurance-image-broker` → isolated OCR/scanner sockets. The API task
must not receive those sockets, the provider key, or image-broker capability.
See the [modeled-runtime](../../docs/runbooks/campaign-assurance-modeled-runtime.md),
[image-runtime](../../docs/runbooks/campaign-image-broker-runtime.md), and
[production deployment](../../infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md) runbooks.

### Engagement classifier v2 shadow rollout

`POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2=true` installs the versioned Track B
F01 `human | machine | unknown` classifier on the canonical Listmonk
`subscriber_events` transaction. Enabled startup fails closed unless migration
1934, the exact immutable registry, a dedicated HMAC key of at least 32 bytes,
its stable key id, and bounded retention/lease values are ready. Listmonk uses
tenant-worker scope only for classified writes; the feature-off path retains
ordinary tenant scope. Recipient, message, and link identities are tenant- and
purpose-separated keyed commitments, Listmonk never claims ordered-header
completeness, and a classification failure rolls back the canonical event,
provider dedupe key, and every projection. Results remain shadow-only; unknown
is never treated as human. See the
[shadow rollout runbook](../../docs/runbooks/engagement-classifier-v2-shadow.md).

### Asset delivery configuration

Local development stores library images under `POSTWAVE_DATA_DIR/assets` and
serves them through the authenticated `/api/v1/assets/{id}/blob` route.
Production canonical S3 mode requires `POSTWAVE_ASSETS_BUCKET`,
`POSTWAVE_S3_KMS_KEY_ID`, and `POSTWAVE_ASSETS_PUBLIC_BASE_URL`. The last value
must be an HTTPS CloudFront/CDN origin (optionally with a path prefix) whose
private-bucket access is implemented with OAC; the API never makes the bucket
public and never embeds AWS credentials or signed query strings in campaign
content. Uploaded UUID-keyed objects carry a one-year immutable cache policy.

Tenant portability exports deliberately do not use that delivery path.
Development writes mode-0600 bundles beneath
`POSTWAVE_DATA_DIR/private-exports`; production requires a separate private,
non-CDN `POSTWAVE_EXPORTS_BUCKET` plus `POSTWAVE_S3_KMS_KEY_ID`. Export object
keys never appear in API responses. The owner/admin download endpoint rechecks
tenant, possession-proof freshness, ready state, and expiry, then streams with
`Cache-Control: private, no-store`. Set `POSTWAVE_DISABLE_EXPORTS=1` to start a
production task without the private bucket; otherwise missing configuration is
a startup error rather than a fallback to public asset storage.

Cloudflare R2 remains an optional alternative. A production R2 deployment must
set `R2_PUBLIC_BASE` to its public HTTPS custom domain. The private
`*.r2.cloudflarestorage.com` S3 API endpoint is not inferred as a delivery URL.
DNS, TLS, CDN-to-origin authorization/OAC, and an external email-client fetch
probe are deployment qualifications and cannot be proven by unit tests. The
web production CSP permits only the exact
`NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL` origin for template previews; configure
that build value to the same public base used here. A mismatch fails closed to
the web preview placeholder.

Really Good Emails and Aura reference screenshots are queued during catalog
import and copied asynchronously into this durable store after strict
provider-bound host/path, public-DNS, redirect, MIME, size, and
image-sanitization checks. Aura web references enqueue desktop/card previews
only; their 320/800/1600 sources are resolution variants, not mobile-layout
captures. The preview worker starts only with S3 or R2; the development
filesystem adapter is not a public CDN and intentionally leaves those jobs
queued.

`GET /api/v1/assets` accepts `before=<last asset id>` for every supported sort.
The cursor is a canonical lowercase UUID and each sort uses an ID tie-breaker,
so paging across tied timestamps, names, sizes, or reference counts cannot skip
or duplicate rows. The response's additive `nextCursor` is the last returned ID
only when a one-row probe proves another page exists; it is `null` on the final
page. Existing clients may continue passing their last item ID. Invalid sort,
filter, folder, and cursor inputs return 400.

## Routes

- `GET /api/health` — gateway liveness + build version.
- `GET /api/listmonk/health` — proxied liveness probe to Listmonk.
- Sending provisioning is triggered by Dodo Payments billing webhooks. The direct
  `/api/v1/sending/provision` escape hatch is disabled in production unless
  `POSTWAVE_ALLOW_DIRECT_PROVISION=1` is set for an explicit ops repair.
  (Postmark server + stream + DKIM, plus dedicated IP for Pro).
- `GET /api/v1/sending/state` — per-tenant Postmark state (no secrets).
- `GET /api/v1/sending/warmup` — 30-day warmup schedule + today's cap.
- `GET/POST/PATCH/DELETE /api/v1/campaigns` — tenant-scoped campaign drafts.
- `POST /api/v1/campaigns/{id}/test-send` — pre-send safety check plus
  Listmonk transactional test send.
- `GET/POST/PATCH/DELETE /api/v1/subscribers` — tenant-scoped subscriber
  mirror with Listmonk create/suppress/delete sync.
- `POST /api/public/dodo/webhook` — Dodo Payments webhook ingest (Standard
  Webhooks signature and replay-window verified). Dispatches to
  `sending.Provisioner` on subscription create/update/delete.
- `POST /api/public/stripe/webhook` — legacy compatibility ingest for existing
  Stripe subscription records; it is not configured by the canonical production task.
- `GET /api/v1/status/public` — public status page backend; aggregates a
  60s real-time probe with 90 days of `service_health` rollups and
  published incidents from the `incidents` table.

### Production-readiness changes

- **Billing webhook → tenant provisioning**: see
  `internal/billing/dodo_webhook.go`. The Standard Webhooks verifier is
  in-package; provider-scoped idempotency is enforced via
  `billing_events.id` UPSERT. Tier transitions delegate to
  `sending.Provisioner`.
- **KMS envelope encryption**: at-rest secrets (Postmark tokens) now use
  envelope encryption (`internal/crypto/envelope.go`). The format byte
  is 0x02 for new writes; 0x01 (legacy direct AES-GCM) is still
  decryptable for backward compatibility. Production can use the
  AWS-KMS-backed envelope in `internal/crypto/kms.go`; local/test
  environments can keep using the env-backed envelope with the same
  wire format.
- **Postgres warmup tracker**: `sending.PostgresWarmupTracker` writes
  through to `sending_state.daily_sent` (jsonb) inside a tenant-scoped
  transaction so RLS fires. `MemoryWarmupTracker` remains for tests.
- **Live billing sessions**: production checkout and Customer Portal actions
  create short-lived Dodo Payments sessions using `DODO_PAYMENTS_API_KEY`.
  Checkout uses the three approved `DODO_PAYMENTS_PRODUCT_ID_*` values and the
  portal is bound to the authenticated tenant's projected Dodo customer.
  Production requires `BILLING_PROVIDER=dodo`, live mode, and an approved
  release record; it never trusts static checkout or portal URLs. The Stripe
  handler remains a compatibility path for existing/self-hosted records.
- **Status poller**: a goroutine pings each downstream service every
  minute and writes daily aggregates to `service_health`.

### Forms (Phase 3)

Tenant-scoped admin endpoints (require `Authorization` / `X-Tenant-Slug`):

- `GET    /api/v1/forms` — list forms with 30-day submission counts.
- `POST   /api/v1/forms` — create.
- `GET    /api/v1/forms/{id}` — get.
- `PATCH  /api/v1/forms/{id}` — update structure / settings / status.
- `DELETE /api/v1/forms/{id}` — delete (cascades submissions).
- `GET    /api/v1/forms/{id}/submissions` — list submissions.
- `GET    /api/v1/forms/{id}/submissions.csv` — export CSV.

Public Forms routes — NO auth, NO tenant header. Each traffic class has an
independent, distributed IP-rate-limit namespace via
`internal/middleware/RateLimit`: definition render 600/min, submit 10/min,
upload preparation 20/min, and double-opt-in confirmation 600/min. A hosted
render spike therefore cannot spend the submission anti-abuse budget. Forwarded
IP headers are honored only when the TCP peer belongs to the configured trusted
proxy CIDRs; the web renderer does not reconstruct or inject them.

- `GET  /api/public/forms/{slug}` — fetch a published form by slug.
- `POST /api/public/forms/{slug}/submit` — submission endpoint
  (honeypot + reCAPTCHA + rate limit; routes to Listmonk).
- `POST /api/public/forms/{slug}/upload-url` — tenant/form-bound private
  quarantine reservation. Exact size/MIME, cross-replica tenant quotas and
  ClamAV release rules are documented in `docs/form-upload-security.md`.
- `GET  /api/public/forms/confirm/{token}` — double-opt-in confirm link.

### Affiliate administration and dormant offer implementation

Affiliate records sit above tenants and intentionally have no tenant RLS.
Ordinary workspace owner/admin identity is therefore not valid authority for
these platform-global commercial and financial records. The dormant admin
handlers under `internal/affiliates` are not mounted or published; the desktop
ships no affiliate API client and loads no partner data. A future read surface
requires dedicated platform-operator authorization, audited PII access, strict
contracts, and separate settlement scopes.

The unauthenticated signup, tracking, and pixel handlers remain as dormant
implementation in `internal/affiliates`, but they are intentionally not mounted
or advertised in OpenAPI. No public affiliate offer is available until its
commission, payout, tax, privacy, and program terms have explicit commercial
and legal approval. Releasing any of these routes requires restoring reviewed
composition wiring, removing the matching forbidden-composition guard in
`packages/openapi/route-reachability.json`, and adding route-auth plus OpenAPI
contracts in the same change.

Affiliate attribution is also fail-closed. Public checkout does not forward an
affiliate cookie into Stripe metadata, the canonical billing webhook has no
affiliate attribution or reversal adapter, and the legacy
`/api/internal/stripe/webhook` route is not mounted or published. Dormant
implementation under `internal/affiliates` is not an operational commercial
offer. Historical exceptions require an explicit reconciliation workflow;
values encoded in `CommissionFor()` are implementation defaults only, not
published or approved commercial terms.

### Subscribers and campaigns

Moosewave owns tenant-scoped `subscribers` and `campaigns` mirror tables behind
RLS. Subscriber creates/suppression/deletes synchronize with Listmonk over HTTP;
campaign drafts remain Moosewave-owned until full audience-send orchestration
promotes them into the send engine. Test sends are live and route through the
safety service first.

### Listmonk client

`internal/listmonk` is the only place the gateway holds a Listmonk-aware
HTTP client. It does NOT import any `github.com/.../listmonk` Go package —
per `LICENSE-BOUNDARY.md` the network boundary is the rule. Domain
packages depend on the `listmonk.Doer` interface; tests inject fakes.

## Sending tier infra (`internal/sending/`)

When a tenant upgrades to Sending or Pro, `Provisioner.ProvisionTenant`:

1. Calls Postmark `POST /servers` to create a sub-account; captures the
   first `ApiToken` as the per-tenant SMTP token.
2. Calls `POST /servers/{id}/message-streams` to create the broadcasts stream.
3. Computes the per-tenant DKIM subdomain `<slug>.<DKIM_ROOT_DOMAIN>`.
4. Envelope-encrypts the SMTP token. Production prefers AWS KMS
   (`POSTWAVE_KMS_KEY_ID`); local/test environments can fall back to
   `POSTWAVE_SENDING_KEK` while preserving decryptability for legacy rows.
5. Upserts the `sending_state` row (RLS-isolated per tenant).
6. **Pro only:** rents a dedicated IP via Postmark and starts the 30-day IP
   warmup schedule. Sending tier shares the pool but isolates reputation via
   per-tenant DKIM.

### IP warmup

`WarmupSchedule` encodes the canonical 30-day curve (50 → 2M/day).
`EnforceCap(tenant, intended, now)` returns `(allowed, deferred)` honoring
both the day's curve cap and a per-tier ceiling. The tracker is
`PostgresWarmupTracker` in the gateway; it reads/writes
`sending_state.daily_sent`, `tier_limit`, and `warmup_day` in a tenant-scoped tx.

### Provisioning lifecycle

```
Dodo webhook ─► billing.DodoWebhookHandler
                              │
                              ▼
                    Provisioner.ProvisionTenant
                       │     │       │
              Postmark │     │ Repo  │ DedicatedIPProvisioner (pro)
              create   │     │ upsert│ rent IP + start warmup
                       ▼
              sending_state row (RLS, encrypted token)
```

Downgrade / churn → `DeprovisionTenant` deletes the local row. Postmark
server retention + dedicated-IP release are scheduled through the
`sending_deprovision_jobs` queue and processed after the 30-day grace timer.

## Layout

- `main.go` — server lifecycle, middleware, routing.
- `internal/config` — env-loaded `Config`.
- `internal/handlers` — HTTP handlers.
- `internal/middleware` — slog request logger.
- `internal/sending` — Postmark client, warmup, provisioner.

## Layout

- `main.go` — server lifecycle, middleware, routing.
- `internal/config` — env-loaded `Config`.
- `internal/handlers` — HTTP handlers.
- `internal/middleware` — slog request logger.
