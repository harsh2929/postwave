# WIRING-WRAPPERS — typed api-client coverage for the 2026-06-11 backlog

Branch: feat/full-surface-wiring. Companion to WIRING-COVERAGE-2026-06-11.md.
All wrappers live in `src/lib/api-client.ts` (appended "Full-surface wiring"
section, plus a few earlier blocks noted below). Every shape was verified
against the Go handlers in `apps/api/internal/<pkg>` (items 42–44 against
`services/deliverability` + the proxy mounts in `apps/api/main.go`).

Conventions (match the rest of the file):
- All methods return `Promise<ApiResult<T>>` — branch on `res.error`.
- Wire format is snake_case unless a NOTE says otherwise (several backend
  packages serialize camelCase; the types mirror the wire exactly).
- "LLM opts" = `LLM_REQUEST_OPTS` (60s timeout, maxAttempts 1).

| # | Wrapper export | Types | Shape summary / notes |
|---|---|---|---|
| 1 | `emailBlocksApi` — `catalog()`, `compose(input)` | `EmailBlock`, `EmailBlockFieldSpec`, `EmailBlockBrandDefaults`, `EmailBlockCatalogResponse`, `EmailBlockInstance`, `EmailBlockComposeInput`, `EmailBlockComposeResponse` | catalog → `{brand, blocks[]}`; compose POST `{brand, blocks[], subscriber_email?, subject?}` → `{mjml, warnings?}`. (Saved blocks `/blocks/saved` were already wired on `api`.) |
| 2 | `sendWindowApi` — `get()`, `upsert(input)`, `check(scheduledAt)`, `remove()` | `SendWindowPolicy`, `SendWindowUpsertInput`, `SendWindowVerdict` | GET → `{policy: Policy\|null}`; PUT (admin) returns the policy; check POST `{scheduled_at}` → `{inside_window, enforcement, should: allow\|warn\|block, reason?}`; DELETE (admin). |
| 3 | `a11yApi.check({html, subject?})` | `A11yFinding`, `A11yReport` | → `{findings[], counts{info,warn,error}, score 0..100}`. Static rules, safe per-keystroke. |
| 4 | `translationsApi` — `getSettings()`, `putSettings(input)`, `listDictionary()`, `upsertDictionaryEntry(input)`, `deleteDictionaryEntry(id)`, `importDictionaryCSV(csv)`, `exportDictionaryCSV()`, `preview({body, locale})` | `TranslationSettings(+Input)`, `TranslationDictionaryEntry(+Input)`, `TranslationImportResult`, `TranslationRenderResult` | dictionary list → `{entries}`. Import sends raw `text/csv` body → `{imported, skipped, errors?}`. Export is a raw-fetch CSV download → `{blob, filename}` (non-JSON, bypasses the JSON core). **preview is LLM-backed → LLM opts.** |
| 5 | `fromNamePickerApi.list({days?, minCampaigns?})` | `FromNameRow`, `FromNamePickerResponse` | → `{window_days, min_campaigns, from_names[], count}` ranked by composite score. |
| 6 | `linkCheckerApi.check(campaignId)` | `LinkCheckResult` | POST `/campaigns/{id}/check-links` → **BARE ARRAY** `LinkCheckResult[]` (`{url, status, ok, error?}`). 30s timeout, 1 attempt. |
| 7 | `utmTemplatesApi` — `list()`, `upsertDefault(input)`, `upsertCampaign(id, input)`, `remove(id)`, `preview({url, campaign_id?})` | `UTMTemplate`, `UTMTemplateInput`, `UTMPreviewResponse` | list → `{templates, count}`; upserts → `{id}`; delete → 204; preview → `{original, rewritten, template}`. |
| 8 | `subjectAnalyzerApi` — `buckets(days?)`, `score(subject)` | `SubjectAttrs`, `SubjectBucket`, `SubjectBucketsResponse`, `SubjectScoreResponse` | buckets → `{window_days, campaigns_total, buckets[]}`; score → `{subject, attributes, expected_open, expected_click, matched_history, suggestions[]}`. Heuristic, NOT LLM. |
| 9 | `emailValidationApi` — `check(email)`, `checkBatch(emails)` | `EmailValidationResult`, `EmailValidationBatchResponse` | check → single result; batch → `{results[], summary{total,valid,invalid}}`. MX lookups → longer timeouts (15s / 30s). |
| 10 | `resendUnopenedApi.resend(campaignId, {subject?, name?, send_after_hours?})` | `ResendUnopenedInput`, `ResendUnopenedResponse` | 201 → `{id, name, subject, original_id, audience_size, send_after_hours}`. `requireOnline` (creates a real send). |
| 11 | `campaignCloneApi.clone(campaignId, name?)` | — | 201 → `{id, name}`. |
| 12 | `holdoutApi` — `create(id, percent)`, `get(id)`, `remove(id)`, `lift(id)` | `CampaignHoldout`, `HoldoutLift` | create 201 → `{campaign_id, percent, seed}`; get → row (404 when none); lift → `{status:"pending"}` until decided, then click-rate split incl. `incremental_lift`, `lift_percent`. |
| 13 | `controlGroupsApi` — `list()`, `create(input)`, `get(id)`, `update(id, input)`, `remove(id)`, `report(id, windowDays?)` | `ControlGroup(+Create/UpdateInput)`, `ControlGroupReport` | list → `{items}`; report query param is **`?window=`** (days), → `{group_id, window_days, control/treated sizes + engagement rates, incremental_lift, generated_at}`. |
| 14 | `contentOptimizerApi` — `get(campaignId)`, `preview(campaignId, input?)`, `createRun(campaignId, input?)` | `OptimizerArmInput`, `OptimizerPreviewInput`, `OptimizerArmAllocation`, `OptimizerPreviewResponse`, `OptimizerRun` | get → latest `OptimizerRun` (404 when none); preview → allocation only; createRun 201 → persisted run. |
| 15 | `contentRemixApi.remix(campaignId, {channels?, tone?})` | `RemixAsset`, `RemixResponse` | → `{campaign_id, assets[], generated_at}`. **Deviation:** currently template-driven (not LLM) server-side, but wrapper carries LLM opts pre-emptively (cheap; documented in code). |
| 16 | `replyAnalyticsApi` — `summary(days?)`, `byCampaign(id)`, `topSenders(days?)`, `timeseries(days?)` | new: `ReplyPreview`, `ReplyByCampaignResponse`; reuses existing `RepliesSummary`, `ReplyTopSendersResponse`, `ReplyTimeseriesResponse` | **Backend surprise: summary/timeseries/top-senders were ALREADY wired** as `api.getRepliesSummary/-Timeseries/-TopSenders`. New: byCampaign → `{campaign_id, replies, distinct_replyers, unique_recipients, reply_rate, recent[]}`. |
| 17 | `lifecycleRollupApi` — `distribution()`, `stages()` | `LifecycleDistributionRow` | distribution → `{items: [{stage, count}]}`; stages → `{stages: string[]}`. Per-subscriber GET/PUT lifecycle already on `api`. |
| 18 | `leadScoringApi` — `rules()`, `putRules(rules)`, `recompute()` | `ScoringRule` | rules → `{rules[], defaults[]}`; put → `{saved}`; recompute → `{updated}` (30s, 1 attempt). Admin scope. |
| 19 | `contactRatingsApi` — `get(subscriberId)`, `recompute(windowDays?)` | `SubscriberRatingView`, `ContactRatingRecomputeResult` | GET `/contact-ratings/{subscriber_id}` → `{subscriber_id, stars?, engagement_score?, engagement_score_at?, source: manual\|heuristic}`; recompute POST `?window=` → `{updated, scanned, started_at, finished_at, window_days}`. (Manual PATCH `/subscribers/{id}/rating` is a separate, already-mounted surface.) |
| 20 | `eqScoreApi.score(input)` | `EQScoreInput`, `EQScoreReason`, `EQSubScore`, `EQScoreResult` | POST `/deliverability/eq-score`. Request carries draft content plus optional `campaign_id`/`draft_label`; sender auth and reputation are resolved from tenant-scoped server state. → `{score, grade, content/auth/reputation sub-scores, reasons[], skippedSubScores[]}`. Heuristic, not LLM. |
| 21 | `subscriberNotesApi` — `list(sid)`, `create(sid, {body, pinned?})`, `update(sid, noteId, {pinned})`, `remove(sid, noteId)` | `SubscriberNote` | list → `{notes[], count}`; create 201 → `{id}`; update → `{pinned}`; delete → 204/void. Admin scope. |
| 22 | `sunsetApi` — `listPolicies()`, `createPolicy()`, `getPolicy()`, `updatePolicy()`, `deletePolicy()`, `runPolicy(id)`, `listExecutions(id, limit?)`, `previewReengagement(input)` | `SunsetPolicy(+Input)`, `SunsetExecution`, `SunsetRunSummary`, `SunsetBrandSnapshot`, `SunsetReengagementTemplate` | **camelCase wire** (`inactiveDays`, `excludedTags`, …). `SunsetBrandSnapshot` fields are Go-field-name cased (`WorkspaceName`, `Tone`, …) — the struct has no json tags. runPolicy is synchronous (60s, 1 attempt, requireOnline). Backend note: detector currently runs against a stub store → zero-candidate summaries (sunset/GAPS.md). |
| 23 | `inactiveKeysApi.list(thresholdDays?)` | `InactiveKeyAlert` | GET `?days=` → `{threshold_days, keys[], count}`; severity warn/high/critical. Admin scope. |
| 24 | `growthSourcesApi` — `summary(days?)`, `timeseries(days?)`, `quality(days?)` | `GrowthSourceBucket`, `GrowthSourceSummaryResponse`, `GrowthSourceTimeseriesResponse`, `GrowthSourceQualityRow(+Response)` | summary → `{window_days, since, sources[], total_new_subs}`; quality rows carry engagement/bounce/complaint rates. |
| 25 | `presetSegmentsApi` — `list()`, `subscribers(key, {limit?, offset?})` | `PresetSegment`, `PresetSegmentSubscriber` | list → `{presets[], count}`; drill-down → `{preset, label, subscribers[], count, limit, offset}`. |
| 26 | `predictiveApi` — `catalog()`, `profiles({segment?, limit?})`, `profile(email)`, `rfmSegments()`, `recompute()` | `PredictiveCatalogModel(+Response)`, `PredictivePrediction`, `RFMScoreRow`, `PredictiveProfileAnalytics`, `PredictiveModelRun`, `PredictiveRecomputeResult` | profiles/rfmSegments → `{items}`; profile → `{prediction, rfm}`; recompute (admin) → `{run, predictions, rfm_scores}` (60s, 1 attempt). |
| 27 | already wired on `api`: `listTagTaxonomy`, `mergeTags`, `renameTagAcross`, `listSubscribersWithTag`, `suggestTags` (+ membership/history extras) | existing types | **No new wrapper needed** — the PARTIAL flag was a response-type drift: the Go merge handler returns `{from, into, subscribers_updated}`, never `{merged}`. `api.mergeTags` return type was widened additively (old `merged` kept as an optional legacy field). |
| 28 | `zeroCopyTriggersApi` — `list({status?})`, `create`, `get`, `update`, `remove`, `pollNow(id)`, `fires(id)`, `validate(input)`, `getAlerts(id)`, `putAlerts(id, input)`, `listDLQ(id)`, `retryDLQ(id, entryId)` | `ZeroCopyTrigger(+Input)`, `ZeroCopyValidationResult`, `ZeroCopyFire`, `ZeroCopyAlertConfig`, `ZeroCopyDLQEntry` | list/fires/dlq → `{items}`; pollNow → `{fires[], count}` (30s, 1 attempt, requireOnline); create/update return the row, or **400 whose error body is the ValidationResult**; delete → 204; retryDLQ → 202 `{id, status, note?}` (server retry pipeline still pending per its note). |
| 29 | `triggerDelayApi` — `getPreference({subscriberId, eventName})`, `putPreference(input)` | `TriggerDelayPreference` | GET takes the pair as query params (404 when unset); PUT (admin) upserts; delay bounded 0..2 592 000 s. |
| 30 | `omnichannelApi` — `catalog()`, `listCampaigns({status?})`, `getCampaign(id)`, `createCampaign(input)`, `validate(campaign)` | `OmniCatalogItem(+Response)`, `OmniCampaign`, `OmniCampaignPath`, `OmniValidationResponse` | list → `{items}`; create 201 (422 with validation payload when invalid); **validate body is `{campaign: {...}}`** → `{valid, errors?, warnings?, supported_paths}`. |
| 31 | `scheduledReportsApi` — `list()`, `create(input)`, `update(id, patch)`, `remove(id)`, `sendNow(id)` | `ScheduledReport`, `ScheduledReportCreateInput`, `ScheduledReportPatchInput` | list → **`{reports}`** (not items); create 201 → `{id, next_due_at}`; patch → `{updated:true}`; delete → `{deleted:true}`; send-now → `{queued:true}` (requireOnline). Admin scope. |
| 32 | `conversionsApi` — `list({before?})`, `listKeys()`, `createKey(label)`, `revokeKey(id)` | `ConversionRow`, `ConversionTrackingKey` | list → **BARE ARRAY**, 50/page, cursor = `?before=<RFC3339 occurred_at>`; keys list → bare array; createKey 201 → `{key, plaintext}` (**plaintext shown once**, requireOnline); revoke → `{ok}`. |
| 33 | `commerceApi` — `listIntegrations()`, `syncIntegration(id, input?)`, `startShopifyOAuth(shop)`, `listCatalogs()`, `createCatalog()`, `importCatalogProducts()`, `listProductFeeds()`, `createProductFeed()`, `resolveProductFeed()`, `listCartRecoveryLinks()`, `upsertCartRecoveryLink()`, `listBackInStockSubscriptions()`, `createBackInStockSubscription()`, `listPriceDropWatchers()`, `createPriceDropWatcher()`, `evaluateLifecycle(id)`, `lifecycleReport(id)`, `listCustomers()`, `listProducts()`, `listProductVariants()`, `listInventorySnapshots()`, `listPriceHistory()`, `listOrders()`, `listEvents()`, `analytics(id)` | `CommerceIntegration`, `CommercePage<T>`/`CommercePageInfo`, `CommerceCatalog(+Input)`, `CommerceCatalogImportSummary`, `CommerceProductFeed(+Input)`, `CommerceResolvedFeed(+Item)`, `CommerceCartRecoveryLink`, `CommerceBackInStockSubscription`, `CommercePriceDropWatcher`, `CommerceLifecycleReport(+Stats)`, `CommerceCustomer`, `CommerceProduct`, `CommerceProductVariant`, `CommerceInventorySnapshot`, `CommercePriceHistoryPoint`, `CommerceOrder`, `CommerceEventRow`, `CommerceAnalytics` | All list endpoints (except integrations, which is a **bare array**) return `{items, total, page, per_page}` → `CommercePage<T>`. Back-in-stock / price-drop CREATE routes are nested under `/integrations/{id}/products/{product_id}/…`. sync/import are 202 + summary (60s, 1 attempt). cart-recovery/BIS/price-drop lists accept `?status=`. |
| 34 | `exportsApi` — `create(include)`, `list()`, `get(id)` | `TenantExportRow` | create 202 → `{id, status:"queued", include}` (requireOnline); list → **`{exports}`**; get → row incl. `download_url`/`expires_at` when ready. Retention policy GET/PATCH were already wired (`api.getExportRetentionPolicy` / `patchExportRetentionPolicy`). |
| 35 | `warehouseApi` — `catalog()`, `validate(input)`, `listConnections()`, `createConnection()`, `getConnection(id)`, `listMappings(id)`, `putMapping(id, sourceObject, input)`, `runConnection(id, input?)`, `runDue(limit?)`, `listRuns()`, `getRun(id)`, `listRunErrors(id)` | `WarehouseCatalogResponse`, `WarehouseConnection`, `WarehouseValidationResult`, `WarehouseSyncRun`, `WarehouseImportMapping` | lists → `{items}`; create 201 or **400 with the validation result as the body**; runConnection/runDue are 202 (60s, 1 attempt, requireOnline). `listRuns` is tenant-wide (the per-connection chi param slot is empty on this mount). |
| 36 | `customObjectsApi` — `listTypes()`, `createType()`, `getType()`, `updateType()`, `deleteType()`, `listRecords(typeId, filter?)`, `upsertRecord(typeId, input)`, `getRecord(id)`, `deleteRecord(id)` | `CustomObjectType`, `CustomObjectRecord` | **camelCase wire** (`tenantId`, `primaryKey`, `externalId`, …). lists → `{items}`; upsertRecord keyed on `externalId`, 422 with violations on schema failure. |
| 37 | `cdpTransformsApi` — `preview({properties, ops})`, `ops()` | `CDPTransformOp`, `CDPTransformResult`, `CDPTransformOutcome` | preview → `{properties, results[], success, failed}` (pure dry-run); ops → `{ops: string[]}` registered op names. |
| 38 | `spamTrapGuardApi` — `hits()`, `stats()`, `runNow()` | `SpamTrapHit` | hits → `{hits[], count}`; stats → `{hits_last_30_days, blocklisted_count}`; run-now (admin) → `{blocklisted}` (requireOnline). |
| 39 | `softBounceRecoveryApi` — `stats()`, `runNow(windowDays?)` | — | stats → `{disabled_count, eligible_now, recovery_window_days}`; run-now `?window_days=` → `{recovered}` (requireOnline). |
| 40 | `intelligentRetryApi` — `events({status?, limit?})`, `markReady(id)`, `dismiss(id)` | `IntelligentRetryEvent` | events → `{items}` (limit ≤ 500); both actions return the updated event row (404 when unknown). |
| 41 | `ispBreakdownApi` — `tenant(days?)`, `byCampaign(id)` | `ISPBucket` | tenant → `{window_days, buckets[]}`; by-campaign → `{campaign_id, buckets[]}`. |
| 42 | `inboxRealityCampaignsApi.report(campaignId)` | `CampaignPlacementReport`, `PlacementProviderBreakdown` | **Proxied** GET `/api/v1/inbox-reality/campaigns/{id}` → deliverability svc `/v1/inbox-reality/campaigns/{id}` (verified in main.go). → `{campaign_id, providers[], overall_pct, total_inboxes, generated_at, diagnostic_id?, reports?}`. 404 until a seed test reported; 503 when the report store isn't configured. |
| 43 | `authChecksApi.matrix()` | `AuthCheckMatrixRow`, `AuthCheckRecord` | **Proxied** GET `/api/v1/auth-checks` → svc `/v1/auth-checks` (verified; reachable). Returns a **BARE ARRAY** of `{domain, spf, dkim, dmarc, bimi, ptr}` rows (each `{status: ok\|warn\|fail, detail}`); currently always one row. DNS-bound → 20s timeout. |
| 44 | `diagnosticianApi.diagnose(campaignId, signals?)` | `DiagnoseSignalsInput`, `CampaignDiagnosis`, `DiagnosisFix` | **Proxied, LLM-backed → LLM opts.** POST `/api/v1/diagnose/{campaign_id}` (verified mount `/api/v1/diagnose/*`). Empty body is fine (service self-gathers). → `{campaign_id, diagnosis (markdown), fixes[], predicted_impact, generated_at}`. 503 `LLM not wired` when no model configured. |
| 45 | `blocklistAutoSuppressApi` — `get()`, `set(bool)` | — | `{auto_suppress: boolean}` both ways (PATCH echoes). Handler lives in the `search` package. |
| 46 | `listsInboxRealityApi.list(listId, limit?)` | `ListInboxRealityRow` | → `{list_id, items[]}` (`{test_id, subject?, created_at, status, total_seeds, inbox, spam, missing, inbox_pct}`); limit ≤ 25. |
| 47 | Gift archive methods on `api` — `listGiftSubscriptions(opts?)`, `getGiftSubscriptionStats()`, `getGiftSubscription(id)` | `GiftHistoryWireRecord`, `GiftHistoryPageResponse`, `GiftHistoryListOptions`, `GiftSubscriptionStats` | This is an identity-minimized, read-only archive backed by exactly three `read:reports` GETs: list, aggregate stats, and opaque-record detail. The list is bounded to 100 rows and offset 10,000; search accepts only an 8–32 hexadecimal opaque-record prefix. Responses omit identities, free text, provider identifiers/URLs, redemption material, tenant IDs, and subscriber IDs. `conversionRate` is the one camelCase field amid snake_case siblings. No desktop attribution, create, edit, cancel, payment-handoff, public-claim, notification, expiration-worker, or paid-subscription mutation wrapper is part of this release boundary. |
| 48 | `firewallApi` — `settings()`, `putSettings(input)`, `events({limit?, action?})`, `stats()`, `detect()` | `FirewallSettings(+Input)`, `FirewallEvent`, `FirewallStats` | events → `{events[], count}`; stats → `{last_24h, last_7d}` each `{accepted, rejected, observed}`; detect (admin) → `{flipped}`. |
| 49 | `onsiteGrowthApi` — `catalog()`, `validate(input)`, `getTargeting(formId)`, `putTargeting(formId, input)`, `listExperiments(formId)`, `upsertExperiment(formId, key, input)`, `recordExperimentEvent(formId, key, input)`, `listSpinRewards(formId)`, `replaceSpinRewards(formId, items)`, `resolveSpin(formId, input?)` | `OnsiteGrowthCatalog`, `OnsiteTargetingRules`, `OnsiteExperiment(+Variant)`, `OnsiteSpinReward`, `OnsiteValidationResponse`, `OnsiteSpinResolveResponse` | PUT targeting/experiment/rewards return the stored row(s) or **422 with the validation payload**; events → 202 `{ok, event_id}`; replaceSpinRewards body is `{items}`; resolveSpin → `{reward, coupon?, entropy_basis_points}`. |
| 50 | already wired on `api`: `listArchiveComments`, `moderateArchiveComment`, `pinArchiveComment`, `unpinArchiveComment`, `deleteArchiveComment`; grouped alias `archiveCommentsAdminApi` (`list/moderate/pin/unpin/remove`) added for the per-domain style | existing `ArchiveComment`, `ArchiveCommentsListResponse` | **Backend surprise: this was already wired** (audit doc stale). camelCase wire. Admin list → `{items, total}` flat (not the public tree); moderate body `{status: visible\|hidden\|spam}`. |
| 51 | Affiliate operational wrapper intentionally absent | — | The platform-global affiliate admin tree, public offer, attribution accrual, and settlement runtime are release-gated. Desktop exposes only a zero-request qualification workspace; future reads require dedicated platform-operator authority and strict audited contracts. |
| 52 | `podcastTokensApi` — `get(email)`, `mint(email)`, `revoke(email)` | `PodcastSubscriberToken` | POST mints/ROTATES; **raw `token` + `feed_url` only present in the POST response** (never re-issued); GET → metadata or 404; DELETE → `{ok}`. Admin scope; requireOnline on mint. |
| 53 | `activityPubApi` — `getActor()`, `provisionActor(input?)`, `putActor(input)`, `listInbox({limit?, unreadOnly?})`, `markInboxRead(id)`, `listFollowers(limit?)`, `listOutbox(limit?)` | `ActivityPubActor(+Envelope)`, `ActivityPubInboxEntry`, `ActivityPubFollower`, `ActivityPubOutboxEntry` | **camelCase wire.** getActor → `{actor, handle, urls}` (404 `not_provisioned` first-run); provision is idempotent → `{actor, handle}`; inbox → `{items, unread}` (`?unread=1` filters); followers/outbox → `{items, total}`. |
| 54 | `apiUsageApi` — `summary(days?)`, `keys(days?)`, `timeseries(days?)` | `APIUsageSummary`, `APIUsageKeyRow` | summary → totals + per-day averages + 30d projections; keys → `{window_days, since, keys[], count}`; timeseries → `{window_days, points[{date, sends, cost_cents}]}`. |
| 55 | `costsApi` — `aggregate({since?, by?})`, `ledger({since?, cursor?, limit?})` | `CostAggregateRow`, `CostLedgerEntry` | **camelCase wire** (`apiKeyId`, `actorType`, `tenantId`, `nextCursor`). aggregate → `{rows, buckets (alias), since, group_by}`; `by` joins with commas (`api_key_id,kind,day`); ledger → `{rows, nextCursor?}` keyset pagination. |
| 56 | `featureFlagsApi` — `list()`, `upsert({key, value, note?})`, `remove(key)`, `resolve(key)` | `FeatureFlag` | list → `{flags[], count}` (tenant rows + platform defaults, `is_default` flag); upsert → `{id, key, value}`; delete removes the tenant override only; resolve → `{key, value, source: tenant\|default\|missing}`. |
| 57 | `regionsApi` — `list()`, `current()` | `RegionInfo`, `CurrentRegionInfo` | **Public paths WITHOUT `/api/v1`**: `/api/regions` → `{regions[]}`, `/api/regions/current` → deployment region + provider endpoints. No auth needed (wrapper still sends it; harmless). |
| 58 | `openApiSpecApi.get()` | — | GET `/api/v1/openapi.json` → parsed spec as `Record<string, unknown>`; 20s timeout (large doc). |
| 59 | `searchApi.global(q, {limit?, signal?})` | `GlobalSearchResult` | GET `/api/v1/search?q=&limit=` → `{query, results[{type: list\|segment\|suppression\|subscriber, id, title, detail?}]}`; limit ≤ 50; AbortSignal threaded for keystroke cancellation. |
| 60 | — (skipped by design) | — | Discord/Teams receiver presets are UI-only (dispatchers already exist server-side); no wrapper. |

## Gateway gaps

None. All three proxied deliverability routes (#42 `/api/v1/inbox-reality/campaigns/*`,
#43 `/api/v1/auth-checks`, #44 `/api/v1/diagnose/*`) are mounted in
`apps/api/main.go` through `serviceproxy` with read_reports scope and are
reachable when `DeliverabilityServiceURL` is configured — expect 503s (not
404s) in environments without the service.

## Backend surprises / deviations found

1. **#16 + #50 were already wired** despite the audit doc listing them
   UNWIRED — `api.getRepliesSummary/-Timeseries/-TopSenders` and the
   archive-comment moderation extensions pre-existed. Only the missing
   pieces were added (replies by-campaign; grouped alias for comments).
2. **#27 mergeTags response drift**: the server returns
   `{from, into, subscribers_updated}` — the old client type claimed
   `{merged, into}`. Widened additively; UI should read
   `subscribers_updated`.
3. **Mixed casing backends**: sunset (#22), customobjects (#36),
   archive comments (#50), affiliates (#51), activitypub (#53) and
   cost (#55) serialize camelCase; eqscore (#20) mixes camelCase request
   fields with snake_case breadcrumbs;
   `GiftSubscriptionStats.conversionRate` (#47) is camelCase amid
   snake_case siblings. Types mirror the wire exactly.
4. **Bare-array responses** (no envelope): link-checker results (#6),
   conversions + tracking keys (#32), commerce integrations (#33),
   auth-checks (#43), affiliates list/conversions/payouts (#51).
5. **Validation-as-error-body**: zerocopy create/update (#28) and
   warehouse create (#35) return HTTP 400 whose JSON body IS the
   validation result (not the standard `{error}` envelope) — the result
   surfaces via `res.error` with a generic message; omnichannel (#30)
   and onsite-growth (#49) use 422 the same way.
6. **#15 content remix** is currently template-driven (no LLM call) but
   the wrapper carries LLM_REQUEST_OPTS pre-emptively — see code comment.
7. **#22 sunset runPolicy** currently sweeps a stub in-memory subscriber
   store server-side (sunset/GAPS.md) — expect zero-candidate summaries
   until the Postgres store lands; the CRUD + preview are fully real.
8. **#28 retryDLQ** returns 202 with a server note that the reconcile
   pipeline is still pending — the entry is only flipped back to pending.

## Tests

`src/__tests__/api-client.test.ts` — describe block
"api-client full-surface wiring wrappers (2026-06-11)": 19 wire-shape
tests covering #1, #2, #4 (LLM single-attempt), #6 (bare array), #7,
#12, #13 (?window=), #21, #22 (camelCase body), #28 (nested path),
#30 ({campaign} wrap), #32 (bare array + cursor), #33 (status+paging),
#44 (proxied path + single attempt), #45 (PATCH), #47, #56, #57
(public paths), #59 (encoding + abort signal).
