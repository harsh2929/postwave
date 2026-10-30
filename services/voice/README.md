# services/voice — Pillar 3

Voice AI: ingests writer source material, distills it into a voice profile,
drives few-shot template generation with Google Gemini 3, and scores voice
fidelity. This AGPL-3.0-only service communicates only over HTTP with the
separately running upstream Listmonk process; see `LICENSE-BOUNDARY.md`.
**No `import "github.com/knadh/listmonk/..."` anywhere in this tree.**

## Environment

- `GEMINI_API_KEY` — required in production. Powers profile build (tone
  analysis via the `LLMClassifier`), the `generation.Engine`, and the
  desktop "Moosewave AI" chat handler. The legacy `ANTHROPIC_API_KEY`
  is still read as a fallback for one release window so operators can
  migrate without a coordinated cutover; a `WARN` log fires whenever the
  legacy name is used so the deprecation is visible in production logs.
- `OPENAI_API_KEY` — voice-fidelity embeddings (`text-embedding-3-small`).
- `POSTWAVE_VOICE_TONE_CLASSIFIER=llm` — opt-in: routes the tone classifier
  to the LLM path (now Gemini-backed via `LLMClassifier`) instead of the
  heuristic. Same env shape as before; only the backing model changed.

### Cost note

Gemini 3 Flash is materially cheaper than Claude Sonnet for the volume of
calls this service makes (profile build = 1 call/build, sequence
generation = 1 call/sequence + 1 per regenerated email, chat = 1 per
user message). Indicative pricing at time of migration: ~$0.50 / 1M
input tokens and ~$3.00 / 1M output tokens for Flash. The Pro tier
(`gemini-3.1-pro-preview`) is available as an environment override for
the tone classifier when higher-quality scoring is worth the extra cost.

## Persistence (Postgres)

Three Postgres-backed stores ship in addition to the legacy in-memory
defaults:

- `internal/sourcestore/postgres.go` — `voice_sources` + `voice_items`.
- `internal/profilestore/postgres.go` — `voice_profiles`.
- `internal/seqstore/postgres.go`    — `voice_sequences`.
- `internal/templates/store.go`       — `voice_templates`.

All three tables are created by `infra/migrations/0010_voice.sql` with
RLS + FORCE RLS and a `tenant_isolation` policy. The Postgres impl is
selected at startup when `DATABASE_URL` is reachable. If Postgres is configured
but unavailable, startup fails unless `POSTWAVE_ALLOW_MEMORY_FALLBACK=1` is set
for an isolated local demo.

## Module layout

```
services/voice/
  main.go                              entrypoint, route wiring
  internal/
    config/                            env-driven config
    handlers/
      voice.go                         /v1/voice/sources, /profile chi routes
      sequences.go                     /v1/voice/templates, /sequences chi routes + sequence store
    ingest/
      source.go                        Source interface + Item
      registry.go                      Type → Source registry
      rss/                             blog/newsletter feeds (gofeed + bluemonday)
      twitter/                         Twitter archive (tweets.js) parser
      linkedin/                        LinkedIn posts CSV export parser
      podcast/                         pasted transcript parser
      archive/                         tenant newsletter archive (Postgres-backed)
      pastein/                         paragraph splitter for raw paste-in
    profile/
      types.go                         VoiceProfile + sub-types
      sample.go                        Sample + PickRepresentative
      builder.go                       Build() pipeline (local features + LLM)
      llm.go                           GeminiClient (generateContent API + retries) + MockLLMClient
      wordfreq/                        embedded English-word-frequency table for IDF
    templates/
      types.go                         Template, TemplateEmail, TemplateCategory
      store.go                         TemplateStore interface + MemoryStore + PostgresStore
      seed.go                          runtime VOICE_TEMPLATES_PATH loader + embedded default seeding
      embedded/                        50 starter sequence templates (JSON)
    generation/
      types.go                         Sequence, GeneratedEmail, GenerateRequest
      engine.go                        Engine.Generate / Regenerate
      prompt.go                        sequence + regeneration prompt builders
      prompts/                         embedded defaults, override with VOICE_PROMPTS_PATH
    fidelity/
      evaluator.go                     EmbeddingEvaluator (4-component score)
      embeddings.go                    OpenAIClient + MockEmbeddingClient
```

## Voice generation pipeline

1. Caller hits `POST /v1/voice/sequences` with a `GenerateRequest` (template id,
   variables, optional `style_controls`). The handler resolves the tenant's
   stored `VoiceProfile` if not supplied inline.
2. `generation.Engine.Generate` loads the template, builds the few-shot prompt
   from the embedded `prompts/sequence_system.md` + profile JSON + 3-8
   representative samples + template skeleton + variables + style deltas, and
   calls `LLMClient.Generate` (`gemini-3-flash-preview` in production).
3. The model returns a `{emails: [...]}` JSON object. The engine reconciles the
   email count and delays against the template (the template is authoritative)
   and substitutes any leftover `{{variable}}` placeholders.
4. Each email is scored by `fidelity.EmbeddingEvaluator`. The score is a
   weighted average of:
   - 0.4 × embedding similarity (text-embedding-3-small, cosine across
     representative samples)
   - 0.3 × stylistic distance (Euclidean over avg sentence length, variance,
     paragraph length, formality, hedging, passive %)
   - 0.2 × distinctiveness-weighted vocabulary overlap (Jaccard against the
     profile's `distinctive_terms`)
   - 0.1 × structural match (opening hook + closing pattern + bullet usage)
5. Combined score is mapped to 0..100 and each email includes
   `fidelity_breakdown` so callers can show which heuristic drove the score.
   Any email below 60 is auto-regenerated once with a stronger voice-matching
   prompt; if still below 60, the sequence is shipped with
   `low_fidelity_flag: true` so the frontend can surface a warning.

## Template library (30 starter templates)

Distribution per Phase 2 plan:

| Category            | Count | Slugs                                                                                                              |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `welcome`           | 4     | welcome-3-email, welcome-5-email, welcome-7-email, welcome-10-email                                                |
| `course_launch`     | 3     | course-launch-pre, course-launch-launch, course-launch-post                                                         |
| `product_launch`    | 3     | product-launch-pre, product-launch-launch, product-launch-post                                                      |
| `re_engagement`     | 3     | re-engagement-gentle, re-engagement-direct, re-engagement-last-call                                                 |
| `newsletter_series` | 4     | newsletter-series-writing-tips, newsletter-series-productivity, newsletter-series-marketing, newsletter-series-sales |
| `saas_onboarding`   | 4     | saas-onboarding-trial-start, saas-onboarding-day-3-activation, saas-onboarding-day-7-feature-tour, saas-onboarding-day-14-conversion |
| `partnership`       | 2     | partnership-announcement, partnership-affiliate-launch                                                              |
| `year_in_review`    | 1     | year-in-review                                                                                                      |
| `crisis`            | 2     | crisis-apology, crisis-pivot-announcement                                                                           |
| `cold_warm`         | 2     | cold-warm-founder-intro, cold-warm-post-event-followup                                                              |
| `misc`              | 2     | misc-testimonial-request, misc-feedback-survey                                                                      |

Each template is opinionated, substantive (every email body is 100-300 words
of real, shippable skeleton with `{{variable}}` placeholders + writer notes),
and chosen to be a credible starting point that a real newsletter writer
could ship after light editing.

## Ingestion sources

| `SourceType`            | Status   | Notes                                                 |
| ----------------------- | -------- | ----------------------------------------------------- |
| `blog_rss`              | wired    | `gofeed` + `bluemonday` HTML stripping                |
| `paste_in`              | wired    | Splits raw text on blank lines                        |
| `twitter`               | wired    | Reads user-uploaded `tweets.js` archive or API v2 with `TWITTER_BEARER_TOKEN` |
| `newsletter_archive`    | wired    | Reads `campaign_archive` when `DATABASE_URL` is set   |
| `podcast_transcript`    | wired    | Pasted transcript text; strips timestamp prefixes     |
| `linkedin_export`       | wired    | Reads pasted/uploaded CSV text or a relative export path |

Source params are validated before storage and ingestion: RSS feeds must be
public `http`/`https` URLs whose host does not resolve to localhost, private,
or reserved IP ranges; local export paths for Twitter/LinkedIn must be
relative and must not traverse directories. LinkedIn exports may also be sent
as `RawText` CSV content, which is what the web app uses for file-picker
imports.

## VoiceProfile schema (~3KB JSON)

- **Stylistic** — sentence/paragraph shape, formality, hedging, passive %.
- **Vocabulary** — top-100 distinctive terms (TF·IDF), 2..5-gram recurring
  phrases, idiom markers, LLM-extracted metaphor patterns.
- **Structural** — opening hook style (anecdote/question/statistic/declaration/mixed),
  closing pattern (cta/reflection/question/signoff/mixed), bullet-list rate,
  markdown-style hint.
- **Tonal** — humor, optimism, personal-vs-observational, directness (0..1).
- **Persona** — pronoun usage map, self-disclosure rate, recurring themes.
- **RepresentativeSamples** — up to 8K tokens of diverse, recency-weighted
  passages, used as few-shot context.
- **SourceSummary** — per-source word/item counts and last-ingested timestamps.

## HTTP routes

Non-health routes are sidecar-internal. Set `POSTWAVE_INTERNAL_API_TOKEN`
in deployed environments; callers must send `Authorization: Bearer <token>`.
When unset, non-health routes only accept loopback requests for local dev.
All routes also require `X-Tenant-ID` header (V1 tenant extraction).

| Method | Path                                                       | Purpose                                              |
| ------ | ---------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/v1/voice/sources`                                        | Register a source `{type, params}`                   |
| GET    | `/v1/voice/sources`                                        | List sources + last ingest stats                     |
| POST   | `/v1/voice/sources/{id}/ingest`                            | Kick off ingestion (202 + `job_id`)                  |
| GET    | `/v1/voice/profile`                                        | Return current VoiceProfile (404 if not built)       |
| POST   | `/v1/voice/profile/build`                                  | Rebuild profile from all ingested items              |
| GET    | `/v1/voice/templates?category={cat}`                       | List templates (optional category filter)            |
| GET    | `/v1/voice/templates/{idOrSlug}`                           | Get a single template                                |
| POST   | `/v1/voice/templates`                                      | Create a custom template (admin/internal only)       |
| POST   | `/v1/voice/sequences`                                      | Generate a sequence (202 + full Sequence body)       |
| GET    | `/v1/voice/sequences`                                      | List sequences for tenant                            |
| GET    | `/v1/voice/sequences/{id}`                                 | Get one sequence                                     |
| POST   | `/v1/voice/sequences/{id}/regenerate/{position}`           | Regenerate a single email                            |

## Remaining operational notes / TODO

- **Gemini SDK.** `GeminiClient` speaks the `generateContent` API directly
  via `net/http` with retries (1s/2s/4s on 429/5xx). We stay hand-rolled
  rather than pulling in `google.golang.org/genai` to keep the dependency
  surface small for the modest API footprint we use.
- **Template-backed generation containment.** Production fails
  `POST /v1/voice/sequences` closed with `503` while `SequenceJobs` is wired,
  because no durable worker currently owns the sequence-row/job-row terminal
  transition. `/v1/voice/sequences/jobs/{job_id}` remains available for
  historical rows. Dev/test deployments may leave the store nil to exercise
  the bounded synchronous path.
- **Stripe-billable generation cap.** The engine itself doesn't enforce a
  per-customer monthly cap; the API gateway does. Wire on top once the
  billing service lands.
- **Real performance metrics on templates.** Seeded templates can still carry
  `SampleSize: 0`; replace with a rolling 90-day cohort once analytics is wired.
- **Distinctive terms.** `internal/profile/wordfreq/freq.txt` ships a
  3,000+ entry embedded English baseline, and the builder blends it with
  writer-corpus document spread so one-off rare words do not outrank a
  tenant's recurring vocabulary.
- **Twitter API access.** `api` mode is wired through Twitter/X API v2 and
  `TWITTER_BEARER_TOKEN`, but live use still depends on the customer's API
  access level and rate limits. Archive ingestion remains the fallback.
- **Sentence segmentation.** Stdlib heuristic-based; handles common
  abbreviations, initialisms at sentence boundaries, lowercase casual starts,
  URLs, decimals, and ellipses, but still lacks a trained
  multilingual/ambiguous-quote model. Upgrade to `prose.NewDocument` or
  similar when that quality bar matters.
- **Job runner.** `/sources/{id}/ingest` persists job state when the
  Postgres-backed job store is wired, but execution still happens in an
  in-process worker goroutine. Replace with Asynq/Inngest if host crash
  recovery for active workers becomes required.
- **Volume gate.** `POST /v1/voice/profile/build` now enforces the
  "<3,000 words -> ask user for paste-in fallback" rule with a 422 response.

## License posture

This service is part of the AGPL-3.0-only Moosewave application layer. The
Listmonk process remains a separately deployed work and communicates with this
service only over HTTP. If you find yourself wanting to import anything under
`github.com/knadh/listmonk/...` here, stop, re-read
`LICENSE-BOUNDARY.md`, and use its HTTP API instead.
