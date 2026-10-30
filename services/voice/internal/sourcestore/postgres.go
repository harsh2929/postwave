// Package sourcestore is the Postgres-backed implementation of the
// source/items half of handlers.VoiceStore. Use it via the adapter wired in
// services/voice/main.go when DATABASE_URL is configured.
package sourcestore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

// SourceRecord mirrors handlers.SourceRecord (kept duplicated here to avoid an
// import cycle; the handlers package converts between the two trivially).
type SourceRecord struct {
	ID            string
	TenantID      string
	Type          ingest.SourceType
	Params        ingest.IngestParams
	LastIngest    time.Time
	LastItemCount int
}

// Store is the public type for this package.
type Store struct {
	Pool *pgxpool.Pool
}

// New constructs a Store, requires non-nil pool.
func New(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &Store{Pool: p}, nil
}

// RegisterSource inserts a row into voice_sources.
func (s *Store) RegisterSource(ctx context.Context, tenantID string, t ingest.SourceType, params ingest.IngestParams) (string, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := uuid.NewString()
	pb, _ := json.Marshal(params)
	_, err = tx.Exec(ctx, `
		INSERT INTO voice_sources (id, tenant_id, type, params)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)
	`, id, tenantID, string(t), string(pb))
	if err != nil {
		return "", fmt.Errorf("insert source: %w", err)
	}
	return id, tx.Commit(ctx)
}

// ListSources returns all sources for a tenant.
func (s *Store) ListSources(ctx context.Context, tenantID string) ([]SourceRecord, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, type, params, last_ingested_at, item_count
		  FROM voice_sources WHERE tenant_id = $1::uuid ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SourceRecord, 0)
	for rows.Next() {
		var r SourceRecord
		var pb []byte
		var last *time.Time
		if err := rows.Scan(&r.ID, &r.TenantID, &r.Type, &pb, &last, &r.LastItemCount); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(pb, &r.Params)
		if last != nil {
			r.LastIngest = *last
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetSource returns one record by id (no tenant scope: caller is trusted to
// have already authenticated; RLS bites if the tenant does not match).
func (s *Store) GetSource(ctx context.Context, id string) (SourceRecord, error) {
	return s.GetSourceForTenant(ctx, "", id)
}

// GetSourceForTenant returns one record by id inside a tenant-scoped tx.
func (s *Store) GetSourceForTenant(ctx context.Context, tenantID, id string) (SourceRecord, error) {
	var r SourceRecord
	var pb []byte
	var last *time.Time
	if tenantID == "" {
		return r, errors.New("tenant id required")
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return r, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, type, params, last_ingested_at, item_count
		  FROM voice_sources WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, id).Scan(&r.ID, &r.TenantID, &r.Type, &pb, &last, &r.LastItemCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	_ = json.Unmarshal(pb, &r.Params)
	if last != nil {
		r.LastIngest = *last
	}
	return r, tx.Commit(ctx)
}

// DeleteSourceForTenant removes a source and cascades its ingested items.
func (s *Store) DeleteSourceForTenant(ctx context.Context, tenantID, id string) error {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		DELETE FROM voice_sources
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RecordIngest writes ingested items + bumps source counters.
func (s *Store) RecordIngest(ctx context.Context, sourceID string, items []ingest.Item) error {
	return errors.New("tenant id required")
}

// RecordIngestForTenant writes ingested items + bumps source counters.
func (s *Store) RecordIngestForTenant(ctx context.Context, tenantID, sourceID string, items []ingest.Item) error {
	rec, err := s.GetSourceForTenant(ctx, tenantID, sourceID)
	if err != nil {
		return err
	}
	tx, err := s.beginTenant(ctx, rec.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, it := range items {
		_, err := tx.Exec(ctx, `
			INSERT INTO voice_items
				(id, tenant_id, source_id, source_type, text, published_at, url, title, tokens)
			VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
		`, rec.TenantID, sourceID, string(it.SourceType), it.Text,
			nullableTime(it.PublishedAt), nullable(it.URL), nullable(it.Title),
			approxTokens(it.Text))
		if err != nil {
			return fmt.Errorf("insert item: %w", err)
		}
	}
	_, err = tx.Exec(ctx, `
		UPDATE voice_sources
		   SET last_ingested_at = now(),
		       item_count = item_count + $2
		 WHERE tenant_id = $3::uuid AND id = $1::uuid
	`, sourceID, len(items), rec.TenantID)
	if err != nil {
		return fmt.Errorf("update counters: %w", err)
	}
	return tx.Commit(ctx)
}

// ListItems returns every ingested item for a tenant.
func (s *Store) ListItems(ctx context.Context, tenantID string) ([]ingest.Item, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, source_type, text, published_at, url, title
		  FROM voice_items WHERE tenant_id = $1::uuid
		  ORDER BY published_at DESC NULLS LAST
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ingest.Item, 0)
	for rows.Next() {
		var it ingest.Item
		var pub *time.Time
		var url, title *string
		if err := rows.Scan(&it.ID, &it.SourceType, &it.Text, &pub, &url, &title); err != nil {
			return nil, err
		}
		if pub != nil {
			it.PublishedAt = *pub
		}
		if url != nil {
			it.URL = *url
		}
		if title != nil {
			it.Title = *title
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
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

// approxTokens is a cheap heuristic used purely for analytics / dashboard
// counters. Real tokenization is the model's job.
func approxTokens(text string) int { return len(text) / 4 }

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

// ErrNotFound is returned when the row is absent.
var ErrNotFound = errors.New("sourcestore: not found")
