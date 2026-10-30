# ROADMAP-WRAPPERS — desktop api-client manifest (2026-06)

Typed wrappers for the roadmap build-tier backend features, plus the
four packages the previous audit missed (Task-2 verdicts at the
bottom). Every shape below was **verified against the Go handlers**
(file references per section), not just the implementers' reports.

- All wrappers live in `src/lib/api-client.ts` under the
  `Roadmap build-tier wrappers (2026-06 follow-up)` banner (plus three
  additive type extensions to existing surfaces, noted inline).
- All wrappers return `ApiResult<T>` (`{data} | {error}` — no throw).
- Wire-shape tests: `src/__tests__/lib/api-client-roadmap.test.ts`
  (23 tests across 14 wrappers).

---

## R1 — Feed sources (`apps/api/internal/feed_ingest`)

**Export:** `feedSourcesApi` — `list / create / get / update / remove / poll / listRuns`
**Types:** `FeedSource`, `FeedSourceCreateInput`, `FeedSourceUpdateInput`, `FeedPollResult`, `FeedIngestRun`

| Call                | Route                           | Response                    |
| ------------------- | ------------------------------- | --------------------------- |
| `list()`            | `GET /api/v1/feed-sources`      | `{items: FeedSource[]}`     |
| `create(input)`     | `POST /api/v1/feed-sources`     | 201 `FeedSource`            |
| `get(id)`           | `GET /api/v1/feed-sources/{id}` | `FeedSource`                |
| `update(id, patch)` | `PATCH …/{id}`                  | `FeedSource`                |
| `remove(id)`        | `DELETE …/{id}`                 | **204** (`data: undefined`) |
| `poll(id)`          | `POST …/{id}/poll`              | 200 `FeedPollResult`        |
| `listRuns(id)`      | `GET …/{id}/runs`               | `{items: FeedIngestRun[]}`  |

Shape notes:

- `FeedSource.schedule` is `"manual" | "daily" | "weekly"` (no monthly).
- **A failed poll is still HTTP 200** with `status:"failed"` + `error`
  text — branch on `data.status`, never on the ApiResult error path.
  503 `poller_unavailable` when the server runs without a poller.
- `poll()` is synchronous-bounded server-side → 30 s timeout,
  fire-once, `requireOnline` (it mints draft campaigns).
- Validation errors: 400 `invalid_input` (message verbatim); 404
  `not_found`. Scopes: reads `read:campaigns`, writes + poll
  `write:campaigns`.

## R2 — Engagement scores (`apps/api/internal/subscriberscore/http.go`)

**Export:** `engagementScoresApi` — `get / distribution / subscribers`
**Types:** `EngagementScoreResponse`, `EngagementScoreBucket`, `EngagementScoreSubscriber`

- `get(subscriberId)` → `GET /api/v1/subscribers/{id}/engagement-score`
  → `{score: number|null, computed_at?}` (`score:null` = never
  computed; 404 = unknown subscriber).
- `distribution()` → `GET /api/v1/engagement-scores/distribution` →
  `{buckets: [{range,min,max,count}]}`.
- `subscribers({min,max,page,perPage})` →
  `GET /api/v1/engagement-scores/subscribers?min=&max=&page=&per_page=`
  → `{items: [{id,email,score}], total, page, per_page}` (page/per_page
  echoed back clamped). 400 codes: `bad_min`/`bad_max`/`bad_range`/
  `bad_page`/`bad_per_page`.

## R3 — Analytics extras (`apps/api/internal/analytics/{template_leaderboard,fatigue,cross_channel_timeline}.go`)

**Export:** `analyticsExtrasApi` — `templateLeaderboard / fatigue / crossChannelTimeline`
**Types:** `TemplateLeaderboardItem`, `FatigueDecile`, `CrossChannelTimelineItem`, `CrossChannelTimelineResponse`

- `templateLeaderboard({days})` (default 90) → `{items}`; rates are
  0..1 fractions.
- `fatigue({days})` (default 30) → `{deciles: [{sends_bucket,
subscribers, open_rate, unsub_rate}]}` — **the decile rows carry a
  `sends_bucket` label, not a generic range field**.
- `crossChannelTimeline(idOrEmail, {limit, before})` →
  `GET /api/v1/subscribers/{id}/cross-channel-timeline` →
  `{items: [{at, channel, type, label, campaign_id?, detail?}],
has_more, next_before?}`; `channel` is `"email" | "sms"`; `before`
  is RFC3339(Nano); 404 for unknown subscriber.

## R4 — Revenue attribution (`apps/api/internal/conversions/attribution.go`)

**Export:** `revenueAttributionApi` — `campaigns / timeseries`
**Types:** `RevenueAttributionItem`, `RevenueCurrencyTotal`, `CampaignAttributionResponse`, `RevenueTimeseriesPoint`, `RevenueTimeseriesResponse`

- `campaigns({days})` → `{items, total_revenue_cents,
unattributed_cents, unattributed_conversions, currency?, currencies,
days}`. Top-50 campaigns; the remainder rolls into one item with
  `campaign_id: ""` and `campaign_name: "(other campaigns)"`.
  `revenue_per_send_cents` is absent on the rollup / zero-send rows.
  `currency` is the dominant currency, empty when totals span several
  (then read `currencies`).
- Sequence attribution is outside the current API contract because conversion
  rows have no sequence linkage. The UI states this limitation without issuing
  a request to a placeholder route.
- `timeseries({days, campaignId})` → `{points: [{date(YYYY-MM-DD),
revenue_cents, conversions}], currency?, currencies, days,
campaign_id?}` — **zero-filled** (no date gaps). `campaign_id` must
  be a UUID (400 `bad_campaign_id` otherwise).

## R5 — Agent routines (`apps/api/internal/agent_routines`)

**Export:** `agentRoutinesApi` — `list / create / get / update / remove / run / listRuns`
**Types:** `AgentRoutine`, `AgentRoutineCreateInput`, `AgentRoutinePatch`, `AgentRoutineRun`, `AgentRoutineKind`, `AgentRoutineSchedule`

- `kind`: `"draft_campaign" | "draft_sequence"` — **immutable after
  create** (PATCH has no kind field).
- `schedule`: `"manual" | "daily" | "weekly" | "monthly"` (+ free-form
  `schedule_detail` object). Routines also carry `target_list_id?`,
  `target_segment_id?`, `require_approval`, `enabled`, `last_run_at?`.
- `list()` / `listRuns(id)` → `{items}` envelopes.
- `run(id)` → **202** `{run_id, status:"running"}`; execution continues
  server-side (poll `listRuns`). Fire-once + requireOnline (each run
  invokes an LLM). Runs carry `output_kind?`, `output_ref?`,
  `approval_id?`, `error?`, `started_at`, `finished_at?`.
- Typed errors: **422 `invalid_routine`**, **409 `name_taken`**.

## R6 — Analytics NLQ + anomaly brief (`apps/api/internal/nql/{analytics_nlq,anomaly_brief}.go`)

**Export:** `analyticsNlqApi` — `query / anomalyBrief`; constant `ANOMALY_BRIEF_METRICS`
**Types:** `AnalyticsNlqResponse`, `AnalyticsNlqParams`, `AnalyticsNlqTrace`, `AnomalyBriefMetric`, `AnomalyBriefAggregates`, `AnomalyBriefResponse`

- `query(question)` → POST `/api/v1/analytics/nlq` `{question}` →
  `{question, answer_kind: "table"|"summary", template, params
{window_days, limit}, columns, rows, summary_text, trace}`.
  **Deviation:** the Go file's doc comment mentions `cost_status` but
  the response struct does NOT include it — not typed.
- `anomalyBrief({metric, window_days, context?})` → `{metric,
window_days, summary, probable_causes[], suggested_actions[],
aggregates {current_total, previous_total, daily, top_campaigns},
trace}`. Metric whitelist (422 `invalid_metric` otherwise):
  `opens | clicks | bounces | complaints | unsubscribes | revenue`.
  Server also accepts a `window` alias for `window_days` (not typed —
  use `window_days`).
- Both use `LLM_REQUEST_OPTS` (60 s, fire-once). 503
  `nlq_unavailable` without `ANTHROPIC_API_KEY`; 429
  `cost_cap_exceeded` when the daily token budget is spent.

## R7 — Voice roadmap (`services/voice/internal/handlers/{variant_assignment,stuck,template_generate}.go`)

**Export:** `voiceRoadmapApi` — `getStepVariant / listStuckParticipants / generateTemplate`
**Types:** `SequenceStepVariantAssignment`, `SequenceStuckParticipant`, `SequenceStuckResponse`, `VoiceGeneratedTemplate`

- `getStepVariant(seqId, position, subscriberId)` →
  `POST /api/v1/voice/sequences/{id}/steps/{position}/variant`
  with `{subscriber_id}` in the JSON body
  → `{variant_key, subject, body, body_html?, weight_bp}`.
  **Deviation:** the resolved arm comes back as `variant_key`, NOT the
  stored variant's `key`. Pure deterministic hash — no state written;
  `position` addresses the TOP-LEVEL 1-based step list (branch-step
  variants not resolvable). `subscriber_id` must be an opaque safe identifier;
  email-shaped/unsafe values and invalid positions fast-fail without transport.
  This is an authoring preview only while delivery/runtime identity parity is
  unqualified.
- `listStuckParticipants(seqId, {days})` →
  `GET …/{id}/stuck[?days=]` → `{items: [{subscriber_id, email,
current_step, idle_days}], threshold_days}`. `?days` overrides the
  sequence's `stuck_after_days`; 400 when neither is configured; 501
  when the voice service runs without Postgres; capped at 500 rows.
- `generateTemplate({brief, kind?, tone?})` →
  `POST /api/v1/voice/templates/generate` → `{name, subject,
body_html, body_mjml?}` (LLM_REQUEST_OPTS). `kind` ∈
  `newsletter|promo|announcement` (default newsletter); brief ≤ 8000
  chars, tone ≤ 200; 429 + quota payload when over AI quota.
  **Note:** there is no plain-text `body` field on the response.

### Additive sequence-type extensions (existing surface)

`SequenceDetail` / `SequenceUpdateInput` gained `goal?:
SequenceGoal | null` and `stuck_after_days?: number`;
`SequenceCanvasStep.email` gained `variants?: SequenceEmailVariant[]`.
New types: `SequenceGoal` (`{kind: "conversion"|"click"|"open",
exit_on_goal: boolean}` — conversion goals never evaluate true in-repo)
and `SequenceEmailVariant` (`{key, subject, body, body_html?,
weight_bp}` — basis points, step variants should sum to 10000). The
existing `getSequence` / `updateSequence` wrappers carry them
transparently.

## R8 — SMS broadcasts (`apps/api/internal/sms/{broadcasts,broadcast_handlers}.go`)

**Export:** `smsBroadcastsApi` — `list / create / get / update / remove / send / cancel / progress`
**Types:** `SmsBroadcast`, `SmsBroadcastUpsert`, `SmsBroadcastProgress`, `SmsBroadcastSendResponse`

- Audience is **exactly one** of `list_ids | segment_id | tag`
  (server-enforced; typed 422s incl. `audience_too_large`).
- `list()` → `{items}`. `remove(id)` → 200 `{ok:true}` (not while
  sending). `update` only in draft|scheduled.
- `send(id)` → **202** `{broadcast, progress, enqueued}`; idempotent
  server-side (draft|scheduled → sending claim flips once); 503
  `sms_provider_unconfigured` without a provider. `cancel(id)` →
  updated `SmsBroadcast` (200, not an envelope).
- `progress(id)` → `{status, sent, failed, held, total}` — refreshes
  denormalised counters and lazily finalises sending → sent.
- Scopes: reads `read:reports`, all writes admin.

## R9 — Goals (`apps/api/internal/goals`)

**Export:** `goalsApi` — `list / create / update / remove / progress`
**Types:** `TenantGoal`, `TenantGoalCreateInput`, `TenantGoalPatch`, `TenantGoalProgress`, `TenantGoalMetric`, `TenantGoalPeriod`

- **Deviation:** `list()` returns `{goals: [...]}` (not `{items}`).
- `metric`: `subscribers | open_rate | revenue_cents | list_growth`;
  `period`: `monthly | quarterly` (create defaults to monthly);
  target must be > 0.
- `progress()` → `GET /api/v1/goals/progress` → `{progress: [{goal,
current, target, pct, pace("ahead"|"on_track"|"behind"),
period_start, period_end, as_of}], as_of}`.
- Types are prefixed `TenantGoal*` to avoid clashing with the existing
  campaign-template `Goals` + sequence `SequenceGoal` exports.

## R10 — Audit evidence export schedules (`apps/api/internal/handlers/audit_export_schedules.go`)

**Export:** `auditExportSchedulesApi` — `list / create / remove`
**Types:** `AuditExportSchedule`

- `list()` → `{schedules: [...]}` (**not items**), scope `audit:read`.
- `create({cadence, recipients, filters?})` → 201 row; cadence
  `weekly|monthly`, ≤ 10 recipients, 400 `invalid_schedule`.
  Mutations need `audit:configure_sinks`.
- **Deviation:** `remove(id)` answers **200 `{deleted:true}`** (not
  204); 404 `not_found` for unknown ids.

## R11 — Segment insights (`apps/api/internal/segments/{overlap,growth}.go`)

**Export:** `segmentInsightsApi` — `overlap / growth`
**Types:** `SegmentOverlapResponse`, `SegmentGrowthPoint`, `SegmentGrowthResponse`

- `overlap(a, b)` → `GET /api/v1/segments/overlap?a=&b=` → `{a, b,
a_count, b_count, intersection, jaccard}` (jaccard ∈ [0,1]; 404 when
  either id is unknown).
- `growth(id, {days})` → `GET /api/v1/segments/{id}/growth?days=` →
  `{segment_id, days, series: [{date, evaluated_at, count}], delta,
delta_pct, note?}`. **Additions over the report:** response also
  carries `segment_id` + `days`. days defaults 90, clamps 1..365,
  tolerates a trailing `d` ("30d"). `delta`/`delta_pct` compare newest
  vs oldest point (0 when < 2 points); `note` explains empty series.

## R12 — Referrals leaderboard (`apps/api/internal/referrals/leaderboard.go`)

**Export:** `referralsLeaderboardApi` — `get`
**Types:** `ReferralLeaderboardItem`, `ReferralLeaderboardResponse`

- `get({window, limit})` → `GET /api/v1/referrals/leaderboard?window=90d&limit=20`
  → `{window_days, items: [{referrer_email_masked, conversions,
milestone, rank}]}`. Emails arrive pre-masked (`a***@domain`).
  Invalid window falls back to 90 days.

## R13 — Win-back settings (`apps/api/internal/retention_offers/winback.go`)

**Export:** `winbackSettingsApi` — `get / put`
**Types:** `WinbackSettings`

- `GET/PUT /api/v1/retention-offers/winback-settings` →
  `{enabled, churn_threshold, churn_profiles_scored}`.
- `churn_threshold` ∈ (0, 1]; sending 0 means "use the default";
  out-of-range → 400. `churn_profiles_scored` is **read-only** (0 →
  predictive model hasn't run; render the data-gap explainer).

## R14 — Merge apply (`apps/api/internal/merge/apply.go`)

**Export:** `mergeApplyApi` — `apply`
**Types:** `MergePlan`, `MergeApplyResponse`

- `apply({primary_id, duplicate_id, dry_run?})` →
  `POST /api/v1/merge/apply` → `{primary_id, duplicate_id, dry_run,
plan {tags, custom_fields, status, consent_timestamp?,
gdpr_permissions}, events_moved, suppressions_moved,
loser_soft_deleted}`.
- **Additions over the report:** response echoes `primary_id`,
  `duplicate_id`, `dry_run` alongside the documented fields.
- **409 `already_merged`** when the duplicate was previously merged.
  Destructive subscriber write (scope `write:subscribers`) →
  `requireOnline`, never offline-queued.

## Alert rules — `notify_slack` (additive, `apps/api/internal/audit_alerts`)

No new wrapper. Existing `AuditAlertRule`, `AuditAlertRuleInput`, and
`AuditAlertRulePatch` types gained `notify_slack?: boolean` (COALESCEd
to false server-side for pre-migration rows; fans fired rules out to
the tenant's Slack workspace independent of `channel_kind`).

---

# Task-2 verdicts (packages the previous audit missed)

| Package                   | Verdict                         | Where mounted                | Wrapper            |
| ------------------------- | ------------------------------- | ---------------------------- | ------------------ |
| `internal/form_variants`  | **MOUNTED + real**              | `apps/api/main.go:2017`      | `formVariantsApi`  |
| `internal/landingpages`   | **MOUNTED + real**              | `apps/api/main.go:2170-2176` | `landingPagesApi`  |
| `internal/social_capture` | **MOUNTED + real**              | `apps/api/main.go:2267`      | `socialCaptureApi` |
| `internal/socialads`      | **UNMOUNTED — no HTTP surface** | n/a                          | none (skip)        |

## T1 — Form display variants (`form_variants`)

**Export:** `formVariantsApi` — `list / create / update / remove / listPromotions / evaluate`
**Types:** `FormVariant`, `FormVariantCreateInput`, `FormVariantPatch`, `FormVariantPromotion`, `FormVariantEvaluateResponse`

- Routes under `/api/v1/forms/{id}/variants` (+ `/promotions`,
  `/evaluate`). Reads `read:forms`-equivalent, writes admin-equivalent
  (`r.With(read)/(write)` in handlers.go).
- **DEVIATION — wire casing:** this package alone is **camelCase**
  (`formId`, `displayConfig`, `trafficPct`, `promotedAt`,
  `conversionRate`, `createdAt`, …). Everything else in the client is
  snake_case. Types mirror the wire verbatim — do not "fix" the casing.
- `list` and `listPromotions` return **bare arrays** (no envelope).
- `remove` → 200 `{ok:true}`. `evaluate` → `{decision {weights, …},
samples}` — one manual bandit pass, idempotent on identical counters.

## T2 — Landing pages (`landingpages`)

**Export:** `landingPagesApi` — `list / get / create / update / remove`
**Types:** `LandingPage`, `LandingPageCreateInput`, `LandingPagePatch`

- CRUD at `/api/v1/landing-pages` (+`/{id}`). `list` returns a **bare
  array**. Scopes: list/get `read:campaigns`, mutations admin.
- `blocks`/`seo`/`tracking`/`metrics` are free-form jsonb; the server
  normalises nulls to `[]`/`{}` on the wire. Status:
  `draft|published|archived`. Public render is in apps/web at
  `/landing/[slug]` — NOT part of this API surface.

## T3 — Social capture (`social_capture`)

**Export:** `socialCaptureApi` — `catalog / validateRule / listRules / createRule / getRule / listLeads / listTapLinks / createTapLink / getTapLink`
**Types:** `SocialCaptureRule`, `SocialCaptureLead`, `SocialCaptureTapLink`

- Routes under `/api/v1/social-capture/*`; list endpoints return
  `{items}` envelopes; creates are 201. `catalog` and `validateRule`
  responses are loosely typed (`Record<string, unknown>`) — the server
  emits nested literal maps.
- NOT wrapped (machine-to-machine, not desktop UI surfaces):
  `POST …/auto-replies/{id}/events`, `POST …/tap-to-text/{id}/consent`,
  and the public `GET /api/public/tap-to-text/{slug}` redirect.

## T4 — Social ads (`socialads`) — UNMOUNTED

`internal/socialads` exposes **no HTTP routes**. It is a provider-
client registry (Meta Graph + Google Ads credentials/config,
`socialads.NewRegistry` in `main.go:804`) consumed internally by the
`mailchimpv3` compatibility facade (`internal/mailchimpv3/repo.go` —
`Repo.SocialAds`, used by p2.go readiness + tenant-config resolution).
Its capabilities surface only through the Mailchimp-compat endpoints
already wrapped elsewhere. **Frontend: skip — nothing to wire.**

---

# Cross-cutting deviations found (vs the implementers' reports)

1. **NLQ `cost_status`:** the Go doc comment advertises it; the
   response struct doesn't include it. Not typed.
2. **Goals list envelope** is `{goals}`, audit export schedules list
   envelope is `{schedules}` — neither uses `{items}`.
3. **Export-schedule delete** returns 200 `{deleted:true}`, not 204.
   Feed-source delete IS a true 204.
4. **Variant resolution key:** endpoint returns `variant_key`, while
   stored step variants use `key`.
5. **Merge apply / segment growth** responses carry extra echo fields
   (`primary_id`/`duplicate_id`/`dry_run`; `segment_id`/`days`) beyond
   the reported shape.
6. **form_variants is camelCase on the wire** — unique in the API.
7. **SMS cancel** returns the updated broadcast row (not `{ok}`), and
   **SMS delete** returns `{ok:true}` (not 204).
8. **Fatigue deciles** key their rows by `sends_bucket` label;
   leaderboard/fatigue rates are 0..1 fractions, not percentages.
9. **Feed poll 200-on-failure** confirmed (status:"failed" + error
   text in a 200 body) — plus a 503 `poller_unavailable` mode the
   report didn't mention.
10. **Attribution rollup row** has `campaign_id: ""` and omits
    `revenue_per_send_cents`.
