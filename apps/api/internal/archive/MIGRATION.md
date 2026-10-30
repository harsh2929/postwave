# archive-recommendations-network — migration recipe

Cross-tenant editorial Recommendations Network for the public archive
(Phase 3 gap feature, P2, XL). This document captures the architecture
sketch, what shipped, and what's explicitly deferred for the human
engineer who picks up the multi-week portion.

Inspired by 2026 SOTA:

- **Substack** (`/publish/recommendations`) — drove 32M+ in-app
  subscriptions in Q4 2025. Network is opt-in; recommendations render
  on every issue page, on the publication homepage, and on the
  subscribe-confirmation interstitial.
- **beehiiv** ("Boosts" + Top-4 panel) — a top-4 acquisition channel
  for major publishers; explicit `subscribe_url` per row.
- **Ghost** (`/dashboard/recommendations` + Webmention parser) — pulls
  open-web mentions via Webmention into the same UI as in-app
  recommendations.

## Architecture sketch (words, not ASCII art)

There are three surfaces and one async worker.

**Public surface** — `GET /api/public/archive/{slug}/recommendations`
returns up to 6 active rows in `position` order; the click endpoint
`GET .../recommendations/{id}/click` records a row in
`recommendation_clicks` and 302s to the canonical URL. Cache-Control is
`public, max-age=300` (mirrors the related-issues endpoint cache so a
single archive page can fan out without thundering-herding the DB).

**Admin surface** — `GET/POST/DELETE /api/v1/admin/archive/recommendations`
behind `apikeys.ScopeAdmin`. The list response folds in `clickCount30d`
via a LEFT JOIN onto `recommendation_clicks`. The upsert enforces a
per-tenant cap (`RecommendationsAdminCap = 50`), label/desc/URL length
caps, and refuses self-recommendation (host-match against the tenant's
own `archive_domain`).

**Open-web receiver** — `POST /api/public/webmention` accepts the W3C
Webmention `(source, target)` form-encoded (or JSON) payload, maps the
target host to a tenant via `tenant_public_settings.archive_domain`,
queues a row in `webmentions_inbox` with `status='pending'`, returns
202 unconditionally (spec requires we not leak target existence).

**Async parser worker** (`webmention_worker.go`) — drains
the inbox in `FOR UPDATE SKIP LOCKED` batches, asks `WebmentionParser`
to fetch the source HTML, verify the target link, and extract h-card
author info, then transitions inbox rows to `parsed` / `rejected`.
Bookkeeping rows in `webmention_parser_runs` power a /healthz tile.

## Tables (migrations 0286 + 0342)

- **0286** (already shipped):
  - `tenant_recommendations` — per-tenant ordered list. Uniqueness on
    `(tenant_id, to_url)`. RLS on `tenant_id` GUC. `to_tenant_id`
    nullable for the future in-network resolver.
  - `recommendation_clicks` — append-only click event log; salted-day
    `anon_visitor_id`; never PII.
  - `webmentions_inbox` — open-web receiver queue; nullable `tenant_id`
    for orphan payloads (rows that don't match an archive_domain).
- **0342** (this scaffold's additive layer):
  - `webmention_parser_runs` — worker run state for the /healthz tile.
  - `recommendation_conversions` — append-only conversion log, joined
    back to click rows when attribution is available.
  - `recommendation_network_peers` — federation opt-in registry. Hosts
    that have published a signed `/.well-known/postwave-recommendations.json`
    manifest get promoted to one-click in-app subscribes.
  - `tenant_recommendations.subscribe_url` — optional one-click
    subscribe override for the CTA button (beehiiv pattern).
  - `tenant_recommendations.discovered_at` — auto-discovery timestamp
    for the "auto-upgraded N days ago" admin badge.

## What's shipped today

1. Full data model (migrations 0286 + 0342 — RLS + FK + indexes per
   project idioms; NULLIF GUC pattern throughout).
2. Repo CRUD + click recording (`recommendations.go`).
3. Public + admin + webmention HTTP handlers, all mounted from
   `main.go` (`MountRecommendationsPublicRoutes` + `MountRecommendationsAdminRoutes`).
4. Webmention receiver enqueues to `webmentions_inbox` (idempotent
   re-POSTs via `ON CONFLICT DO UPDATE`).
5. Async worker (`webmention_worker.go`) — loop, batch claim via
   `FOR UPDATE SKIP LOCKED`, run-row bookkeeping, and the concrete
   SSRF-guarded HTTP parser in `webmention_parser.go`. A missing parser
   stops the worker visibly instead of becoming a successful no-op.

## What's explicitly deferred

The multi-week portion lives in five mostly-independent workstreams.
Each is sized so they can be picked up in parallel by separate
engineers.

### A. Webmention source-page parser (shipped)

`webmention_parser.go` fetches source pages through a constrained,
SSRF-guarded HTTP client, verifies the target link, extracts author/title
metadata, and distinguishes retryable source failures from rejections.

### B. Cross-tenant discovery job (~1–1.5 weeks)

Periodic sweep that, for every `tenant_recommendations.to_url` with
`to_tenant_id IS NULL`, looks up the host in
`recommendation_network_peers` and (when matched) populates
`to_tenant_id` + `discovered_at`. Companion: the manifest fetcher that
populates the peer registry from `/.well-known/postwave-recommendations.json`.

Also: design + sign the manifest format (publication_id, expires_at,
signature). Mirror Substack's opt-in flow exactly — operator clicks
"join the network" in the dashboard, we generate the manifest, they
host it at the well-known URL, we verify on first crawl.

### C. Conversion attribution closure (~3–5 days)

Public renderer change to append `?rcid=<click_id>` on the 302 target
(the new column is already in place per the worker contract). Then:
a new public endpoint `/api/public/recommendations/conversion?rcid=...`
that records a row in `recommendation_conversions`. For in-network
targets, hook the receiving tenant's subscribe-confirm path so this
fires on double-opt-in confirm. For open-web targets, ship an embed
pixel + JS snippet that publications can include on their
subscribe-confirm page.

### D. ML ranking / "Recommended for you" personalization (~2 weeks)

Today the public surface returns rows in operator-ordered `position`
order. The XL ambition is per-visitor personalized ordering driven by
a recommender model — Substack's `New From Network` and beehiiv's Top
4 both personalize. Scaffold left so a future
`ranker.Score(visitor_id, candidate_recommendations) → sorted` can be
swapped in. Initial model can be collaborative filtering over the
`recommendation_clicks` event log; vendor swap-in (AWS Personalize,
Pinecone) is a future call but the interface above is vendor-neutral.

### E. Reciprocal-recommendations admin UI (~3–5 days)

The reverse index (`tenant_recommendations_to_tenant_idx`) supports
"N publications recommend you". Build the slideover tile + the email
"Foo just recommended you" notification. Pure desktop + email work,
no schema change.

## Sub-task parallelism

| Workstream | Depends on | Can start now |
| --- | --- | --- |
| A — parser | none | yes |
| B — discovery + peers | none (manifest design can run in parallel) | yes |
| C — conversion attribution | needs renderer change shipped | yes (the back end is independent) |
| D — ML ranker | needs click event log to accumulate (~4 weeks of traffic) | scaffold yes, train later |
| E — reciprocal UI | needs B at least partially (to_tenant_id populated) | UI-only scaffold yes |

## Estimated remaining effort

| | engineer-weeks |
| --- | --- |
| A (parser) | 1.0 |
| B (discovery + manifest) | 1.5 |
| C (conversion attribution) | 0.5 |
| D (ranker, model + integration) | 2.0 |
| E (reciprocal UI) | 0.5 |
| **Total** | **~5.5 engineer-weeks** with most parallelizable. |

## Cross-references

- `recommendations.go` — Repo methods + HTTP handlers
- `webmention_worker.go` — worker loop + parser interface
- `0286_archive_recommendations_network.sql` — base tables
- `0342_archive_recommendations_network.sql` — additive scaffolding
  for the deferred work (parser runs, conversions, peers, columns)
