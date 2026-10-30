# Campaigns 2026 — implementation status

The original 8-item shortlist (G2/G3/G5/G7/G10/G11/G16/G17) shipped as
backbones in an earlier batch. This update closes out **all 20 gaps from
`gap-analysis.json`** — the 6 in-flight follow-ups plus the 14
backlog gaps — on branch `feat/campaigns-2026-followups`.

## Reconciliation first (don't trust this doc's old horizon)

Before building, every item was reconciled against the *actual* code (a
20-item recon pass, adversarially verified). That mattered: the repo had
advanced well past this doc's old 0260–0263 horizon, so several "remaining"
parts were already built and would have been double-implemented:

- **G16** — frequency-cap admin UI was **already fully shipped**
  (`FrequencyCapsCard.tsx`); no work needed.
- **G3** — the LLM intent classifier was **already done** (`intent.go`);
  only the quote-block + intent tabs + single-reply GET remained.
- **G17** — the voice round-trip was **already wired** (not deterministic-
  only); only the cap/guards/audit/actions remained.
- **G5** — the PSTO scheduler/stager **already existed**; the gap was a
  missing `MountPSTO` call (a dead route), not a worker to build.
- **G8** — the 10-client render service was **already wired**; only the
  frontend tab remained.

## Shipped this batch (19 commits — G16 was already done)

| Commit | ID | Title |
| --- | --- | --- |
| `6b62b869` | G5 | Mount PSTO toggle + read-back send window + 1h floor + audit |
| `52d06f38` | G11 | Subject Lab Wilson-90% matched-bucket scoring + opt-in flag + voice prefetch |
| `356ccec8` | G10 | Brand-voice binding: merge-tag guardrail + ProfileID + profile-aware drift |
| `b3f586ee` | G17 | AI summary regenerate cap + status guard + admin-force + audit + action buttons |
| `b649215c` | G3 | Reply-loop intent tabs + single-reply GET + quote-a-reply block |
| `a7d410c1` | G9 | Reading-time pill + preview-text field + inbox-row mock |
| `5e42bc4f` | G21 | Web-archive URL surfacing + auto-derived og:image |
| `ea011d63` | G8 | Cross-client inbox preview tab (frontend; backend already shipped) |
| `a9e6fe76` | G22 | Preview as specific subscriber (merge tags + {% if %} + regions) |
| `9b7c4779` | G12 | Bulk row actions (delete/move/CSV) + sortable columns |
| `dfdb5905` | G1 | Per-campaign hourly engagement time-series + sparklines + chart |
| `77604701` | G15 | Per-campaign conversion goal + attribution window + goal-results |
| `c7489a64` | G13 | Calendar view + drag-to-reschedule |
| `902b09ee` | G18 | Per-campaign hourly anomaly detection (z-score) |
| `f976252c` | G4 | Multi-armed bandit A/B allocation (Thompson + epsilon-greedy) |
| `bcf20e94` | G14 | Multivariate A/B (subject × from × body × send-time, ≤8 combos) |
| `feb3a5ab` | G20 | Multi-stage ordered approval chain |
| `18b83281` | G6 | Audience mode (static/dynamic) + audience count endpoint |
| `9212135a` | G19 | Per-campaign multi-language variant matrix |

Migrations added: **1401–1405** (conversion goal, ab bandit, approval
chain, audience mode, campaign translations).

## Follow-up batch — shipped (9 clusters, migrations 1403–1408)

The deferred deepening work landed in a second pass (each committed,
`go build`/`go test`/`tsc` green; verified across apps/api + services/voice):

| Commit area | ID | What shipped |
| --- | --- | --- |
| settings UI | G20 | Approval chain-config admin panel (define/reorder roles) |
| campaigns | G12 | Campaign org-tags (mig 1406) + bulk Tag toolbar action |
| inbound/config | G3 | Auto-classify replies on ingest (goroutine) + `POSTWAVE_DISABLE_REPLY_LOOP` kill-switch |
| brand_voice/main | G10 | `/voice/drift` proxy → enriching handler injecting authored descriptors + banned-terms (derived from writing rules) |
| analytics | G18 | Persisted `campaign_anomalies` (mig 1407) + live `anomaly` SSE event on delta |
| abtests/campaigns | G14 | `send_time_offset_minutes` parsed/exposed on the variant config + from-name axis input in create modal |
| abtests | G4 | `WeightHistory` endpoint + allocation-drift MultiLineChart in the A/B Results modal |
| campaigns | G6 | Static-audience freeze (mig 1408 + `FreezeCampaignAudience` into `segment_static_freezes`) + queue-fill sends to the frozen membership; "Freeze now" button |
| campaign_translations | G19 | `ResolveForLocale` routing helper (exact→language→default) + per-locale report endpoint + "By language" breakdown |

### Remaining (smaller, hot-path or split-brain — explicitly noted)

- **G14/G19** — applying `send_time_offset` to AB-child dispatch timing
  and wiring `ResolveForLocale` into the hot send loop both touch the
  send pipeline; the parse/expose + routing logic + report are in place.
- **G4** — bridging the desktop's native equal-split ab-test create
  (`delivery_settings`) onto the weight-based bandit's
  `campaign_ab_settings` (pre-existing two-A/B-system split). Bandit is
  configurable via the abtests `SetSettings` endpoint today.
- **G18** — trailing-90d cross-campaign baseline + frontend consumption
  of the live `anomaly` SSE event (the strip loads via the endpoint).
- **G6** — full segment/list + exclusion picker in the create modal.
- **G12** — surfacing org-tags as row chips + a tag filter on the list.

## Verification

`go build ./...` (apps/api + services/voice) clean; `pnpm tsc --noEmit`
clean (0 errors); per-feature Go unit tests added and green across
campaigns / subject_lab / aicompose / campaign_summary / campaign_replies
/ analytics / abtests / approvals / archive / campaign_translations.
