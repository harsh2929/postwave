// SPDX-License-Identifier: AGPL-3.0-only
//
// store_pg.go — Postgres impl of Store. Every method opens a
// tenant-scoped tx via db.WithTenant so RLS gates each query at the
// correct boundary. FindTestByToken is the one method that crosses
// tenants — see its impl below for the security model.

package inboxreality

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// pgStore is the production Store backed by Postgres.
type pgStore struct {
	pool *db.Pool
}

const testColumns = `
id::text, tenant_id::text, header_token, kind,
COALESCE(subject,''), COALESCE(from_address,''), status,
COALESCE(campaign_id::text, ''), COALESCE(content_revision_id::text, ''),
COALESCE(send_plan_id::text, ''), COALESCE(artifact_id::text, ''),
COALESCE(scenario_id, ''), COALESCE(outbound_mime_hash, ''),
COALESCE(outbound_mime_structure_hash, ''), requested_capabilities::text,
created_at, updated_at, completed_at, expires_at, meta::text`

// NewPostgresStore wraps the pgx pool in a Store. Returns an error
// when pool is nil — failing loudly at boot is safer than NPE on the
// first request.
func NewPostgresStore(pool *db.Pool) (Store, error) {
	if pool == nil {
		return nil, errors.New("inboxreality: nil pool")
	}
	return &pgStore{pool: pool}, nil
}

func (s *pgStore) CreateTest(ctx context.Context, p CreateTestParams) (Test, error) {
	if p.TenantID == "" {
		return Test{}, errors.New("inboxreality: tenant_id required")
	}
	if p.HeaderToken == "" {
		return Test{}, errors.New("inboxreality: header_token required")
	}
	tx, err := db.WithTenant(ctx, s.pool, p.TenantID)
	if err != nil {
		return Test{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	meta := p.Meta
	if len(meta) == 0 {
		meta = []byte("{}")
	}
	var t Test
	var completedAt *time.Time
	var metaText string
	err = tx.QueryRow(ctx, `
		INSERT INTO inbox_reality_tests
		  (tenant_id, header_token, kind, subject, from_address, expires_at, meta)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
		RETURNING `+testColumns+`
	`, p.TenantID, p.HeaderToken, string(p.Kind), p.Subject, p.FromAddress, p.ExpiresAt, string(meta)).Scan(
		&t.ID, &t.TenantID, &t.HeaderToken, (*string)(&t.Kind),
		&t.Subject, &t.FromAddress, (*string)(&t.Status),
		&t.CampaignID, &t.ContentRevisionID, &t.SendPlanID, &t.ArtifactID,
		&t.ScenarioID, &t.OutboundMIMEHash, &t.OutboundMIMEStructureHash,
		&t.RequestedCapabilities,
		&t.CreatedAt, &t.UpdatedAt, &completedAt, &t.ExpiresAt,
		&metaText,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// UNIQUE violation: header_token collision (cosmic-ray
			// odds — but the unique constraint covers it).
			return Test{}, ErrTokenCollision
		}
		return Test{}, fmt.Errorf("insert inbox_reality_tests: %w", err)
	}
	t.CompletedAt = completedAt
	if metaText != "" {
		t.Meta = json.RawMessage(metaText)
	}
	return t, tx.Commit(ctx)
}

func (s *pgStore) GetTest(ctx context.Context, tenantID, testID string) (Test, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Test{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	t, err := scanOneTest(ctx, tx, `
		SELECT `+testColumns+`
		FROM inbox_reality_tests
		WHERE id = $1::uuid
	`, testID)
	if err != nil {
		return Test{}, err
	}
	return t, tx.Commit(ctx)
}

func (s *pgStore) ListTests(ctx context.Context, tenantID string, limit int) ([]Test, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT `+testColumns+`
		FROM inbox_reality_tests
		ORDER BY created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list inbox_reality_tests: %w", err)
	}
	defer rows.Close()
	out := []Test{}
	for rows.Next() {
		var t Test
		var completedAt *time.Time
		var metaText string
		if err := rows.Scan(
			&t.ID, &t.TenantID, &t.HeaderToken, (*string)(&t.Kind),
			&t.Subject, &t.FromAddress, (*string)(&t.Status),
			&t.CampaignID, &t.ContentRevisionID, &t.SendPlanID, &t.ArtifactID,
			&t.ScenarioID, &t.OutboundMIMEHash, &t.OutboundMIMEStructureHash,
			&t.RequestedCapabilities,
			&t.CreatedAt, &t.UpdatedAt, &completedAt, &t.ExpiresAt,
			&metaText,
		); err != nil {
			return nil, err
		}
		t.CompletedAt = completedAt
		if metaText != "" {
			t.Meta = json.RawMessage(metaText)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *pgStore) ListResults(ctx context.Context, tenantID, testID string) ([]Result, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT r.id::text, r.test_id::text, r.mailbox_id, r.provider, r.placement,
		       COALESCE(r.folder_name,''), r.classified_at, COALESCE(r.raw_headers::text, ''),
		       COALESCE(r.observation_key, ''), COALESCE(r.artifact_id::text, ''),
		       COALESCE(r.scenario_id, ''), r.capability_snapshot::text,
		       COALESCE(r.raw_mime_status, ''), COALESCE(r.received_mime_sha256, ''),
		       COALESCE(r.received_mime_structure_hash, ''),
		       COALESCE(r.structure_comparison, ''), r.observation_captured_at
		FROM inbox_reality_test_results r
		JOIN inbox_reality_tests t ON t.id = r.test_id
		WHERE t.id = $1::uuid
		ORDER BY r.classified_at ASC
	`, testID)
	if err != nil {
		return nil, fmt.Errorf("list inbox_reality_test_results: %w", err)
	}
	defer rows.Close()
	out := []Result{}
	for rows.Next() {
		var r Result
		var raw string
		if err := rows.Scan(
			&r.ID, &r.TestID, &r.MailboxID, (*string)(&r.Provider), (*string)(&r.Placement),
			&r.FolderName, &r.ClassifiedAt, &raw, &r.ObservationKey, &r.ArtifactID,
			&r.ScenarioID, &r.CapabilitySnapshot, &r.RawMIMEStatus,
			&r.ReceivedMIMESHA256, &r.ReceivedStructureSHA256,
			&r.StructureComparison, &r.ObservationCapturedAt,
		); err != nil {
			return nil, err
		}
		r.ProviderLabel = r.Provider.DisplayName()
		if raw != "" {
			r.RawHeaders = json.RawMessage(raw)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *pgStore) RecordResult(ctx context.Context, p RecordResultParams) (Result, error) {
	if !p.Placement.IsKnown() {
		return Result{}, fmt.Errorf("inboxreality: unknown placement %q", p.Placement)
	}
	if !p.Provider.IsKnown() {
		return Result{}, fmt.Errorf("inboxreality: unknown provider %q", p.Provider)
	}
	// We need the tenant_id to bind app.tenant_id; fetch from the
	// parent test first. Two-step is unavoidable when the caller (the
	// pivot worker) has only the token / test_id.
	tenantID, err := s.tenantOfTest(ctx, p.TestID)
	if err != nil {
		return Result{}, err
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw := p.RawHeaders
	if len(raw) == 0 {
		raw = []byte("null")
	}
	var r Result
	var rawOut string
	err = tx.QueryRow(ctx, `
		INSERT INTO inbox_reality_test_results
		  (test_id, mailbox_id, provider, placement, folder_name, raw_headers)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
		ON CONFLICT (test_id, mailbox_id) DO UPDATE
		  SET provider     = EXCLUDED.provider,
		      placement    = EXCLUDED.placement,
		      folder_name  = EXCLUDED.folder_name,
		      raw_headers  = EXCLUDED.raw_headers,
		      classified_at = now()
		RETURNING id::text, test_id::text, mailbox_id, provider, placement,
		          COALESCE(folder_name,''), classified_at, COALESCE(raw_headers::text, '')
	`, p.TestID, p.MailboxID, string(p.Provider), string(p.Placement), p.FolderName, string(raw)).Scan(
		&r.ID, &r.TestID, &r.MailboxID, (*string)(&r.Provider), (*string)(&r.Placement),
		&r.FolderName, &r.ClassifiedAt, &rawOut,
	)
	if err != nil {
		return Result{}, fmt.Errorf("upsert inbox_reality_test_results: %w", err)
	}
	r.ProviderLabel = r.Provider.DisplayName()
	if rawOut != "" && rawOut != "null" {
		r.RawHeaders = json.RawMessage(rawOut)
	}
	return r, tx.Commit(ctx)
}

// tenantOfTest is a tenant-id resolver that uses the
// `inbox_reality_resolver` bypass GUC — required because the caller
// (orchestrator pivot from the deliverability service) knows the test
// id but not the tenant. The bypass is enforced by migration 0156's
// PERMISSIVE policy gated on `app.inbox_reality_resolver = 'true'`.
//
// Before 0156: this function ran a bare pool.QueryRow against a table
// with FORCE RLS; the query always returned ZERO rows and the entire
// Inbox Reality pivot flow was broken end-to-end.
func (s *pgStore) tenantOfTest(ctx context.Context, testID string) (string, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", fmt.Errorf("tenantOfTest begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.inbox_reality_resolver', 'true', true)`); err != nil {
		return "", fmt.Errorf("tenantOfTest set_config: %w", err)
	}
	var tenantID string
	err = tx.QueryRow(ctx, `
		SELECT tenant_id::text FROM inbox_reality_tests WHERE id = $1::uuid
	`, testID).Scan(&tenantID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("lookup tenant of test: %w", err)
	}
	return tenantID, nil
}

func (s *pgStore) UpdateStatus(ctx context.Context, tenantID, testID string, status TestStatus, completedAt *time.Time) error {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ct, err := tx.Exec(ctx, `
		UPDATE inbox_reality_tests
		   SET status = $2, completed_at = $3
		 WHERE id = $1::uuid
	`, testID, string(status), completedAt)
	if err != nil {
		return fmt.Errorf("update inbox_reality_tests status: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// FindTestByToken is the cross-tenant lookup. The 16-byte random
// token IS the auth (knowing it proves you own the message that
// carries it). Uses the `inbox_reality_resolver` bypass GUC from
// migration 0156 — see tenantOfTest for the rationale.
func (s *pgStore) FindTestByToken(ctx context.Context, token string) (Test, error) {
	if token == "" {
		return Test{}, ErrNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return Test{}, fmt.Errorf("FindTestByToken begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.inbox_reality_resolver', 'true', true)`); err != nil {
		return Test{}, fmt.Errorf("FindTestByToken set_config: %w", err)
	}
	row := tx.QueryRow(ctx, `
		SELECT `+testColumns+`
		FROM inbox_reality_tests
		WHERE header_token = $1
	`, token)
	var t Test
	var completedAt *time.Time
	var metaText string
	if err := row.Scan(
		&t.ID, &t.TenantID, &t.HeaderToken, (*string)(&t.Kind),
		&t.Subject, &t.FromAddress, (*string)(&t.Status),
		&t.CampaignID, &t.ContentRevisionID, &t.SendPlanID, &t.ArtifactID,
		&t.ScenarioID, &t.OutboundMIMEHash, &t.OutboundMIMEStructureHash,
		&t.RequestedCapabilities,
		&t.CreatedAt, &t.UpdatedAt, &completedAt, &t.ExpiresAt,
		&metaText,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Test{}, ErrNotFound
		}
		return Test{}, fmt.Errorf("find test by token: %w", err)
	}
	t.CompletedAt = completedAt
	if metaText != "" {
		t.Meta = json.RawMessage(metaText)
	}
	return t, nil
}

// scanOneTest is a small helper for single-row test reads.
func scanOneTest(ctx context.Context, q pgx.Tx, sql string, args ...any) (Test, error) {
	row := q.QueryRow(ctx, sql, args...)
	var t Test
	var completedAt *time.Time
	var metaText string
	if err := row.Scan(
		&t.ID, &t.TenantID, &t.HeaderToken, (*string)(&t.Kind),
		&t.Subject, &t.FromAddress, (*string)(&t.Status),
		&t.CampaignID, &t.ContentRevisionID, &t.SendPlanID, &t.ArtifactID,
		&t.ScenarioID, &t.OutboundMIMEHash, &t.OutboundMIMEStructureHash,
		&t.RequestedCapabilities,
		&t.CreatedAt, &t.UpdatedAt, &completedAt, &t.ExpiresAt,
		&metaText,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Test{}, ErrNotFound
		}
		return Test{}, fmt.Errorf("scan inbox_reality_tests: %w", err)
	}
	t.CompletedAt = completedAt
	if metaText != "" {
		t.Meta = json.RawMessage(metaText)
	}
	return t, nil
}
