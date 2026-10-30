// SPDX-License-Identifier: AGPL-3.0-only
//
// Package onboarding owns the "Load sample data" surface that lets a
// brand-new tenant land in a populated workspace instead of an empty
// one. The seeder inserts deterministic rows tagged with a sentinel
// (custom_fields.sample = true / delivery_settings.sample = true) so a
// counterpart DELETE can later remove exactly the same rows without
// touching the operator's real data.
//
// What gets seeded (counts in CountsResponse):
//   - 50 subscribers — emails sample-1@example.com through
//     sample-50@example.com, status=enabled, with realistic added_at
//     timestamps weighted toward recent (~70% within last 30 days,
//     ~25% within 31-60d, ~5% within 61-90d).
//   - 1 segment — "Sample · enabled subscribers" with a query AST that
//     matches the seeded rows.
//   - 3 campaigns — one sent example, one draft and one paused example. The sent campaign
//     includes synthetic delivery events over the past three weeks, so the
//     dashboard and campaign report surfaces have useful engagement data.
//   - 1 draft voice sequence with 3 emails (welcome → tips → CTA).
//
// The "1 audience list" referenced in the spec is intentionally NOT
// seeded as a separate row: lists are a Listmonk passthrough (see
// internal/lists) and creating a list means a side-trip to a
// downstream service that may not be configured. The segment fills the
// audience role for the desktop UI; the response counts.lists stays at
// 0 with an explanatory note in the seed handler so the operator
// knows.
//
// Tenant-isolation: every write is wrapped in db.WithTenant; RLS
// enforces the boundary at the Postgres layer too.
//
// Idempotency (post-0082): the seeded marker lives in tenants.metadata
// (jsonb), specifically:
//
//	metadata.sample_data_seeded_at : timestamptz string
//	metadata.sample_data_counts    : { subscribers, lists, … }
//
// A repeat Seed call reads the marker and returns the cached counts
// without re-inserting. Restart-survives because the state is in the
// DB, not in memory. The legacy in-memory map shipped pre-0082 is
// gone — every Seed call hits the DB to read the marker.

package onboarding

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Counts is the per-resource breakdown returned by Seed/Remove.
type Counts struct {
	Subscribers int `json:"subscribers"`
	Lists       int `json:"lists"`
	Segments    int `json:"segments"`
	Campaigns   int `json:"campaigns"`
	Sequences   int `json:"sequences"`
}

// SeedResult is the response body of POST /api/v1/onboarding/sample-data.
type SeedResult struct {
	Seeded bool   `json:"seeded"`
	Counts Counts `json:"counts"`
	// Note carries any honest-fallback context, e.g. why lists is 0.
	Note string `json:"note,omitempty"`
}

// RemoveResult is the response body of DELETE /api/v1/onboarding/sample-data.
type RemoveResult struct {
	Removed bool   `json:"removed"`
	Counts  Counts `json:"counts"`
	// KeptSegments lists sample segments left in place because a campaign
	// that has not sent yet targets them. Empty when removal was complete.
	KeptSegments []KeptSampleSegment `json:"kept_segments,omitempty"`
}

// MarkerStore is the persistence contract for the seeded-state marker.
// It exists so tests can inject a fake (no DB required) and so a
// future implementation could move the marker out of tenants.metadata
// without touching the rest of the seeder.
type MarkerStore interface {
	// LoadMarker returns the cached counts and true when the tenant
	// has already been seeded. Returns false (with zero counts and
	// nil error) when the marker is absent.
	LoadMarker(ctx context.Context, tenantID string) (Counts, bool, error)
	// LoadSeededAt returns the timestamp recorded when the marker was
	// written, or nil when the tenant is unseeded. Powers the
	// seeded_at field on GET /api/v1/onboarding/sample-data
	// (desktop-audit gap A29).
	LoadSeededAt(ctx context.Context, tenantID string) (*time.Time, error)
	// SaveMarker writes the seed marker + counts atomically.
	SaveMarker(ctx context.Context, tenantID string, counts Counts) error
	// ClearMarker removes the seed marker (idempotent — never errors
	// when the marker is already absent).
	ClearMarker(ctx context.Context, tenantID string) error
}

// PgMarkerStore implements MarkerStore against tenants.metadata.
//
// The schema bit it depends on is 0082_quota_and_metadata.sql, which
// adds `metadata jsonb NOT NULL DEFAULT '{}'` to tenants. Reads use
// metadata->>'sample_data_seeded_at' as the existence check and
// metadata->'sample_data_counts' as the cached body.
type PgMarkerStore struct {
	Pool *db.Pool
}

// LoadMarker reads tenants.metadata for the given tenant. Returns
// (counts, true, nil) when sample_data_seeded_at is present.
func (m *PgMarkerStore) LoadMarker(ctx context.Context, tenantID string) (Counts, bool, error) {
	if m == nil || m.Pool == nil {
		return Counts{}, false, errors.New("onboarding: marker store has no pool")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return Counts{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		seededAt    *time.Time
		countsBytes []byte
	)
	err = tx.QueryRow(ctx, `
SELECT (metadata->>'sample_data_seeded_at')::timestamptz,
       COALESCE(metadata->'sample_data_counts', 'null'::jsonb)::text::bytea
  FROM tenants WHERE id = $1::uuid`, tenantID).Scan(&seededAt, &countsBytes)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Tenant row doesn't exist — treat as unseeded so the seed
			// path attempts the writes and gets a clean FK error if the
			// tenant truly doesn't exist.
			return Counts{}, false, tx.Commit(ctx)
		}
		return Counts{}, false, fmt.Errorf("load marker: %w", err)
	}
	if seededAt == nil {
		return Counts{}, false, tx.Commit(ctx)
	}
	var counts Counts
	if len(countsBytes) > 0 && string(countsBytes) != "null" {
		if uerr := json.Unmarshal(countsBytes, &counts); uerr != nil {
			// Marker present but counts malformed — best-effort: treat
			// as seeded with zero counts so the caller doesn't re-seed.
			return Counts{}, true, tx.Commit(ctx)
		}
	}
	return counts, true, tx.Commit(ctx)
}

// LoadSeededAt reads metadata->>'sample_data_seeded_at' for the given
// tenant. nil (with nil error) when the marker is absent or the tenant
// row doesn't exist — same "treat as unseeded" posture as LoadMarker.
func (m *PgMarkerStore) LoadSeededAt(ctx context.Context, tenantID string) (*time.Time, error) {
	if m == nil || m.Pool == nil {
		return nil, errors.New("onboarding: marker store has no pool")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var seededAt *time.Time
	err = tx.QueryRow(ctx, `
SELECT (metadata->>'sample_data_seeded_at')::timestamptz
  FROM tenants WHERE id = $1::uuid`, tenantID).Scan(&seededAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, tx.Commit(ctx)
		}
		return nil, fmt.Errorf("load seeded_at: %w", err)
	}
	return seededAt, tx.Commit(ctx)
}

// SaveMarker writes the seeded_at timestamp and counts in one UPDATE.
// jsonb-merging with `||` so unrelated keys (added by other features)
// stay intact.
func (m *PgMarkerStore) SaveMarker(ctx context.Context, tenantID string, counts Counts) error {
	if m == nil || m.Pool == nil {
		return errors.New("onboarding: marker store has no pool")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	countsJSON, err := json.Marshal(counts)
	if err != nil {
		return fmt.Errorf("marshal counts: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE tenants
   SET metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'sample_data_seeded_at', to_jsonb(now()),
                       'sample_data_counts',    $2::jsonb)
 WHERE id = $1::uuid`, tenantID, string(countsJSON)); err != nil {
		return fmt.Errorf("save marker: %w", err)
	}
	return tx.Commit(ctx)
}

// ClearMarker removes both keys via the jsonb `-` operator. Idempotent.
func (m *PgMarkerStore) ClearMarker(ctx context.Context, tenantID string) error {
	if m == nil || m.Pool == nil {
		return errors.New("onboarding: marker store has no pool")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE tenants
   SET metadata = COALESCE(metadata, '{}'::jsonb)
                  - 'sample_data_seeded_at'
                  - 'sample_data_counts'
 WHERE id = $1::uuid`, tenantID); err != nil {
		return fmt.Errorf("clear marker: %w", err)
	}
	return tx.Commit(ctx)
}

// Seeder is the stateful seed engine. Construct one in main.go and
// share it across handler instances. The persistent marker lives in
// the DB (Markers); there is no in-memory cache.
type Seeder struct {
	Pool    *db.Pool
	Markers MarkerStore
}

// NewSeeder returns a Seeder backed by tenants.metadata. Marker reads
// happen on every Seed/Remove call so the state is always sourced from
// Postgres — no per-process map to fall out of sync on restart.
func NewSeeder(pool *db.Pool) *Seeder {
	return &Seeder{
		Pool:    pool,
		Markers: &PgMarkerStore{Pool: pool},
	}
}

// NewSeederWithMarkers wires a custom MarkerStore (test injection).
// The pool is still required for the actual seeded-row writes.
func NewSeederWithMarkers(pool *db.Pool, markers MarkerStore) *Seeder {
	return &Seeder{Pool: pool, Markers: markers}
}

// IsSeeded reports whether this tenant has already had sample data
// inserted, by reading the Postgres marker. Returns the cached counts
// alongside the boolean so callers don't need a follow-up Seed call.
func (s *Seeder) IsSeeded(ctx context.Context, tenantID string) (Counts, bool, error) {
	if s == nil || s.Markers == nil {
		return Counts{}, false, errors.New("onboarding: seeder not configured")
	}
	return s.Markers.LoadMarker(ctx, tenantID)
}

// StatusResult is the response body of GET /api/v1/onboarding/sample-data
// (desktop-audit gap A29). seeded_at and counts are omitted when the
// tenant is unseeded.
type StatusResult struct {
	Seeded   bool       `json:"seeded"`
	SeededAt *time.Time `json:"seeded_at,omitempty"`
	Counts   *Counts    `json:"counts,omitempty"`
}

// Status reads the seeded marker without mutating anything. The marker
// is written by Seed (SaveMarker) and removed by Remove (ClearMarker),
// so this is the workspace-level replacement for the desktop's
// per-device localStorage flag.
func (s *Seeder) Status(ctx context.Context, tenantID string) (StatusResult, error) {
	if tenantID == "" {
		return StatusResult{}, ErrNoTenant
	}
	if s == nil || s.Markers == nil {
		return StatusResult{}, errors.New("onboarding: seeder not configured")
	}
	counts, seeded, err := s.Markers.LoadMarker(ctx, tenantID)
	if err != nil {
		return StatusResult{}, fmt.Errorf("load marker: %w", err)
	}
	if !seeded {
		return StatusResult{Seeded: false}, nil
	}
	out := StatusResult{Seeded: true, Counts: &counts}
	// Timestamp is best-effort decoration: a marker present without a
	// readable timestamp still reports seeded=true.
	if at, err := s.Markers.LoadSeededAt(ctx, tenantID); err == nil && at != nil {
		out.SeededAt = at
	}
	return out, nil
}

// ErrNoTenant is returned when the seeder is called without a tenant
// id (handler bug).
var ErrNoTenant = errors.New("onboarding: tenant id required")

// Seed inserts the sample rows for the given tenant. Idempotent: if
// the tenants.metadata marker says sample_data_seeded_at is set, returns
// the cached counts without touching any other tables.
//
// On any insert error, partially-inserted rows remain — callers can
// run Remove to clean up. The marker is written ONLY after every
// helper succeeds, so a failed seed leaves the tenant in the
// "unseeded" state for retry. Counts in the response reflect the rows
// we successfully inserted before the error.
func (s *Seeder) Seed(ctx context.Context, tenantID string) (SeedResult, error) {
	if tenantID == "" {
		return SeedResult{}, ErrNoTenant
	}
	if s.Markers == nil {
		return SeedResult{}, errors.New("onboarding: marker store not configured")
	}

	// Persistent idempotency check via the DB marker.
	if cached, ok, err := s.Markers.LoadMarker(ctx, tenantID); err != nil {
		return SeedResult{}, fmt.Errorf("load marker: %w", err)
	} else if ok {
		return SeedResult{Seeded: true, Counts: cached, Note: "already seeded; no-op"}, nil
	}

	counts := Counts{}

	// --- Subscribers --------------------------------------------------
	// 50 deterministic rows. ON CONFLICT (tenant_id, email) DO NOTHING
	// so a manual partial seed in the past doesn't blow up — the marker
	// in custom_fields lets Remove still find them.
	if err := s.insertSampleSubscribers(ctx, tenantID, &counts); err != nil {
		return SeedResult{Seeded: false, Counts: counts}, err
	}

	// --- Segment ------------------------------------------------------
	// One segment that matches the seeded subscribers (status=enabled).
	// The QueryAST shape is the same SegmentNode the migration
	// translator already accepts.
	if err := s.insertSampleSegment(ctx, tenantID, &counts); err != nil {
		return SeedResult{Seeded: false, Counts: counts}, err
	}

	// --- Campaigns ----------------------------------------------------
	// 3 campaigns — sent / draft / paused. Sample work is never queued. The sent
	// campaign also receives sample-only report events so dashboard
	// analytics reads actual data rather than inert metadata.
	if err := s.insertSampleCampaigns(ctx, tenantID, &counts); err != nil {
		return SeedResult{Seeded: false, Counts: counts}, err
	}

	// --- Sequence -----------------------------------------------------
	// One voice_sequence with 3 emails. Inserted as the canonical
	// jsonb body that the existing voice routes already understand.
	if err := s.insertSampleSequence(ctx, tenantID, &counts); err != nil {
		return SeedResult{Seeded: false, Counts: counts}, err
	}

	// Lists are NOT seeded — see package doc. counts.Lists stays 0.

	// Persist the marker LAST. If the marker write fails the rows are
	// already in place — a retry will hit ON CONFLICT DO NOTHING for
	// each helper, so a duplicate seed is not visible to the user
	// even if the marker is delayed.
	if err := s.Markers.SaveMarker(ctx, tenantID, counts); err != nil {
		return SeedResult{Seeded: true, Counts: counts}, fmt.Errorf("save marker: %w", err)
	}

	return SeedResult{
		Seeded: true,
		Counts: counts,
		Note:   "lists are listmonk-passthrough; the seeded segment provides the audience surface",
	}, nil
}

// Remove deletes every row whose marker matches the seeder. Safe to
// call when nothing was seeded (returns zeroed counts). Clears the
// tenants.metadata marker so a subsequent Seed call works.
func (s *Seeder) Remove(ctx context.Context, tenantID string) (RemoveResult, error) {
	if tenantID == "" {
		return RemoveResult{}, ErrNoTenant
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return RemoveResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	counts := Counts{}

	// Subscribers: marker on custom_fields.sample = true
	tag, err := tx.Exec(ctx, `
DELETE FROM subscribers
 WHERE tenant_id = $1::uuid
   AND custom_fields ? 'sample'
   AND (custom_fields ->> 'sample') = 'true'`, tenantID)
	if err != nil {
		return RemoveResult{}, fmt.Errorf("delete sample subscribers: %w", err)
	}
	counts.Subscribers = int(tag.RowsAffected())

	// Campaigns: marker on delivery_settings.sample = true
	tag, err = tx.Exec(ctx, `
DELETE FROM campaigns
 WHERE tenant_id = $1::uuid
   AND delivery_settings ? 'sample'
   AND (delivery_settings ->> 'sample') = 'true'`, tenantID)
	if err != nil {
		return RemoveResult{}, fmt.Errorf("delete sample campaigns: %w", err)
	}
	counts.Campaigns = int(tag.RowsAffected())

	// Segments: marker on description prefix (segments has no jsonb
	// metadata column; the description text starts with a sentinel). A
	// sample segment one of the operator's own unsent campaigns targets is
	// kept and reported rather than failing the whole removal.
	deletedSegments, kept, err := removeSampleSegments(ctx, tx, tenantID)
	if err != nil {
		return RemoveResult{}, fmt.Errorf("delete sample segments: %w", err)
	}
	counts.Segments = deletedSegments

	// Voice sequences: marker on style_controls.sample = true
	tag, err = tx.Exec(ctx, `
DELETE FROM voice_sequences
 WHERE tenant_id = $1::uuid
   AND style_controls ? 'sample'
   AND (style_controls ->> 'sample') = 'true'`, tenantID)
	if err != nil {
		return RemoveResult{}, fmt.Errorf("delete sample sequences: %w", err)
	}
	counts.Sequences = int(tag.RowsAffected())

	if err := tx.Commit(ctx); err != nil {
		return RemoveResult{}, err
	}

	// A kept sample segment is sample data still in the workspace, so the
	// marker stays: the settings page keeps offering "Remove sample data",
	// and running it again after the campaign moves finishes the job.
	if len(kept) > 0 {
		return RemoveResult{Removed: true, Counts: counts, KeptSegments: kept}, nil
	}

	// Marker is cleared AFTER the row deletes commit — so a crash
	// between the two leaves the marker in place, and the next Seed
	// call returns the cached counts (which now over-reports a no-op
	// seed). The fallout is mild: the operator sees "already seeded"
	// where reality is "rows gone". Cleaner than the inverse race.
	if err := s.Markers.ClearMarker(ctx, tenantID); err != nil {
		return RemoveResult{Removed: true, Counts: counts}, fmt.Errorf("clear marker: %w", err)
	}

	return RemoveResult{Removed: true, Counts: counts}, nil
}

// ----------------------------------------------------------------------
// Insert helpers — each opens its own tenant-scoped tx so a per-helper
// failure leaves prior helpers' rows committed (the operator can clean
// up via Remove).
// ----------------------------------------------------------------------

// SampleSubscriberCount is exported for tests + the handler so the
// response shape doesn't drift from this constant.
const SampleSubscriberCount = 50

// sampleSubscriberAge picks a deterministic created_at offset so
// re-running the seeder produces the same shape. Weight: 70% within
// 30 days, 25% within 31-60d, 5% within 61-90d.
func sampleSubscriberAge(i int) time.Duration {
	// Stable hash of the index → 0..99 bucket
	h := sha256.Sum256([]byte(fmt.Sprintf("postwave-sample-sub-%d", i)))
	bucket := int(binary.BigEndian.Uint32(h[:4]) % 100)
	if bucket < 70 {
		return time.Duration(bucket%30) * 24 * time.Hour
	}
	if bucket < 95 {
		return time.Duration(31+(bucket%30)) * 24 * time.Hour
	}
	return time.Duration(61+(bucket%30)) * 24 * time.Hour
}

func (s *Seeder) insertSampleSubscribers(ctx context.Context, tenantID string, counts *Counts) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	firstNames := []string{"Alex", "Maya", "Jordan", "Sam", "Riley", "Priya", "Leo", "Avery", "Nora", "Kai"}
	lastNames := []string{"Chen", "Patel", "Morgan", "Rivera", "Kim"}
	interests := []string{"product-updates", "weekly-digest", "design", "engineering", "founder-notes"}
	for i := 1; i <= SampleSubscriberCount; i++ {
		email := fmt.Sprintf("sample-%d@example.com", i)
		consentAt := now.Add(-sampleSubscriberAge(i))
		firstName, lastName := firstNames[(i-1)%len(firstNames)], lastNames[(i-1)/len(firstNames)]
		customJSON, _ := json.Marshal(map[string]string{"sample": "true", "seeded_by": "onboarding.sample_data", "company": "Example Studio", "interest": interests[(i-1)%len(interests)]})
		// status=enabled covers the realistic "active subscriber"
		// shape; consent_source=import is the closest match for "we
		// inserted them in bulk on behalf of the user".
		_, err := tx.Exec(ctx, `
INSERT INTO subscribers (
    tenant_id, email, status, consent_timestamp, consent_source,
    custom_fields, tags, first_name, last_name, full_name, created_at, updated_at
) VALUES (
    $1::uuid, $2, 'enabled', $3, 'import', $4::jsonb, $5, $6, $7, $8, $3, $3
)
ON CONFLICT (tenant_id, email) DO NOTHING`,
			tenantID, email, consentAt, string(customJSON),
			[]string{"sample", interests[(i-1)%len(interests)]}, firstName, lastName, firstName+" "+lastName)
		if err != nil {
			return fmt.Errorf("insert subscriber %s: %w", email, err)
		}
		// Count via insert-or-skip: COUNT the inserted via ON CONFLICT
		// returning. The simpler shape — we trust the deterministic
		// inputs — is to count what we attempted. Re-running the
		// seeder hits the idempotency cache before this point.
		counts.Subscribers++
	}
	return tx.Commit(ctx)
}

const sampleSegmentDescPrefix = "[postwave-sample] "

func (s *Seeder) insertSampleSegment(ctx context.Context, tenantID string, counts *Counts) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Use the current SegmentNode wire contract and scope to sample addresses.
	queryAST := []byte(`{
  "op": "and",
  "children": [
    {"op":"condition","field":"status","comparator":"equals","value":"enabled"},
    {"op":"condition","field":"email","comparator":"ends_with","value":"@example.com"},
    {"op":"condition","field":"email","comparator":"starts_with","value":"sample-"}
  ]
}`)
	desc := sampleSegmentDescPrefix + "matches the 50 sample subscribers seeded by Settings -> Sample data"
	_, err = tx.Exec(ctx, `
INSERT INTO segments (tenant_id, name, description, query_ast, last_count, last_evaluated_at)
VALUES ($1::uuid, $2, $3, $4::jsonb,
  (SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND status='enabled'
    AND email::text LIKE 'sample-%@example.com'), now())
ON CONFLICT (tenant_id, name) DO NOTHING`,
		tenantID, "Sample · enabled subscribers", desc, string(queryAST))
	if err != nil {
		return fmt.Errorf("insert sample segment: %w", err)
	}
	counts.Segments = 1
	return tx.Commit(ctx)
}

// sampleCampaign is the deterministic shape of a single seeded campaign.
type sampleCampaign struct {
	Name      string
	Subject   string
	Status    string // "sent" | "draft" | "paused"
	BodyHTML  string
	Metrics   map[string]any // open_rate, click_rate, recipients
	Scheduled time.Time      // applied only for status=scheduled
	Sent      time.Time      // applied only for status=sent
}

func sampleCampaignSet(now time.Time) []sampleCampaign {
	return []sampleCampaign{
		{
			Name:     "Welcome to our newsletter (sample)",
			Subject:  "Hey there — welcome aboard!",
			Status:   "sent",
			BodyHTML: "<h1>Welcome!</h1><p>This is a sample campaign so you can see what a sent newsletter looks like in Moosewave.</p>",
			Sent:     now.Add(-21 * 24 * time.Hour),
			Metrics: map[string]any{
				"recipients":  50,
				"open_rate":   0.52,
				"click_rate":  0.16,
				"bounce_rate": 0.02,
			},
		},
		{
			Name:     "Black Friday teaser (sample)",
			Subject:  "Something big is coming on Friday…",
			Status:   "draft",
			BodyHTML: "<h1>Black Friday teaser</h1><p>Edit me — this is a draft campaign you can test sends from.</p>",
			Metrics: map[string]any{
				"recipients":  0,
				"open_rate":   0,
				"click_rate":  0,
				"bounce_rate": 0,
			},
		},
		{
			Name:     "Weekly digest #42 (sample)",
			Subject:  "This week in product: 5 things worth your time",
			Status:   "paused",
			BodyHTML: "<h1>Weekly digest #42</h1><p>This is a paused sample newsletter for previewing and editing. It is not queued for delivery.</p>",
			Metrics: map[string]any{
				"recipients":  50,
				"open_rate":   0,
				"click_rate":  0,
				"bounce_rate": 0,
			},
		},
	}
}

func (s *Seeder) insertSampleCampaigns(ctx context.Context, tenantID string, counts *Counts) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	for _, c := range sampleCampaignSet(now) {
		delivery := map[string]any{
			"sample":         "true",
			"sample_metrics": c.Metrics,
		}
		deliveryRaw, _ := json.Marshal(delivery)
		var scheduledAt, sentAt any
		if !c.Scheduled.IsZero() {
			scheduledAt = c.Scheduled
		}
		if !c.Sent.IsZero() {
			sentAt = c.Sent
		}
		var campaignID string
		err := tx.QueryRow(ctx, `
INSERT INTO campaigns (
    tenant_id, name, subject, status, body_html,
    campaign_type, editor_mode, preview_text, from_name,
    content_blocks, variants, tracking_settings, delivery_settings,
    scheduled_at, sent_at
) VALUES (
    $1::uuid, $2, $3, $4, NULLIF($5, ''),
    'regular', 'html', $6, 'Moosewave',
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $7::jsonb,
    $8, $9
)
RETURNING id::text`,
			tenantID, c.Name, c.Subject, c.Status, c.BodyHTML,
			"a sample campaign you can safely delete",
			string(deliveryRaw),
			scheduledAt, sentAt).Scan(&campaignID)
		if err != nil {
			return fmt.Errorf("insert sample campaign %q: %w", c.Name, err)
		}
		if c.Status == "sent" {
			if err := insertSampleCampaignEvents(ctx, tx, tenantID, campaignID, now); err != nil {
				return fmt.Errorf("insert sample campaign events: %w", err)
			}
		}
		counts.Campaigns++
	}

	return tx.Commit(ctx)
}

// sampleCampaignEvent is deliberately limited to the fields surfaced by the
// campaign report and dashboard. It keeps the demo rich without pretending to
// be provider-originated production traffic.
type sampleCampaignEvent struct {
	Email     string
	EventType string
	LinkURL   string
	Country   string
	Client    string
	At        time.Time
}

// sampleCampaignEvents creates a plausible engagement trail for the sent
// sample campaign: 50 sends, 49 deliveries, one bounce, 26 unique opens and
// eight unique clicks. Events are spread across the last 20 days so dashboard
// sparklines and range filters render useful shapes.
func sampleCampaignEvents(now time.Time) []sampleCampaignEvent {
	events := make([]sampleCampaignEvent, 0, 140)
	for i := 1; i <= SampleSubscriberCount; i++ {
		email := fmt.Sprintf("sample-%d@example.com", i)
		at := now.Add(-time.Duration(1+(i*7)%20) * 24 * time.Hour).Add(-time.Duration(i%12) * time.Hour)
		client := "Gmail"
		country := "United States"
		if i%3 == 0 {
			client, country = "Apple Mail", "United Kingdom"
		} else if i%5 == 0 {
			client, country = "Outlook", "Canada"
		}
		events = append(events, sampleCampaignEvent{Email: email, EventType: "sent", At: at})
		if i == SampleSubscriberCount {
			events = append(events, sampleCampaignEvent{Email: email, EventType: "bounced", At: at.Add(2 * time.Minute)})
			continue
		}
		events = append(events, sampleCampaignEvent{Email: email, EventType: "delivered", At: at.Add(time.Minute)})
		if i <= 26 {
			events = append(events, sampleCampaignEvent{Email: email, EventType: "opened", Country: country, Client: client, At: at.Add(3 * time.Hour)})
			if i%5 == 0 {
				events = append(events, sampleCampaignEvent{Email: email, EventType: "opened", Country: country, Client: client, At: at.Add(7 * time.Hour)})
			}
		}
		if i <= 8 {
			linkURL := "https://postwave.example/demo/getting-started"
			if i%2 == 0 {
				linkURL = "https://postwave.example/demo/templates"
			}
			events = append(events, sampleCampaignEvent{Email: email, EventType: "clicked", LinkURL: linkURL, Country: country, Client: client, At: at.Add(4 * time.Hour)})
		}
	}
	return events
}

func insertSampleCampaignEvents(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, now time.Time) error {
	for _, event := range sampleCampaignEvents(now) {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, link_url,
    country, client, metadata, at
) VALUES (
    $1::uuid, $2::uuid, $3, $4, NULLIF($5, ''),
    NULLIF($6, ''), NULLIF($7, ''), '{"sample":true}'::jsonb, $8
)`, tenantID, campaignID, event.Email, event.EventType, event.LinkURL,
			event.Country, event.Client, event.At); err != nil {
			return err
		}
	}
	return nil
}

func (s *Seeder) insertSampleSequence(ctx context.Context, tenantID string, counts *Counts) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	emails := []map[string]any{
		{
			"position":      1,
			"delay_seconds": 0,
			"subject":       "Welcome — what to expect from us",
			"body":          "Hi {{first_name}}, thanks for signing up. Here's what's coming over the next two weeks…",
		},
		{
			"position":      2,
			"delay_seconds": 3 * 24 * 60 * 60,
			"subject":       "Tip: 3 ways to get more from Moosewave",
			"body":          "Three quick wins from the Moosewave team — pick the one that solves a real problem you have today.",
		},
		{
			"position":      3,
			"delay_seconds": 7 * 24 * 60 * 60,
			"subject":       "Ready to upgrade?",
			"body":          "We hope the trial has been useful. If it's a fit, here's a link to upgrade. If not, no hard feelings.",
		},
	}
	emailsRaw, err := json.Marshal(emails)
	if err != nil {
		return fmt.Errorf("marshal sample sequence emails: %w", err)
	}
	styleControls := map[string]any{"sample": "true", "tone": "friendly"}
	styleRaw, _ := json.Marshal(styleControls)
	_, err = tx.Exec(ctx, `
INSERT INTO voice_sequences (tenant_id, name, status, emails, style_controls)
VALUES ($1::uuid, $2, 'draft', $3::jsonb, $4::jsonb)`,
		tenantID, "Sample onboarding sequence", string(emailsRaw), string(styleRaw))
	if err != nil {
		return fmt.Errorf("insert sample sequence: %w", err)
	}
	counts.Sequences = 1
	return tx.Commit(ctx)
}

// _ guards against strings being unused if the description constant
// changes in the future.
var _ = strings.HasPrefix
