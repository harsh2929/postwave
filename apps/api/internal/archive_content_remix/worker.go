// SPDX-License-Identifier: AGPL-3.0-only
package archive_content_remix

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TextGenerator is the narrow LLM surface the worker needs to produce
// kind-specific text payloads (email/sms/social/blog). The production
// implementation will be backed by the existing aicompose.Composer or
// a direct voice-service call; the worker takes the interface so
// unit-tests can pass a fake without touching the network.
//
// Generate is given the source campaign body + the operator brief +
// the target Kind, and must return a JSON-serializable payload shape
// matching the Kind's contract documented on Asset.Payload.
type TextGenerator interface {
	Generate(ctx context.Context, tenantID string, kind Kind, sourceBody, brief string) (json.RawMessage, error)
}

// TTSEngine renders a podcast script into audio. The production
// implementation will be one of ElevenLabs / OpenAI tts-1 / Azure
// Speech / Play.ht — wired through the existing assets package so the
// audio is served via signed URLs the same way attachments are.
//
// Render returns the new audio asset id (uuid) and the audio duration.
// The worker writes both into content_remix_tts_jobs.
type TTSEngine interface {
	Render(ctx context.Context, tenantID string, voice Voice, script string) (audioAssetID string, durationMS int, err error)
}

// CampaignDraftSink saves an email/sms derived asset as a draft campaign
// so the operator can edit + schedule. The campaigns package owns the
// canonical schema; this interface lets us inject the sink without an
// import cycle.
type CampaignDraftSink interface {
	SaveDraft(ctx context.Context, tenantID string, kind Kind, payload json.RawMessage) (campaignID string, err error)
}

// WorkerConfig caps and tunables.
type WorkerConfig struct {
	// PollInterval is how often the worker scans for pending assets
	// when the queue was empty on the last pass. Default 10s.
	PollInterval time.Duration
	// BatchSize is how many assets the worker claims per pass. Default 8.
	BatchSize int
	// MaxAttempts caps per-asset retries before the worker flips the
	// row to status='failed'. Default 3.
	MaxAttempts int
	// LeaseDuration is how long a claimed-but-not-yet-completed asset
	// stays leased. Default 5min.
	LeaseDuration time.Duration
}

func (c WorkerConfig) withDefaults() WorkerConfig {
	if c.PollInterval <= 0 {
		c.PollInterval = 10 * time.Second
	}
	if c.BatchSize <= 0 {
		c.BatchSize = 8
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = 3
	}
	if c.LeaseDuration <= 0 {
		c.LeaseDuration = 5 * time.Minute
	}
	return c
}

// Worker drives the remix queue. Wire it into main with safego.Go.
//
//	w := archive_content_remix.NewWorker(pool, generator, tts, sink, cfg)
//	safego.Go(logger, "content-remix-worker", func() { w.Run(ctx) })
//
// The worker is a SCAFFOLD — generation logic is stubbed (see
// processAsset). Filling it in is part of the deferred work in
// MIGRATION.md.
type Worker struct {
	Pool      *db.Pool
	Generator TextGenerator
	TTS       TTSEngine
	Sink      CampaignDraftSink
	Cfg       WorkerConfig
}

// NewWorker constructs a worker with default config.
func NewWorker(pool *db.Pool, gen TextGenerator, tts TTSEngine, sink CampaignDraftSink, cfg WorkerConfig) *Worker {
	return &Worker{
		Pool:      pool,
		Generator: gen,
		TTS:       tts,
		Sink:      sink,
		Cfg:       cfg.withDefaults(),
	}
}

// Run polls the queue until ctx is cancelled. Errors are logged but
// never bubble — the loop is meant to survive transient DB blips.
//
// Flow per iteration:
//  1. ClaimPending: take up to BatchSize pending asset rows whose
//     scheduled_at is in the past, lease them for LeaseDuration.
//  2. For each claimed asset, dispatch to processAsset (kind-specific).
//  3. processAsset writes the payload + status=ready, or bumps
//     attempts and reschedules for a back-off retry.
//  4. After the batch, sweep parent jobs whose children are all
//     terminal and flip status='completed'.
//
// The actual LLM/TTS calls inside processAsset are STUBS in this v1.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Pool == nil {
		return
	}
	timer := time.NewTimer(w.Cfg.PollInterval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		// TODO(remix-worker): claim a batch, fan out goroutines, sweep
		// parent-job completion. The v1 scaffold short-circuits to a
		// poll-sleep loop; see MIGRATION.md "Phase 2: Worker".
		_ = w.tickStub(ctx)
		timer.Reset(w.Cfg.PollInterval)
	}
}

// tickStub is the v1 placeholder for one worker iteration. It runs the
// completion-sweep step (which is safe + idempotent) so jobs with no
// requested kinds still terminate cleanly, but it does NOT yet claim +
// generate. The real generation path is the deferred work.
func (w *Worker) tickStub(ctx context.Context) error {
	if w.Pool == nil {
		return nil
	}
	// The cross-tenant sweep needs the outbox_worker GUC; the workers
	// in production set this on a worker-scoped connection. For the
	// stub we acquire a plain connection — the SQL is read-mostly and
	// the UPDATE is bounded.
	conn, err := w.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SET LOCAL "app.outbox_worker" = 'true'`); err != nil {
		return err
	}
	// Mark jobs as completed once all their children are terminal.
	_, err = conn.Exec(ctx, `
UPDATE content_remix_jobs j
   SET status = CASE
       WHEN NOT EXISTS (
           SELECT 1 FROM content_remix_assets a
            WHERE a.job_id = j.id AND a.status = 'failed'
       ) THEN 'completed'
       ELSE 'failed'
   END,
       completed_at = COALESCE(j.completed_at, now()),
       updated_at = now()
 WHERE j.status IN ('pending','generating')
   AND NOT EXISTS (
       SELECT 1 FROM content_remix_assets a
        WHERE a.job_id = j.id
          AND a.status NOT IN ('ready','failed')
   )
   AND EXISTS (SELECT 1 FROM content_remix_assets a WHERE a.job_id = j.id)`)
	return err
}

// processAsset is the per-asset dispatch table. STUB in v1 — the
// production version fan-outs to TextGenerator and TTSEngine. We keep
// the signature stable so swapping in the real impl is a one-file diff.
//
// Returns the generated payload (kind-specific JSON) and the
// optional draft_campaign_id for campaign-backed kinds.
func (w *Worker) processAsset(ctx context.Context, tenantID string, a Asset, sourceBody, brief string) (json.RawMessage, string, error) {
	switch a.Kind {
	case KindEmailFollowup, KindSMSBlast, KindTwitterThread,
		KindLinkedInPost, KindInstagramCaption, KindBlogExcerpt:
		if w.Generator == nil {
			return nil, "", fmt.Errorf("%w: text generator not configured", ErrUnavailable)
		}
		payload, err := w.Generator.Generate(ctx, tenantID, a.Kind, sourceBody, brief)
		if err != nil {
			return nil, "", err
		}
		// For campaign-backed kinds, save as a draft so the operator
		// can edit + schedule. Sink is optional — if unset, the
		// caller can still read the payload via GET.
		if (a.Kind == KindEmailFollowup || a.Kind == KindSMSBlast) && w.Sink != nil {
			id, err := w.Sink.SaveDraft(ctx, tenantID, a.Kind, payload)
			if err != nil {
				return payload, "", err
			}
			return payload, id, nil
		}
		return payload, "", nil
	case KindPodcastEpisode:
		if w.Generator == nil || w.TTS == nil {
			return nil, "", fmt.Errorf("%w: podcast pipeline not configured", ErrUnavailable)
		}
		// Two-step: generate the script with the text generator, then
		// hand the script off to the TTS engine. The TTS row in
		// content_remix_tts_jobs gets updated by the TTS worker — for
		// v1 we inline the call so the happy-path stub compiles.
		scriptPayload, err := w.Generator.Generate(ctx, tenantID, a.Kind, sourceBody, brief)
		if err != nil {
			return nil, "", err
		}
		var s struct {
			Script string `json:"script"`
			Voice  Voice  `json:"voice"`
		}
		_ = json.Unmarshal(scriptPayload, &s)
		if s.Voice == "" {
			s.Voice = VoiceOrion
		}
		audioID, durMS, err := w.TTS.Render(ctx, tenantID, s.Voice, s.Script)
		if err != nil {
			return scriptPayload, "", err
		}
		// Re-marshal payload with the audio metadata merged in. The
		// JSON shape is documented on Asset.Payload.
		var raw map[string]any
		_ = json.Unmarshal(scriptPayload, &raw)
		if raw == nil {
			raw = map[string]any{}
		}
		raw["audio_asset_id"] = audioID
		raw["duration_ms"] = durMS
		raw["voice"] = string(s.Voice)
		merged, _ := json.Marshal(raw)
		return merged, "", nil
	default:
		return nil, "", fmt.Errorf("%w: unsupported kind %q", ErrBadRequest, a.Kind)
	}
}
