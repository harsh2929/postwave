# services/deliverability — Pillar 2 (Inbox Reality)

Owns the Inbox Reality dashboard: configured controlled-seed polling, reputation
aggregation, auth-record validation, the Gemini-powered AI Diagnostician
with eval harness, and the Pre-Send Predictor. This AGPL-3.0-only service
speaks to the separately running upstream Listmonk process **only over HTTP**,
per `LICENSE-BOUNDARY.md`. No `import` of any Listmonk package, ever.

## Layout

```
services/deliverability/
├── main.go                    # entrypoint; wires layers + chi routes
├── seedlist.yaml              # local/dev seedlist sample; production supplies real IMAP/vendor config
└── internal/
    ├── config/                # env-driven Config
    ├── domain/                # shared types (InboxReport, Diagnosis, ...)
    ├── seedlist/              # Layer 1 — IMAP poller + categorizers
    │   └── categorizers/      # one file per provider (gmail/outlook/...)
    ├── reputation/            # Layer 2 — Source adapter + aggregator
    │   ├── postmaster/        # Google Postmaster Tools
    │   ├── snds/              # Microsoft SNDS
    │   ├── senderscore/       # Validity SenderScore
    │   └── blacklist/         # DNSBL queries (Spamhaus, SORBS, ...)
    ├── auth/                  # Layer 3 — SPF/DKIM/DMARC/BIMI/PTR + DMARC reports
    ├── content/               # Layer 4 — spam score, image ratio, links, HTML
    ├── diagnostician/         # Layer 5 — Gemini 3 Pro rubric loader + eval harness
    │   └── eval/              # cases + grader; production prompt pack is external
    ├── predictor/             # Pre-Send Predictor (Gemini 3 Flash-augmented heuristic)
    └── handlers/              # HTTP wiring
```

## Five layers

| Layer | Package | Status |
|---|---|---|
| **1 — Seedlist** | `internal/seedlist` | Registry parses YAML or inline JSON seed inbox config; poller goroutines run; production can use real IMAP polling (`SEEDLIST_CONNECTOR=imap`) or a normalized vendor API (`SEEDLIST_CONNECTOR=vendor`). IMAP uses a selected-header fast path followed by bounded `BODY.PEEK[]` capture for tagged messages and never changes `\Seen`; vendor raw-MIME capability is explicitly unavailable. Placement reports write to Postgres (`seedlist_outcomes`) when `DATABASE_URL` is wired, with in-memory local fallback only outside production. Encrypted raw-MIME persistence remains deliberately separate pending Inbox Reality consolidation. |
| **2 — Reputation** | `internal/reputation` | DNSBL source is fully functional (no auth required). Postmaster, SNDS, and SenderScore adapters are wired and become active when their credentials/env are present. Aggregator merges concurrently and caches per-domain for 24h. |
| **3 — Auth validation** | `internal/auth` | SPF/DKIM/DMARC/BIMI/PTR all fully implemented behind a `Resolver` interface. DMARC aggregate-report parser, IMAP poller, send-domain tenant resolver, and Postgres storage are wired; production still needs real mailbox credentials. |
| **4 — Content** | `internal/content` | Calibrated logistic-style SpamScore over ~80 trigger-word weights + structural features (caps ratio, exclamation density, image/text ratio, link density, subject length, all-caps words, suspicious-link count). Default weights derived from public deliverability data; override via `SPAM_WEIGHTS_PATH`. Real `LinkReputation` queries URIBL `multi.uribl.com` and SURBL `multi.surbl.org` concurrently with a 2s timeout via the `Resolver` interface. `AnalyzeHTMLQuality` covers missing alt, mismatched tags, hidden text (`color:#fff`), tiny text (`font-size<8px`), `display:none` with content, encoded-character obfuscation, inline-CSS heaviness. |
| **5 — Diagnostician** | `internal/diagnostician` | System prompt = rubric (`prompts/system.md`) + 5-example few-shot block (`prompts/few_shot.md`) + a final self-check. Post-response `ValidateDiagnosis` re-checks the four hard constraints (action enum, ≤0.85 impact sum, ≤0.40 per-fix, predicted_impact in [0,1]); on violation the Diagnostician issues a single targeted retry. 24h fingerprint cache. Eval harness loads 40 cases; `RunWithOptions(BaselineDir: ...)` enables structural baseline grading. Calls `gemini-3.1-pro-preview` via the hand-rolled `GeminiClient` (no SDK dependency). |
| **5b — Predictor** | `internal/predictor` | Real heuristic combining `0.40·content + 0.30·reputation + 0.15·auth + 0.15·engagement`, mapped through a piecewise interpolation calibrated to: risk=0 → {0.85, 0.13, 0.02}, risk=0.5 → {0.50, 0.30, 0.20}, risk=1 → {0.05, 0.30, 0.65}. Gemini Flash (`gemini-3-flash-preview`) second-opinion is env-gated (`PREDICTOR_USE_LLM=1`); base prediction works without LLM. |

## HTTP routes

Non-health routes are sidecar-internal. Set `POSTWAVE_INTERNAL_API_TOKEN`
in deployed environments; callers must send `Authorization: Bearer <token>`.
When unset, non-health routes only accept loopback requests for local dev.

| Method | Path | Description |
|---|---|---|
| `GET`  | `/health` | liveness |
| `GET`  | `/v1/inbox-reality/campaigns/{id}` | aggregated `CampaignReport` |
| `GET`  | `/v1/reputation` | merged `Reputation` for tenant primary domain |
| `GET`  | `/v1/auth-checks` | SPF/DKIM/DMARC/BIMI/PTR for tenant primary domain |
| `POST` | `/v1/diagnose/{campaign_id}` | run Diagnostician with provided `Signals` body |
| `POST` | `/v1/predict` | `{html, subject, reputation, history, auth?, links}` → `PredictedPlacement` + risk/model disclosure |
| `POST` | `/v1/render` | `{html, environments?}` → `{renders[], cache_hit, render_mode}` browser mailbox simulations (`render_mode` is `simulation` or `placeholder`, never a real mailbox capture) |

Tenant resolution is gateway-header based. The `CampaignReport` store is
Postgres-backed in production (`seedlist_outcomes`), while dev/CI keep the
process-local memory store for zero-credential startup.

Seed-list test messages must carry `X-Postwave-Test-ID`. Production senders
should use either `tenant_id:campaign_id`, `tenant_id|campaign_id`, or
`{"tenant_id":"...","campaign_id":"..."}` so the poller can write
tenant-scoped rows. A bare campaign id is accepted only for local/demo mode.

## Cross-client rendering (`internal/render`)

`POST /v1/render` produces a screenshot per mailbox environment plus a
list of static-check findings (features that will silently break even
when the screenshot looks fine). Screenshots use HTMLCSStoImage (HCTI).
When `HCTI_USER_ID` and `HCTI_API_KEY` are set, the real client wires
in; otherwise the service falls back to `MockRenderer` (placehold.co
URLs) so dev and CI exercise the full UI without an HCTI account.

The 10 production environments — exactly the cohort the editor's
"Clients" tab grids:

| Name | Viewport | Notes |
|---|---|---|
| `outlook_2019_desktop` | 900×1200 | Word HTML engine; no flex/grid/SVG/border-radius/@media |
| `outlook_365_web` | 1024×1400 | Modern; drops `position:absolute` in body |
| `outlook_macos` | 900×1200 | WebKit-based; drops most `@media` queries |
| `apple_mail_macos_light` | 1024×1400 | Permissive; blocks `@font-face` |
| `apple_mail_macos_dark` | 1024×1400 | Auto-inverts colors when `color-scheme` not declared |
| `apple_mail_ios` | 390×844 | Same engine as macOS, narrow viewport |
| `gmail_web_promotions` | 1024×1400 | Image-heavy + trigger words → Promotions tab |
| `gmail_ios` | 390×844 | Strips `<style>` blocks > ~16KB |
| `yahoo_web` | 1024×1400 | Strips `display:flex` / `display:grid` |
| `proton_mail_web` | 1024×1400 | Blocks remote images by default; strips trackers |

Caching: 24h keyed by `sha256(env_name || html)`. Production wires the
Postgres-backed `render_cache` table when `DATABASE_URL` is available, while
local/dev keeps an in-process fallback. The handler sets `cache_hit: true`
only when *every* requested environment is already cached. The cache stores
render metadata and HCTI image URLs, not raw campaign HTML.

## Configuration

All secrets are env-driven. See `internal/config/config.go`. Seedlist
passwords reference per-mailbox env vars named in the YAML/JSON registry
(e.g. `SEED_GMAIL_001_PASSWORD`) so the registry can be checked in or stored
as a secret without embedding mailbox passwords.

| Env var | Wired into |
|---|---|
| `PORT` | HTTP listener |
| `LOG_LEVEL` | slog |
| `POSTWAVE_INTERNAL_API_TOKEN` | bearer token for non-health routes |
| `GEMINI_API_KEY` | Diagnostician (Gemini 3 Pro) + optional Predictor blend (Gemini 3 Flash). `ANTHROPIC_API_KEY` is accepted for one deploy cycle with a deprecation warn. |
| `GOOGLE_POSTMASTER_CREDENTIALS` | Postmaster source (active when set) |
| `MICROSOFT_SNDS_KEY` | SNDS source (active when set) |
| `VALIDITY_SENDERSCORE_KEY` | SenderScore source (active when set) |
| `DIAGNOSTICIAN_PROMPTS_PATH` | Production prompt pack directory containing `system.md` and `few_shot.md`; required in production. |
| `DIAGNOSTICIAN_EVAL_CASES_PATH` | Checked eval corpus used as the release gate; required in production. |
| `SEEDLIST_CONNECTOR` | `imap`, `vendor`, or `nop`. Production must use `imap` or `vendor`. |
| `SEEDLIST_CONFIG_PATH` | YAML or JSON seedlist registry path. |
| `POSTWAVE_SEEDLIST_IMAP_JSON` | Inline JSON seedlist registry; overrides `SEEDLIST_CONFIG_PATH`. |
| `POSTWAVE_ENABLE_DURABLE_SEED_REGISTRY` | Publishes the exact secret-reference-only registry revision before polling/dispatch. Feature-on requires migration 1930 and rejects plaintext mailbox credentials; defaults off for rolling compatibility. |
| `SEEDLIST_IMAP_FOLDERS` | Comma-separated folders to poll for seed messages. Defaults cover common inbox/spam/category folders. |
| `SEEDLIST_IMAP_MARK_SEEN` | Deprecated and ignored. Seed acquisition never marks a message Seen. |
| `SEEDLIST_IMAP_MAX_MIME_BYTES` | Maximum raw MIME bytes retained per tagged message. Defaults to 10 MiB; invalid values or values above the 50 MiB safety ceiling fall back to the default. |
| `SEEDLIST_VENDOR_API_URL` | Normalized seedlist vendor/proxy endpoint when `SEEDLIST_CONNECTOR=vendor`. |
| `SEEDLIST_VENDOR_API_KEY` | Optional bearer token for the seedlist vendor/proxy endpoint. |
| `SEED_<PROVIDER>_<N>_PASSWORD` | per-inbox IMAP password |
| `HCTI_USER_ID` | HCTI Basic-auth user (cross-client render) |
| `HCTI_API_KEY` | HCTI Basic-auth key (cross-client render) |

## What's stubbed vs wired

**Wired (compiles + tested):**
- Domain types, registry, categorizers (8), poller goroutine lifecycle, DNS
  blacklist queries, real seedlist IMAP polling, seedlist vendor API adapter,
  Postgres-backed seedlist report store, full SPF/DKIM/DMARC/BIMI/PTR
  resolution, DMARC aggregate XML parsing, content scanner, predictor
  heuristic, Diagnostician prompt and cache, eval harness, all HTTP handlers,
  chi mount.

## Diagnostician few-shot + eval expectations

The system prompt sent to Gemini 3 Pro is rubric + 5 worked examples
(auth-fail SPF, image-heavy promo, mixed-signal stack, post-recovery,
low-engagement Promotions) + a final self-check that re-asserts the
four hard constraints. Each example pairs a realistic Signals payload
with the expected Diagnosis JSON. Combined with the post-response
validator + single retry, the pipeline is designed to clear the
40-case eval at ≥85% with `gemini-3.1-pro-preview`. Failures should
cluster in a single bucket (e.g. provider-specific) and surface there
explicitly via `eval.Report()`.

### Models and pricing

| Component | Model | Approx pricing (per 1M tokens) |
|---|---|---|
| Diagnostician | `gemini-3.1-pro-preview` | ~$2.00 input / ~$12.00 output (cheaper than Claude Sonnet) |
| Predictor (LLM blend) | `gemini-3-flash-preview` | ~$0.50 input / ~$3.00 output |

The hand-rolled `GeminiClient` posts to
`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with an `x-goog-api-key` header and retries 429/5xx with jittered
exponential backoff. There is no SDK dependency — the REST surface is
small enough to maintain in-tree.

**Stubbed or operator-gated:**
- Local/dev seedlist `NopConnector`; production refuses `nop` and requires
  `imap` or `vendor`.
- Provider-backed `HealthSender` (requires sending-provider credentials)
- Postmaster / SNDS / SenderScore network sources (enabled only with provider credentials)
- Predictor's Gemini Flash second-opinion blend (LLM ptr unset)
- Tenant metadata lookup from Postgres (currently gateway-header based)

## Tests

```
go test ./...
```

Tests use mocked resolvers and mocked LLM clients — no network required.
