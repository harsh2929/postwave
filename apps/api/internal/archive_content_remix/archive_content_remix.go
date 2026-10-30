// SPDX-License-Identifier: AGPL-3.0-only
//
// Package archive_content_remix scaffolds the Phase 3 XL feature
// "multi-modal content remix" — taking a campaign (or, eventually, up
// to six source assets) and emitting up to six derived assets in
// different formats: email follow-ups, SMS blasts, social posts
// (Twitter thread / LinkedIn / Instagram caption), blog excerpts, and
// TTS-rendered podcast episodes voiced by one of six named voices.
//
// Inspired by:
//   - HubSpot Content Remix     — the canonical "blog → 6 derived
//     assets" affordance.
//   - beehiiv AI Translator     — narrower: same content, new
//     locale/format.
//   - Substack AI clips         — long-form → short clips / transcripts.
//
// This file is the v1 SCAFFOLD. It lays down:
//
//   - The Repo type backed by the three tables in migration 0349.
//   - The narrow interfaces the worker needs (TextGenerator, TTSEngine,
//     CampaignDraftSink) so the worker can be unit-tested with fakes
//     and the real LLM / TTS vendor swapped in later.
//   - Domain types (Job, Asset, Kind) shared by the HTTP handlers,
//     the worker, and the repo.
//
// The full feature is deferred — see MIGRATION.md for the cut-list.
// Specifically, this v1 only stubs the worker generation path; the
// real LLM fan-out + TTS vendor calls are TODOs.
package archive_content_remix

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Errors surfaced to handlers. Mapped onto HTTP codes in handlers.go.
var (
	// ErrNotFound is returned by Repo lookups when no row matches.
	ErrNotFound = errors.New("archive_content_remix: not found")
	// ErrBadRequest is returned for caller-fixable input errors.
	ErrBadRequest = errors.New("archive_content_remix: bad request")
	// ErrUnavailable is returned when a required upstream (LLM, TTS)
	// is not configured for this deployment.
	ErrUnavailable = errors.New("archive_content_remix: backend unavailable")
)

// Kind enumerates the *derived* asset formats the remix produces. The
// canonical list lives here, not in the migration, so we can ship new
// formats without a DB change.
type Kind string

const (
	// KindEmailFollowup → drafts a follow-up campaign (subject + body).
	KindEmailFollowup Kind = "email_followup"
	// KindSMSBlast → drafts an SMS campaign (body + segment estimate).
	KindSMSBlast Kind = "sms_blast"
	// KindTwitterThread → emits an array of tweets respecting char caps.
	KindTwitterThread Kind = "twitter_thread"
	// KindLinkedInPost → single LinkedIn post with hook + CTA.
	KindLinkedInPost Kind = "linkedin_post"
	// KindInstagramCaption → caption + alt-text + hashtag suggestions.
	KindInstagramCaption Kind = "instagram_caption"
	// KindPodcastEpisode → TTS-rendered MP3 + script. Triggers a
	// follow-on row in content_remix_tts_jobs.
	KindPodcastEpisode Kind = "podcast_episode"
	// KindBlogExcerpt → short blog post derived from the source.
	KindBlogExcerpt Kind = "blog_excerpt"
)

// AllKinds is the canonical set of supported derived kinds. The HTTP
// handler validates the operator's requested_kinds against this list.
var AllKinds = []Kind{
	KindEmailFollowup,
	KindSMSBlast,
	KindTwitterThread,
	KindLinkedInPost,
	KindInstagramCaption,
	KindPodcastEpisode,
	KindBlogExcerpt,
}

// MaxDerivedKinds caps how many derived assets one job can request.
// Matches HubSpot's Content Remix (up to 6 outputs per source).
const MaxDerivedKinds = 6

// MaxSourceAssets reserves headroom for the multi-source future.
// HubSpot allows up to 6 source assets per remix; v1 wires a single
// source_campaign_id and reserves the rest for the future via the
// content_remix_jobs.extra_source_ids array.
const MaxSourceAssets = 6

// Voice enumerates the six named voices the TTS engine offers. The
// values map to vendor-specific voice IDs inside the TTS adapter.
// (HubSpot's Content Remix ships with six named voices and we mirror
// that for parity in the UI.)
type Voice string

const (
	VoiceAva    Voice = "ava"    // warm, conversational, US English
	VoiceMarcus Voice = "marcus" // deep, authoritative, US English
	VoiceLuna   Voice = "luna"   // bright, expressive, UK English
	VoiceKai    Voice = "kai"    // measured, narrator, UK English
	VoiceNova   Voice = "nova"   // energetic, marketing, US English
	VoiceOrion  Voice = "orion"  // calm, podcaster, neutral
)

// AllVoices is the canonical voice catalog the UI surfaces.
var AllVoices = []Voice{
	VoiceAva, VoiceMarcus, VoiceLuna, VoiceKai, VoiceNova, VoiceOrion,
}

// IsValidKind reports whether k is one of the supported derived kinds.
func IsValidKind(k Kind) bool {
	for _, kk := range AllKinds {
		if kk == k {
			return true
		}
	}
	return false
}

// IsValidVoice reports whether v is one of the six named voices.
func IsValidVoice(v Voice) bool {
	for _, vv := range AllVoices {
		if vv == v {
			return true
		}
	}
	return false
}

// JobStatus / AssetStatus mirror the CHECK constraints in 0349.
type JobStatus string
type AssetStatus string

const (
	JobPending    JobStatus = "pending"
	JobGenerating JobStatus = "generating"
	JobCompleted  JobStatus = "completed"
	JobFailed     JobStatus = "failed"
	JobCancelled  JobStatus = "cancelled"

	AssetPending    AssetStatus = "pending"
	AssetGenerating AssetStatus = "generating"
	AssetReady      AssetStatus = "ready"
	AssetFailed     AssetStatus = "failed"
)

// Job is the parent row — one per user-initiated remix request.
type Job struct {
	ID               string     `json:"id"`
	TenantID         string     `json:"tenant_id"`
	SourceCampaignID string     `json:"source_campaign_id,omitempty"`
	Name             string     `json:"name"`
	Brief            string     `json:"brief,omitempty"`
	Status           JobStatus  `json:"status"`
	RequestedKinds   []string   `json:"requested_kinds"`
	Actor            string     `json:"actor,omitempty"`
	LastError        string     `json:"last_error,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	CompletedAt      *time.Time `json:"completed_at,omitempty"`
}

// Asset is one *derived* output row.
type Asset struct {
	ID              string          `json:"id"`
	TenantID        string          `json:"tenant_id"`
	JobID           string          `json:"job_id"`
	Kind            Kind            `json:"kind"`
	Status          AssetStatus     `json:"status"`
	Payload         json.RawMessage `json:"payload,omitempty"`
	DraftCampaignID string          `json:"draft_campaign_id,omitempty"`
	Attempts        int             `json:"attempts"`
	LastError       string          `json:"last_error,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
	CompletedAt     *time.Time      `json:"completed_at,omitempty"`
}

// CreateJobInput is the body of POST /api/v1/campaigns/{id}/remix.
type CreateJobInput struct {
	// Name is the operator-facing label. Optional; defaults to
	// "Remix of <campaign_name>".
	Name string `json:"name,omitempty"`
	// Brief is free-form context handed to the LLM ("focus on the
	// pricing change", "target paid annual subscribers", ...).
	Brief string `json:"brief,omitempty"`
	// Kinds is the list of derived asset kinds to produce. Required;
	// must be non-empty and a subset of AllKinds, capped at
	// MaxDerivedKinds. Duplicates are deduped.
	Kinds []Kind `json:"kinds"`
	// PodcastVoice is required when KindPodcastEpisode is in Kinds.
	// Must be one of AllVoices.
	PodcastVoice Voice `json:"podcast_voice,omitempty"`
}

// Repo is the persistence surface. All methods expect to run inside a
// transaction with the tenant_id GUC set (use db.WithTenant).
type Repo struct {
	Pool *db.Pool
}

// CreateJob inserts a job + the requested asset rows in one transaction.
// The worker picks the assets up via ClaimPending.
func (r *Repo) CreateJob(ctx context.Context, tenantID string, in CreateJobInput, sourceCampaignID, actor string) (*Job, []Asset, error) {
	if r == nil || r.Pool == nil {
		return nil, nil, fmt.Errorf("%w: repo not configured", ErrUnavailable)
	}
	if len(in.Kinds) == 0 {
		return nil, nil, fmt.Errorf("%w: at least one kind is required", ErrBadRequest)
	}
	if len(in.Kinds) > MaxDerivedKinds {
		return nil, nil, fmt.Errorf("%w: kinds capped at %d", ErrBadRequest, MaxDerivedKinds)
	}
	dedup := dedupeKinds(in.Kinds)
	for _, k := range dedup {
		if !IsValidKind(k) {
			return nil, nil, fmt.Errorf("%w: unknown kind %q", ErrBadRequest, k)
		}
	}
	hasPodcast := false
	for _, k := range dedup {
		if k == KindPodcastEpisode {
			hasPodcast = true
			break
		}
	}
	if hasPodcast && in.PodcastVoice == "" {
		return nil, nil, fmt.Errorf("%w: podcast_voice is required when podcast_episode is selected", ErrBadRequest)
	}
	if hasPodcast && !IsValidVoice(in.PodcastVoice) {
		return nil, nil, fmt.Errorf("%w: unknown podcast_voice %q", ErrBadRequest, in.PodcastVoice)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	name := in.Name
	if name == "" {
		name = "Remix"
	}
	kindsText := make([]string, 0, len(dedup))
	for _, k := range dedup {
		kindsText = append(kindsText, string(k))
	}

	var jobID string
	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `
INSERT INTO content_remix_jobs (tenant_id, source_campaign_id, name, brief, requested_kinds, actor)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6)
RETURNING id::text, created_at, updated_at`,
		tenantID, sourceCampaignID, name, in.Brief, kindsText, actorOrSystem(actor)).
		Scan(&jobID, &createdAt, &updatedAt)
	if err != nil {
		return nil, nil, fmt.Errorf("insert job: %w", err)
	}

	job := &Job{
		ID:               jobID,
		TenantID:         tenantID,
		SourceCampaignID: sourceCampaignID,
		Name:             name,
		Brief:            in.Brief,
		Status:           JobPending,
		RequestedKinds:   kindsText,
		Actor:            actorOrSystem(actor),
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
	}

	assets := make([]Asset, 0, len(dedup))
	for _, k := range dedup {
		var aID string
		var aCreated, aUpdated time.Time
		err = tx.QueryRow(ctx, `
INSERT INTO content_remix_assets (tenant_id, job_id, kind)
VALUES ($1::uuid, $2::uuid, $3)
RETURNING id::text, created_at, updated_at`,
			tenantID, jobID, string(k)).Scan(&aID, &aCreated, &aUpdated)
		if err != nil {
			return nil, nil, fmt.Errorf("insert asset %q: %w", k, err)
		}
		assets = append(assets, Asset{
			ID:        aID,
			TenantID:  tenantID,
			JobID:     jobID,
			Kind:      k,
			Status:    AssetPending,
			CreatedAt: aCreated,
			UpdatedAt: aUpdated,
		})
		// For podcast kinds, also queue the TTS child row so the TTS
		// worker has something to claim. The actual rendering is
		// deferred (see MIGRATION.md).
		if k == KindPodcastEpisode {
			_, err = tx.Exec(ctx, `
INSERT INTO content_remix_tts_jobs (tenant_id, asset_id, voice)
VALUES ($1::uuid, $2::uuid, $3)`, tenantID, aID, string(in.PodcastVoice))
			if err != nil {
				return nil, nil, fmt.Errorf("insert tts job: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, fmt.Errorf("commit: %w", err)
	}
	return job, assets, nil
}

// GetJob loads a job by id, scoped to the tenant via RLS.
func (r *Repo) GetJob(ctx context.Context, tenantID, jobID string) (*Job, []Asset, error) {
	if r == nil || r.Pool == nil {
		return nil, nil, fmt.Errorf("%w: repo not configured", ErrUnavailable)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	job, err := loadJobTx(ctx, tx, jobID)
	if err != nil {
		return nil, nil, err
	}
	assets, err := loadAssetsForJobTx(ctx, tx, jobID)
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return job, assets, nil
}

// ListJobs returns the most recent N jobs for the tenant.
func (r *Repo) ListJobs(ctx context.Context, tenantID string, limit int) ([]Job, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repo not configured", ErrUnavailable)
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(source_campaign_id::text,''),
       name, COALESCE(brief,''), status, requested_kinds,
       COALESCE(actor,''), COALESCE(last_error,''),
       created_at, updated_at, completed_at
  FROM content_remix_jobs
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Job, 0, limit)
	for rows.Next() {
		var j Job
		var completedAt *time.Time
		if err := rows.Scan(&j.ID, &j.TenantID, &j.SourceCampaignID,
			&j.Name, &j.Brief, &j.Status, &j.RequestedKinds,
			&j.Actor, &j.LastError,
			&j.CreatedAt, &j.UpdatedAt, &completedAt); err != nil {
			return nil, err
		}
		j.CompletedAt = completedAt
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// loadJobTx is a small helper that hits the job row inside an open tx.
func loadJobTx(ctx context.Context, tx pgx.Tx, jobID string) (*Job, error) {
	var j Job
	var completedAt *time.Time
	err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, COALESCE(source_campaign_id::text,''),
       name, COALESCE(brief,''), status, requested_kinds,
       COALESCE(actor,''), COALESCE(last_error,''),
       created_at, updated_at, completed_at
  FROM content_remix_jobs
 WHERE id = $1::uuid`, jobID).
		Scan(&j.ID, &j.TenantID, &j.SourceCampaignID,
			&j.Name, &j.Brief, &j.Status, &j.RequestedKinds,
			&j.Actor, &j.LastError,
			&j.CreatedAt, &j.UpdatedAt, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	j.CompletedAt = completedAt
	return &j, nil
}

func loadAssetsForJobTx(ctx context.Context, tx pgx.Tx, jobID string) ([]Asset, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, job_id::text, kind, status,
       COALESCE(payload, '{}'::jsonb),
       COALESCE(draft_campaign_id::text,''),
       attempts, COALESCE(last_error,''),
       created_at, updated_at, completed_at
  FROM content_remix_assets
 WHERE job_id = $1::uuid
 ORDER BY created_at ASC`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Asset{}
	for rows.Next() {
		var a Asset
		var completedAt *time.Time
		if err := rows.Scan(&a.ID, &a.TenantID, &a.JobID, &a.Kind, &a.Status,
			&a.Payload, &a.DraftCampaignID, &a.Attempts, &a.LastError,
			&a.CreatedAt, &a.UpdatedAt, &completedAt); err != nil {
			return nil, err
		}
		a.CompletedAt = completedAt
		out = append(out, a)
	}
	return out, rows.Err()
}

func dedupeKinds(in []Kind) []Kind {
	seen := map[Kind]struct{}{}
	out := make([]Kind, 0, len(in))
	for _, k := range in {
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	return out
}

func actorOrSystem(a string) string {
	if a == "" {
		return "system"
	}
	return a
}
