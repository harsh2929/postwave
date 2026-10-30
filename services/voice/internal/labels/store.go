// Package labels owns the voice_profile_labels CRUD surface that
// operators use to record (sample_text, axis, value) tuples for the
// tone calibration trainer.
//
// The store is the canonical write+read path for the table introduced
// in infra/migrations/0092_voice_profile_labels.sql. Each method
// scopes itself to a single tenant via SELECT set_config('app.tenant_id',
// ...) inside a short tx; RLS on the table is the actual isolation
// boundary, the application-level WHERE clauses are belt-and-suspenders.
//
// Operators interact with the store through the HTTP handlers in
// handlers.go; offline trainers consume it via Export() (which is what
// tone_corpus.DBExporter wraps to feed real-world labels into the
// calibrator alongside the in-tree synthetic seed set).
package labels

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Label is one (sample_text, axis, value) tuple recorded by an
// operator. SampleID, LabeledBy, and Notes are optional; the
// production UI sets SampleID when the label originates from a
// representative-sample row and LabeledBy from the session user.
type Label struct {
	ID         string
	TenantID   string
	SampleID   string
	SampleText string
	Axis       string
	Value      float64
	LabeledBy  string // user id (uuid string) or empty
	Notes      string
	CreatedAt  time.Time
}

// validAxes mirrors the CHECK constraint in migration 0092. Kept in
// sync with profile/tone_corpus.AxisIndex so a label that passes
// validation here is guaranteed projectable in the trainer.
var validAxes = map[string]struct{}{
	"humor":      {},
	"formality":  {},
	"optimism":   {},
	"directness": {},
	"warmth":     {},
}

// ErrInvalidAxis is returned when the supplied axis is not one of the
// five canonical names. Matches the DB CHECK constraint so a 400 from
// the handler is a less noisy failure than a 23514 from Postgres.
var ErrInvalidAxis = errors.New("labels: axis must be one of humor|formality|optimism|directness|warmth")

// ErrInvalidValue is returned when value is outside [0, 1]. Same
// rationale as ErrInvalidAxis: catch in the app layer so the DB error
// path stays for genuine schema mismatches.
var ErrInvalidValue = errors.New("labels: value must be in [0.0, 1.0]")

// ErrEmptySampleText is returned when sample_text is blank — the
// trainer needs actual text to extract tone features from.
var ErrEmptySampleText = errors.New("labels: sample_text must be non-empty")

// ErrNotFound is returned by Delete when the row doesn't exist (or
// the tenant doesn't own it). Mirrors profilestore.ErrNotFound.
var ErrNotFound = errors.New("labels: not found")

// Store is the Postgres-backed labels CRUD surface.
type Store struct {
	Pool *pgxpool.Pool
}

// NewStore constructs a Store, rejecting a nil pool so test fixtures
// that forgot to wire one fail loudly instead of NPE'ing on Create.
func NewStore(pool *pgxpool.Pool) (*Store, error) {
	if pool == nil {
		return nil, errors.New("labels.NewStore: nil pgx pool")
	}
	return &Store{Pool: pool}, nil
}

// ValidateLabel applies the app-layer guards that mirror the DB
// CHECKs. Exported so handlers can run the same validation against an
// inbound JSON body without round-tripping to Postgres for a 23514.
func ValidateLabel(axis string, value float64, sampleText string) error {
	if _, ok := validAxes[axis]; !ok {
		return ErrInvalidAxis
	}
	if value < 0.0 || value > 1.0 {
		return ErrInvalidValue
	}
	if strings.TrimSpace(sampleText) == "" {
		return ErrEmptySampleText
	}
	return nil
}

// Create inserts a new label row. Returns the generated UUID on
// success. labeledByUserID may be empty (anonymous label / CLI
// imports); the column is nullable.
func (s *Store) Create(ctx context.Context, tenantID string, l Label) (string, error) {
	if s == nil || s.Pool == nil {
		return "", errors.New("labels.Store: nil pool")
	}
	if tenantID == "" {
		return "", errors.New("labels.Store: tenant id required")
	}
	if err := ValidateLabel(l.Axis, l.Value, l.SampleText); err != nil {
		return "", err
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sampleID *string
	if strings.TrimSpace(l.SampleID) != "" {
		v := l.SampleID
		sampleID = &v
	}
	var labeledBy *string
	if strings.TrimSpace(l.LabeledBy) != "" {
		v := l.LabeledBy
		labeledBy = &v
	}
	var notes *string
	if strings.TrimSpace(l.Notes) != "" {
		v := l.Notes
		notes = &v
	}

	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO voice_profile_labels (
    tenant_id, sample_id, sample_text, axis, value, labeled_by_user_id, notes
) VALUES (
    $1::uuid, $2, $3, $4, $5, NULLIF($6::text, '')::uuid, $7
) RETURNING id::text`,
		tenantID, sampleID, l.SampleText, l.Axis, l.Value, derefOrEmpty(labeledBy), notes,
	).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("labels: insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// List returns labels for the tenant, optionally filtered to a single
// axis. limit/offset support the paginated handler. Total is the
// unpaginated count so the UI can render "showing N of M". Pass axis="" to
// list across all axes.
func (s *Store) List(ctx context.Context, tenantID, axis string, limit, offset int) ([]Label, int, error) {
	if s == nil || s.Pool == nil {
		return nil, 0, errors.New("labels.Store: nil pool")
	}
	if tenantID == "" {
		return nil, 0, errors.New("labels.Store: tenant id required")
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	if axis != "" {
		if _, ok := validAxes[axis]; !ok {
			return nil, 0, ErrInvalidAxis
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// COUNT(*) and the paginated SELECT both rely on the RLS policy
	// to scope to tenantID. The redundant WHERE is belt-and-suspenders.
	var total int
	if axis == "" {
		err = tx.QueryRow(ctx, `
SELECT COUNT(*) FROM voice_profile_labels
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&total)
	} else {
		err = tx.QueryRow(ctx, `
SELECT COUNT(*) FROM voice_profile_labels
 WHERE tenant_id = $1::uuid AND axis = $2`, tenantID, axis).Scan(&total)
	}
	if err != nil {
		return nil, 0, fmt.Errorf("labels: count: %w", err)
	}

	var rows pgx.Rows
	if axis == "" {
		rows, err = tx.Query(ctx, `
SELECT id::text, tenant_id::text,
       COALESCE(sample_id, ''), sample_text, axis, value,
       COALESCE(labeled_by_user_id::text, ''),
       COALESCE(notes, ''), created_at
  FROM voice_profile_labels
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT $2 OFFSET $3`, tenantID, limit, offset)
	} else {
		rows, err = tx.Query(ctx, `
SELECT id::text, tenant_id::text,
       COALESCE(sample_id, ''), sample_text, axis, value,
       COALESCE(labeled_by_user_id::text, ''),
       COALESCE(notes, ''), created_at
  FROM voice_profile_labels
 WHERE tenant_id = $1::uuid AND axis = $2
 ORDER BY created_at DESC
 LIMIT $3 OFFSET $4`, tenantID, axis, limit, offset)
	}
	if err != nil {
		return nil, 0, fmt.Errorf("labels: select: %w", err)
	}
	defer rows.Close()
	out := make([]Label, 0, limit)
	for rows.Next() {
		var l Label
		if err := rows.Scan(&l.ID, &l.TenantID, &l.SampleID, &l.SampleText, &l.Axis, &l.Value, &l.LabeledBy, &l.Notes, &l.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// Delete removes a label by id. Returns ErrNotFound if no row was
// removed (either the id is wrong or RLS hid it from this tenant).
func (s *Store) Delete(ctx context.Context, tenantID, labelID string) error {
	if s == nil || s.Pool == nil {
		return errors.New("labels.Store: nil pool")
	}
	if tenantID == "" || labelID == "" {
		return errors.New("labels.Store: tenant id and label id required")
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM voice_profile_labels
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, labelID)
	if err != nil {
		return fmt.Errorf("labels: delete: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// Export returns every label row for the tenant in insertion order.
// Used by tone_corpus.DBExporter to feed the calibration trainer.
// Unlike List it does not paginate — corpora are sized in the
// hundreds and the trainer wants the whole set.
func (s *Store) Export(ctx context.Context, tenantID string) ([]Label, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("labels.Store: nil pool")
	}
	if tenantID == "" {
		return nil, errors.New("labels.Store: tenant id required")
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text,
       COALESCE(sample_id, ''), sample_text, axis, value,
       COALESCE(labeled_by_user_id::text, ''),
       COALESCE(notes, ''), created_at
  FROM voice_profile_labels
 WHERE tenant_id = $1::uuid
 ORDER BY created_at ASC`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("labels: export: %w", err)
	}
	defer rows.Close()
	out := make([]Label, 0, 64)
	for rows.Next() {
		var l Label
		if err := rows.Scan(&l.ID, &l.TenantID, &l.SampleID, &l.SampleText, &l.Axis, &l.Value, &l.LabeledBy, &l.Notes, &l.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// beginTenant starts a short tx and sets the per-tx app.tenant_id
// session var so the RLS policy on voice_profile_labels scopes to the
// caller's tenant.
func (s *Store) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("labels: tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// derefOrEmpty returns *s, or "" if s is nil. Used to bridge nullable
// *string params into the pgx INSERT arglist where we want NULLIF to
// handle the empty-string → SQL NULL mapping inline.
func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
