# Multi-modal Content Remix — Migration Recipe

Phase 3 XL feature `archive-content-remix-multi-asset`. The v1 in this
repo is a **scaffold**: data model + repo + handlers + worker skeleton.
The full feature is multi-week ML / vendor-integration work; this doc
captures what's done, what's deferred, and how to pick it up.

## What ships in v1

| Layer        | State    | Notes                                                            |
|--------------|----------|------------------------------------------------------------------|
| Migration    | DONE     | `infra/migrations/0349_archive_content_remix_multi_asset.sql` — 3 tables (jobs, assets, tts_jobs), RLS, indexes |
| Repo         | DONE     | `archive_content_remix.go` — CreateJob / GetJob / ListJobs       |
| HTTP         | DORMANT  | `handlers.go` — asynchronous job routes implemented in source but intentionally unmounted and excluded from OpenAPI |
| Worker shell | DONE     | `worker.go` — poll loop + completion sweep; **generation stubbed** |
| Worker gen   | DEFERRED | LLM fan-out, podcast pipeline, retries with back-off              |

## Architecture sketch (in words)

1. **Trigger (planned)** — operator on the campaign detail page would send the source campaign id + selected kinds + brief + (optional) podcast voice to the asynchronous job endpoint after the worker path is complete and reviewed.
2. **Persist** — the handler inserts one `content_remix_jobs` row + one `content_remix_assets` row per selected kind. Podcast kinds also get a `content_remix_tts_jobs` child row with the chosen voice.
3. **Worker pickup** — a background goroutine polls `content_remix_assets` for `status='pending' AND scheduled_at <= now()`, claims a batch under `FOR UPDATE SKIP LOCKED`, and dispatches per `kind`.
4. **Generate (text)** — for email/sms/social/blog kinds the worker calls `TextGenerator.Generate(ctx, tenantID, kind, sourceBody, brief)`, expecting a kind-specific JSON payload. Email + SMS kinds also call `CampaignDraftSink.SaveDraft` so the operator gets an editable draft.
5. **Generate (podcast)** — first the same `TextGenerator.Generate` produces a script + voice; then `TTSEngine.Render(voice, script)` returns an audio asset id + duration; the worker merges both into the asset payload and updates `content_remix_tts_jobs`.
6. **Completion sweep** — once all assets for a job are terminal (`ready` or `failed`), a sweep query flips the parent job to `completed` (or `failed` if any child failed). This is the only piece of the worker that's wired in v1.

## Deferred work (multi-week)

### Phase 2 — Worker generation path

- **Wire `TextGenerator` to the voice service.** The existing `aicompose.HTTPVoiceClient` is the natural backend. Per-kind prompt templates live in this package; the voice service handles the LLM call. Estimated 3-5 days incl. prompt iteration.
- **Claim + lease semantics.** Replace `tickStub` with a real `claimPending` query (`UPDATE ... SET status='generating', leased_until=now()+lease FROM (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...`) and a kind-fanout dispatcher. ~2 days.
- **Back-off + retry.** On `Generator.Generate` error, bump `attempts`, push `scheduled_at` forward exponentially, fail at `MaxAttempts`. ~1 day.

### Phase 3 — TTS vendor integration

- **Pick a TTS vendor.** Options: ElevenLabs (best six-voice catalog, $$$), OpenAI tts-1 (cheap, fewer voices), Azure Speech (enterprise SLAs), Play.ht. Vendor selection is a product+ops decision, not technical.
- **Vendor adapter.** Implement `TTSEngine` against the picked vendor. Most vendors are async (submit → poll → download); the asset key gets written to the existing `assets` package once the MP3 is downloaded. ~5-7 days incl. signed-URL plumbing + tenant quota accounting.
- **Voice mapping.** The six named voices (Ava/Marcus/Luna/Kai/Nova/Orion) map to vendor voice IDs in a config table or constants — keep it swappable so we can re-vendor without operator visible churn.
- **Audio storage.** Reuse the `assets` package for storage so signed URLs + tenant quotas come for free. ~1 day.

### Phase 4 — Multi-source remix

HubSpot allows up to 6 *source* assets per remix (blog + email + transcript + ...). The schema already reserves `extra_source_ids uuid[]` for this. Real work:

- Resolve each source's body content (campaign body, archive page HTML, transcript text). ~2 days.
- Concatenate / chunk into the prompt context_text, respecting LLM context windows. ~2-3 days.
- UI: a multi-asset picker on the desktop. ~3-4 days.

### Phase 5 — Editing affordances

- **Inline re-generate.** Operator clicks "regenerate this tweet" → POST `/api/v1/content-remix/assets/{id}/regenerate` re-queues that single asset. ~2 days.
- **Pin / unpin assets.** Persist operator edits so a regenerate doesn't blow them away. ~1 day.

## Estimated remaining effort

- Phase 2 — 6-8 days
- Phase 3 — 7-10 days (incl. vendor procurement lead time)
- Phase 4 — 7-9 days
- Phase 5 — 3-4 days

Phases 2 and 3 can run in parallel (different engineers); Phase 4 depends on Phase 2; Phase 5 depends on Phase 2.

## Inspiring vendors

- **HubSpot — Content Remix.** The canonical "blog → 6 derived assets" affordance. https://www.hubspot.com/products/marketing/content-remix
- **beehiiv — AI Translator.** Narrower scope (same content, new locale + minor format tweaks). Same job/asset model fits.
- **Substack — AI clips / transcripts.** Long-form → short clips + transcripts. The `KindBlogExcerpt` + (future) `KindClip` kinds cover this.

## Schema reference

Tables created by `0349_archive_content_remix_multi_asset.sql`:

- `content_remix_jobs` — parent, one per remix request.
- `content_remix_assets` — N children per job, one per derived asset.
- `content_remix_tts_jobs` — child of `content_remix_assets` for podcast kinds.

All three carry `tenant_id` with RLS using the standard `NULLIF(current_setting('app.tenant_id', true), '')::uuid` idiom, plus the `app.outbox_worker` GUC escape hatch so the worker can sweep across tenants.

## Wiring (deferred)

Once the worker generation path is real, add to `apps/api/main.go` (near the other `safego.Go` calls):

```go
remixRepo := &archive_content_remix.Repo{Pool: pool}
remixWorker := archive_content_remix.NewWorker(
    pool,
    /* TextGenerator */ remixTextGen,  // wraps aicompose.HTTPVoiceClient
    /* TTSEngine */     remixTTS,      // wraps the chosen vendor adapter
    /* Sink */          remixDraftSink,// wraps campaigns.Repo
    archive_content_remix.WorkerConfig{},
)
safego.Go(logger, "content-remix-worker", func() {
    remixWorker.Run(outboxCtx)
})
archive_content_remix.MountRoutes(r, &archive_content_remix.Deps{Repo: remixRepo})
```

The route mount is **NOT** wired in v1 to avoid surfacing a half-built feature in production. Add the `MountRoutes` line once Phase 2 lands.
