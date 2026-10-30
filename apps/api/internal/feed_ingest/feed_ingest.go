// SPDX-License-Identifier: AGPL-3.0-only
//
// Package feed_ingest turns RSS 2.0 / Atom feeds into recurring draft
// campaigns (FEATURE-ROADMAP-2026-06 "Recurring / RSS-to-email
// campaigns"). It is the INGESTION half of the RSS story —
// internal/newsletter_feed is the OUTPUT half (archive → RSS) and is
// untouched by this package.
//
// Data model:
//   - feed_sources (migration 0384): one row per feed a tenant watches.
//     Targeting mirrors how campaigns target audiences (list_id is the
//     Listmonk bigint list id → campaigns.audience_list_id; segment_id
//     is the Moosewave segment uuid → campaigns.segment_id).
//   - feed_source_runs (migration 0385): per-poll ledger.
//
// The poller NEVER auto-sends: every poll that finds new items creates
// a DRAFT campaign (one digest draft per batch of new items) the
// operator reviews and sends by hand. Auto-send is a future explicit
// opt-in — see poller.go.
package feed_ingest

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Schedules. "manual" runs only via POST /{id}/poll; daily/weekly are
// picked up by the Scheduler tick (poller.go).
const (
	ScheduleManual = "manual"
	ScheduleDaily  = "daily"
	ScheduleWeekly = "weekly"
)

// Run statuses (feed_source_runs.status CHECK).
const (
	RunStatusRunning   = "running"
	RunStatusSucceeded = "succeeded"
	RunStatusFailed    = "failed"
)

var (
	ErrNotFound     = errors.New("feed_ingest: not found")
	ErrInvalidInput = errors.New("feed_ingest: invalid input")
)

// FeedSource is one row from feed_sources as returned by the API.
type FeedSource struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	Schedule string `json:"schedule"`
	// TemplateID is a reserved campaign-template reference (0048) for a
	// future "render through my template" mode; stored + echoed, the v1
	// poller renders the built-in digest body.
	TemplateID *string `json:"template_id,omitempty"`
	// ListID is the Listmonk bigint list id (stringified, same
	// convention as campaigns.Campaign.ListID / audience_list_id).
	ListID *string `json:"list_id,omitempty"`
	// SegmentID is the Moosewave segment uuid (campaigns.segment_id).
	SegmentID       *string    `json:"segment_id,omitempty"`
	SubjectTemplate string     `json:"subject_template"`
	Enabled         bool       `json:"enabled"`
	LastPolledAt    *time.Time `json:"last_polled_at,omitempty"`
	LastItemGUID    string     `json:"last_item_guid,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// Run is one row from feed_source_runs.
type Run struct {
	ID           string     `json:"id"`
	FeedSourceID string     `json:"feed_source_id"`
	Status       string     `json:"status"`
	ItemsSeen    int        `json:"items_seen"`
	NewItems     int        `json:"new_items"`
	CampaignID   string     `json:"campaign_id,omitempty"`
	Error        string     `json:"error,omitempty"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
}

// CreateInput is the body of POST /api/v1/feed-sources.
type CreateInput struct {
	Name            string  `json:"name"`
	URL             string  `json:"url"`
	Schedule        string  `json:"schedule"`
	TemplateID      *string `json:"template_id,omitempty"`
	ListID          *string `json:"list_id,omitempty"`
	SegmentID       *string `json:"segment_id,omitempty"`
	SubjectTemplate string  `json:"subject_template"`
	Enabled         *bool   `json:"enabled,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/feed-sources/{id}. nil
// fields are left untouched; pointer-to-empty clears the nullable
// targeting columns.
type UpdateInput struct {
	Name            *string `json:"name,omitempty"`
	URL             *string `json:"url,omitempty"`
	Schedule        *string `json:"schedule,omitempty"`
	TemplateID      *string `json:"template_id,omitempty"`
	ListID          *string `json:"list_id,omitempty"`
	SegmentID       *string `json:"segment_id,omitempty"`
	SubjectTemplate *string `json:"subject_template,omitempty"`
	Enabled         *bool   `json:"enabled,omitempty"`
}

// uuidRe is a light format gate so a malformed uuid surfaces as a 400
// invalid_input instead of a 500 from the ::uuid cast.
var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validateSchedule(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", ScheduleManual:
		return ScheduleManual, nil
	case ScheduleDaily:
		return ScheduleDaily, nil
	case ScheduleWeekly:
		return ScheduleWeekly, nil
	}
	return "", fmt.Errorf("%w: schedule must be manual|daily|weekly", ErrInvalidInput)
}

// validateFeedURL enforces the same posture as outbound-webhook /
// audience-sync destinations: http(s) only, no embedded credentials,
// HTTPS required when requireHTTPS (non-dev). SSRF protection at fetch
// time comes from outbound_webhooks.NewSecureHTTPClient wired in
// main.go (DNS-rebinding-safe dialer).
func validateFeedURL(raw string, requireHTTPS bool) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return fmt.Errorf("%w: url required (max 2048 chars)", ErrInvalidInput)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return fmt.Errorf("%w: url is not a valid URL", ErrInvalidInput)
	}
	if u.User != nil {
		return fmt.Errorf("%w: url must not embed credentials", ErrInvalidInput)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if requireHTTPS {
			return fmt.Errorf("%w: url must be https in this environment", ErrInvalidInput)
		}
	default:
		return fmt.Errorf("%w: url must be http(s)", ErrInvalidInput)
	}
	return nil
}

func validateTargeting(listID, segmentID, templateID *string) error {
	if listID != nil && strings.TrimSpace(*listID) != "" {
		if _, err := strconv.ParseInt(strings.TrimSpace(*listID), 10, 64); err != nil {
			return fmt.Errorf("%w: list_id must be a numeric list id", ErrInvalidInput)
		}
	}
	if segmentID != nil && strings.TrimSpace(*segmentID) != "" && !uuidRe.MatchString(strings.TrimSpace(*segmentID)) {
		return fmt.Errorf("%w: segment_id must be a uuid", ErrInvalidInput)
	}
	if templateID != nil && strings.TrimSpace(*templateID) != "" && !uuidRe.MatchString(strings.TrimSpace(*templateID)) {
		return fmt.Errorf("%w: template_id must be a uuid", ErrInvalidInput)
	}
	return nil
}

// validateCreate normalizes + validates a CreateInput in place.
func validateCreate(in *CreateInput, requireHTTPS bool) error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 200 {
		return fmt.Errorf("%w: name required (max 200 chars)", ErrInvalidInput)
	}
	if err := validateFeedURL(in.URL, requireHTTPS); err != nil {
		return err
	}
	in.URL = strings.TrimSpace(in.URL)
	sched, err := validateSchedule(in.Schedule)
	if err != nil {
		return err
	}
	in.Schedule = sched
	in.SubjectTemplate = strings.TrimSpace(in.SubjectTemplate)
	if in.SubjectTemplate == "" {
		in.SubjectTemplate = "{{title}}"
	}
	if len(in.SubjectTemplate) > 500 {
		return fmt.Errorf("%w: subject_template too long (max 500 chars)", ErrInvalidInput)
	}
	return validateTargeting(in.ListID, in.SegmentID, in.TemplateID)
}

// Repo persists feed_sources + feed_source_runs.
type Repo struct {
	Pool *db.Pool
}

const sourceSelectColumns = `
       id::text, name, url, schedule,
       template_id::text, list_id::text, segment_id::text,
       subject_template, enabled,
       last_polled_at, COALESCE(last_item_guid,''),
       created_at, updated_at`

func scanSource(row pgx.Row) (*FeedSource, error) {
	var s FeedSource
	if err := row.Scan(
		&s.ID, &s.Name, &s.URL, &s.Schedule,
		&s.TemplateID, &s.ListID, &s.SegmentID,
		&s.SubjectTemplate, &s.Enabled,
		&s.LastPolledAt, &s.LastItemGUID,
		&s.CreatedAt, &s.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &s, nil
}

// ListSources returns the tenant's feed sources, newest-first.
func (r *Repo) ListSources(ctx context.Context, tenantID string) ([]FeedSource, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+sourceSelectColumns+`
  FROM feed_sources
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FeedSource{}
	for rows.Next() {
		s, err := scanSource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GetSource returns one feed source (RLS-scoped).
func (r *Repo) GetSource(ctx context.Context, tenantID, id string) (*FeedSource, error) {
	if !uuidRe.MatchString(id) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := scanSource(tx.QueryRow(ctx, `
SELECT `+sourceSelectColumns+`
  FROM feed_sources
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// CreateSource inserts a new feed source. Input must already be
// validated (validateCreate).
func (r *Repo) CreateSource(ctx context.Context, tenantID string, in CreateInput) (*FeedSource, error) {
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO feed_sources
       (tenant_id, name, url, schedule,
        template_id, list_id, segment_id,
        subject_template, enabled)
VALUES ($1::uuid, $2, $3, $4,
        NULLIF($5,'')::uuid, NULLIF($6,'')::bigint, NULLIF($7,'')::uuid,
        $8, $9)
RETURNING id::text`,
		tenantID, in.Name, in.URL, in.Schedule,
		strOrEmpty(in.TemplateID), strOrEmpty(in.ListID), strOrEmpty(in.SegmentID),
		in.SubjectTemplate, enabled,
	).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, fmt.Errorf("%w: a feed source named %q already exists", ErrInvalidInput, in.Name)
		}
		if isForeignKeyViolation(err) {
			return nil, fmt.Errorf("%w: segment_id does not reference a known segment", ErrInvalidInput)
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetSource(ctx, tenantID, id)
}

// UpdateSource applies a partial patch.
func (r *Repo) UpdateSource(ctx context.Context, tenantID, id string, in UpdateInput, requireHTTPS bool) (*FeedSource, error) {
	cur, err := r.GetSource(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	next := *cur
	if in.Name != nil {
		next.Name = strings.TrimSpace(*in.Name)
		if next.Name == "" || len(next.Name) > 200 {
			return nil, fmt.Errorf("%w: name required (max 200 chars)", ErrInvalidInput)
		}
	}
	if in.URL != nil {
		if err := validateFeedURL(*in.URL, requireHTTPS); err != nil {
			return nil, err
		}
		next.URL = strings.TrimSpace(*in.URL)
	}
	if in.Schedule != nil {
		sched, err := validateSchedule(*in.Schedule)
		if err != nil {
			return nil, err
		}
		next.Schedule = sched
	}
	if err := validateTargeting(in.ListID, in.SegmentID, in.TemplateID); err != nil {
		return nil, err
	}
	if in.TemplateID != nil {
		next.TemplateID = in.TemplateID
	}
	if in.ListID != nil {
		next.ListID = in.ListID
	}
	if in.SegmentID != nil {
		next.SegmentID = in.SegmentID
	}
	if in.SubjectTemplate != nil {
		st := strings.TrimSpace(*in.SubjectTemplate)
		if st == "" {
			st = "{{title}}"
		}
		if len(st) > 500 {
			return nil, fmt.Errorf("%w: subject_template too long (max 500 chars)", ErrInvalidInput)
		}
		next.SubjectTemplate = st
	}
	if in.Enabled != nil {
		next.Enabled = *in.Enabled
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE feed_sources
   SET name = $3,
       url = $4,
       schedule = $5,
       template_id = NULLIF($6,'')::uuid,
       list_id = NULLIF($7,'')::bigint,
       segment_id = NULLIF($8,'')::uuid,
       subject_template = $9,
       enabled = $10,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id, next.Name, next.URL, next.Schedule,
		strOrEmpty(next.TemplateID), strOrEmpty(next.ListID), strOrEmpty(next.SegmentID),
		next.SubjectTemplate, next.Enabled,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, fmt.Errorf("%w: a feed source named %q already exists", ErrInvalidInput, next.Name)
		}
		if isForeignKeyViolation(err) {
			return nil, fmt.Errorf("%w: segment_id does not reference a known segment", ErrInvalidInput)
		}
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetSource(ctx, tenantID, id)
}

// DeleteSource removes a feed source (runs cascade via FK).
func (r *Repo) DeleteSource(ctx context.Context, tenantID, id string) error {
	if !uuidRe.MatchString(id) {
		return ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM feed_sources
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ListRuns returns the recent runs for a source, newest-first.
func (r *Repo) ListRuns(ctx context.Context, tenantID, sourceID string, limit int) ([]Run, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, feed_source_id::text, status, items_seen, new_items,
       COALESCE(campaign_id::text,''), COALESCE(error,''),
       started_at, finished_at
  FROM feed_source_runs
 WHERE tenant_id = $1::uuid AND feed_source_id = $2::uuid
 ORDER BY started_at DESC
 LIMIT $3`, tenantID, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		var run Run
		if err := rows.Scan(
			&run.ID, &run.FeedSourceID, &run.Status, &run.ItemsSeen, &run.NewItems,
			&run.CampaignID, &run.Error, &run.StartedAt, &run.FinishedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// beginRun inserts the 'running' ledger row and returns its id.
func (r *Repo) beginRun(ctx context.Context, tenantID, sourceID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO feed_source_runs (tenant_id, feed_source_id, status)
VALUES ($1::uuid, $2::uuid, 'running')
RETURNING id::text`, tenantID, sourceID).Scan(&id); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// finishRun closes the ledger row. errMsg is truncated so a giant
// upstream body can't bloat the ledger.
func (r *Repo) finishRun(ctx context.Context, tenantID, runID, status string, itemsSeen, newItems int, campaignID, errMsg string) error {
	const maxErrLen = 2000
	if len(errMsg) > maxErrLen {
		errMsg = errMsg[:maxErrLen] + "…"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE feed_source_runs
   SET status = $3, items_seen = $4, new_items = $5,
       campaign_id = NULLIF($6,'')::uuid,
       error = NULLIF($7,''), finished_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, runID, status, itemsSeen, newItems, campaignID, errMsg); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// markPolled stamps last_polled_at (always) and advances
// last_item_guid (only when newestGUID is non-empty, so a poll that
// found nothing new keeps the cursor).
func (r *Repo) markPolled(ctx context.Context, tenantID, sourceID, newestGUID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE feed_sources
   SET last_polled_at = now(),
       last_item_guid = COALESCE(NULLIF($3,''), last_item_guid),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, sourceID, newestGUID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// finishRunAndMarkPolled closes the ledger row (feed_source_runs) AND
// stamps last_polled_at / advances last_item_guid (feed_sources) in a
// SINGLE tenant transaction. Both tables are scoped by the same
// app.tenant_id GUC, so a crash can no longer leave a run stuck
// 'running' after the cursor moved, or advance the cursor without
// finishing the run. newestGUID "" leaves the cursor untouched (a poll
// that found nothing new keeps the cursor) — same semantics as markPolled.
func (r *Repo) finishRunAndMarkPolled(ctx context.Context, tenantID, runID, sourceID, status string, itemsSeen, newItems int, campaignID, errMsg, newestGUID string) error {
	const maxErrLen = 2000
	if len(errMsg) > maxErrLen {
		errMsg = errMsg[:maxErrLen] + "…"
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE feed_source_runs
   SET status = $3, items_seen = $4, new_items = $5,
       campaign_id = NULLIF($6,'')::uuid,
       error = NULLIF($7,''), finished_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, runID, status, itemsSeen, newItems, campaignID, errMsg); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE feed_sources
   SET last_polled_at = now(),
       last_item_guid = COALESCE(NULLIF($3,''), last_item_guid),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, sourceID, newestGUID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

// isUniqueViolation / isForeignKeyViolation report Postgres 23505 /
// 23503 without importing pgconn directly (string match keeps the
// dependency surface flat — same approach as sibling packages).
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}

func isForeignKeyViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23503")
}
