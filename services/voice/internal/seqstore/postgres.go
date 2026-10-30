// Package seqstore is the Postgres-backed SequenceStore implementation.
package seqstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/sequencecontract"
)

// Store satisfies handlers.SequenceStore.
type Store struct {
	Pool *pgxpool.Pool
}

// New constructs a Store.
func New(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &Store{Pool: p}, nil
}

// Save upserts a sequence row keyed by id.
//
// Persists BOTH the legacy `emails` projection and the v0.3+ `steps`
// shape. Producers send only one of the two on PATCH (the handler
// rejects mixed requests); the unset side is written as NULL so a
// reader can tell which projection is authoritative.
//
// Save bumps the row's `version` column by 1 on conflict, but does NOT
// enforce optimistic concurrency — callers that need the If-Match
// contract should go through SaveWithVersion. Save is kept on the
// unconditional path so generation and other server-driven writes don't need a
// client-supplied version to land. AI regeneration previews are deliberately
// non-persisting; an accepted preview returns through the normal PATCH path.
func (s *Store) Save(ctx context.Context, seq generation.Sequence) error {
	status, err := sequencecontract.NormalizeStatus(seq.Status)
	if err != nil {
		return err
	}
	if !isCanonicalSequenceUUID(seq.ID) {
		return ErrNotFound
	}
	seq.Status = status
	tx, err := s.beginTenant(ctx, seq.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Marshal each side independently. nil → "null" jsonb so the
	// distinction between "absent" and "[]" survives the round-trip.
	var emailsJSON, stepsJSON []byte
	if seq.Emails != nil {
		emailsJSON, _ = json.Marshal(seq.Emails)
	}
	if seq.Steps != nil {
		stepsJSON, _ = json.Marshal(seq.Steps)
	}
	goalJSON := marshalGoal(seq.Goal)
	_, err = tx.Exec(ctx, `
		INSERT INTO voice_sequences
			(id, tenant_id, template_id, name, status, emails, steps, goal, stuck_after_days, created_at, updated_at, version)
		VALUES (
			$1::uuid, $2::uuid, $3, $4,
			COALESCE(NULLIF($5,''),'draft'),
			COALESCE($6::jsonb, '[]'::jsonb),
			$7::jsonb,
			$8::jsonb, $9,
			$10, now(),
			1
		)
		ON CONFLICT (id) DO UPDATE SET
			template_id = EXCLUDED.template_id,
			name = EXCLUDED.name,
			status = EXCLUDED.status,
			emails = EXCLUDED.emails,
			steps = EXCLUDED.steps,
			goal = EXCLUDED.goal,
			stuck_after_days = EXCLUDED.stuck_after_days,
			updated_at = now(),
			version = voice_sequences.version + 1
	`, seq.ID, seq.TenantID, seq.TemplateID, seq.Name, seq.Status,
		jsonbOrNil(emailsJSON), jsonbOrNil(stepsJSON),
		jsonbOrNil(goalJSON), seq.StuckAfterDays, seq.CreatedAt)
	if err != nil {
		return fmt.Errorf("upsert voice_sequence: %w", err)
	}
	return tx.Commit(ctx)
}

// SaveWithVersion writes the sequence only when the row's current
// version matches expectedVersion. On a mismatch the store returns
// ErrVersionMismatch and the handler maps it to HTTP 412 Precondition
// Failed so the canvas can re-fetch + re-emit ops. On success the
// row's version increases by 1 and the new value is returned.
func (s *Store) SaveWithVersion(ctx context.Context, seq generation.Sequence, expectedVersion int64) (int64, error) {
	status, err := sequencecontract.NormalizeStatus(seq.Status)
	if err != nil {
		return 0, err
	}
	if !isCanonicalSequenceUUID(seq.ID) {
		return 0, ErrNotFound
	}
	seq.Status = status
	tx, err := s.beginTenant(ctx, seq.TenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var emailsJSON, stepsJSON []byte
	if seq.Emails != nil {
		emailsJSON, _ = json.Marshal(seq.Emails)
	}
	if seq.Steps != nil {
		stepsJSON, _ = json.Marshal(seq.Steps)
	}
	goalJSON := marshalGoal(seq.Goal)
	var newVersion int64
	err = tx.QueryRow(ctx, `
		UPDATE voice_sequences SET
			template_id = $3,
			name = $4,
			status = COALESCE(NULLIF($5,''),'draft'),
			emails = COALESCE($6::jsonb, '[]'::jsonb),
			steps = $7::jsonb,
			goal = $8::jsonb,
			stuck_after_days = $9,
			updated_at = now(),
			version = version + 1
		WHERE tenant_id = $1::uuid
		  AND id = $2::uuid
		  AND version = $10
		RETURNING version
	`, seq.TenantID, seq.ID, seq.TemplateID, seq.Name, seq.Status,
		jsonbOrNil(emailsJSON), jsonbOrNil(stepsJSON),
		jsonbOrNil(goalJSON), seq.StuckAfterDays, expectedVersion).Scan(&newVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		// Disambiguate "no row" from "version mismatch" with a cheap
		// follow-up existence check. RLS is already in scope on the
		// transaction so the tenant filter doesn't need to be
		// re-asserted in the predicate.
		var exists bool
		if err2 := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM voice_sequences
			              WHERE tenant_id = $1::uuid AND id = $2::uuid)
		`, seq.TenantID, seq.ID).Scan(&exists); err2 != nil {
			return 0, err2
		}
		if !exists {
			return 0, ErrNotFound
		}
		return 0, ErrVersionMismatch
	}
	if err != nil {
		return 0, fmt.Errorf("conditional update voice_sequence: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return newVersion, nil
}

// jsonbOrNil returns the bytes as a string if non-empty, else nil so
// pgx writes a SQL NULL into the jsonb column. We can't pass `[]byte`
// directly because pgx would encode an empty []byte as `""` for jsonb,
// which Postgres rejects.
func jsonbOrNil(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

// marshalGoal renders the optional sequence goal for the jsonb column.
// nil goal → nil bytes → SQL NULL (no goal configured).
func marshalGoal(g *generation.SequenceGoal) []byte {
	if g == nil {
		return nil
	}
	b, _ := json.Marshal(g)
	return b
}

// Get reads one sequence by id inside a tenant-scoped tx.
func (s *Store) Get(ctx context.Context, tenantID, id string) (generation.Sequence, error) {
	if !isCanonicalSequenceUUID(id) {
		return generation.Sequence{}, ErrNotFound
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return generation.Sequence{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var seq generation.Sequence
	var emailsRaw, stepsRaw, goalRaw []byte
	var templateID *string
	err = tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, template_id, name, status, emails, steps, goal, stuck_after_days, created_at, updated_at, version
		  FROM voice_sequences WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, id).Scan(&seq.ID, &seq.TenantID, &templateID, &seq.Name, &seq.Status, &emailsRaw, &stepsRaw, &goalRaw, &seq.StuckAfterDays, &seq.CreatedAt, &seq.UpdatedAt, &seq.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return seq, ErrNotFound
	}
	if err != nil {
		return seq, err
	}
	if templateID != nil {
		seq.TemplateID = *templateID
	}
	if err := decodeSequenceJSON(&seq, emailsRaw, stepsRaw, goalRaw); err != nil {
		return seq, err
	}
	return seq, tx.Commit(ctx)
}

// List returns sequences for a tenant, newest first.
func (s *Store) List(ctx context.Context, tenantID string) ([]generation.Sequence, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, template_id, name, status, emails, steps, goal, stuck_after_days, created_at, updated_at, version
		  FROM voice_sequences WHERE tenant_id = $1::uuid
		  ORDER BY updated_at DESC
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]generation.Sequence, 0)
	for rows.Next() {
		var seq generation.Sequence
		var emailsRaw, stepsRaw, goalRaw []byte
		var templateID *string
		if err := rows.Scan(&seq.ID, &seq.TenantID, &templateID, &seq.Name, &seq.Status, &emailsRaw, &stepsRaw, &goalRaw, &seq.StuckAfterDays, &seq.CreatedAt, &seq.UpdatedAt, &seq.Version); err != nil {
			return nil, err
		}
		if templateID != nil {
			seq.TemplateID = *templateID
		}
		if err := decodeSequenceJSON(&seq, emailsRaw, stepsRaw, goalRaw); err != nil {
			return nil, err
		}
		out = append(out, seq)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeSequenceJSON(seq *generation.Sequence, emailsRaw, stepsRaw, goalRaw []byte) error {
	if len(emailsRaw) > 0 {
		if err := json.Unmarshal(emailsRaw, &seq.Emails); err != nil {
			return fmt.Errorf("decode voice_sequence %q emails: %w", seq.ID, err)
		}
	}
	if len(stepsRaw) > 0 {
		if err := json.Unmarshal(stepsRaw, &seq.Steps); err != nil {
			return fmt.Errorf("decode voice_sequence %q steps: %w", seq.ID, err)
		}
	}
	if len(goalRaw) > 0 {
		if err := json.Unmarshal(goalRaw, &seq.Goal); err != nil {
			return fmt.Errorf("decode voice_sequence %q goal: %w", seq.ID, err)
		}
	}
	return nil
}

// Delete removes one sequence inside a tenant-scoped transaction.
func (s *Store) Delete(ctx context.Context, tenantID, id string) error {
	if !isCanonicalSequenceUUID(id) {
		return ErrNotFound
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		DELETE FROM voice_sequences
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, id)
	if err != nil {
		return fmt.Errorf("delete voice_sequence: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// DeleteWithVersion removes a sequence only when the caller's last-seen row
// version is still current. This closes the read/edit/delete race for public
// HTTP callers while Delete remains available to trusted server-side paths.
func (s *Store) DeleteWithVersion(ctx context.Context, tenantID, id string, expectedVersion int64) error {
	if !isCanonicalSequenceUUID(id) {
		return ErrNotFound
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		DELETE FROM voice_sequences
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND version = $3
	`, tenantID, id, expectedVersion)
	if err != nil {
		return fmt.Errorf("conditionally delete voice_sequence: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM voice_sequences
			              WHERE tenant_id = $1::uuid AND id = $2::uuid)
		`, tenantID, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		return ErrVersionMismatch
	}
	return tx.Commit(ctx)
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

func isCanonicalSequenceUUID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed.String() == id
}

// ErrNotFound is returned when no row exists.
var ErrNotFound = sequencecontract.ErrNotFound

// ErrVersionMismatch is returned by SaveWithVersion when the caller's
// expected version no longer matches the row's current version — i.e.
// another writer landed between the read-then-write. The handler maps
// this to HTTP 412 Precondition Failed so the canvas can reload + retry.
var ErrVersionMismatch = sequencecontract.ErrVersionMismatch
