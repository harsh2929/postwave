// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Store wraps the audit_investigations table.
type Store struct {
	Pool QueryablePool
}

// Investigation is the persisted form of a Result plus its lifecycle.
type Investigation struct {
	ID               string           `json:"id"`
	TenantID         string           `json:"tenant_id"`
	SeedAuditID      int64            `json:"seed_audit_id"`
	Findings         []Finding        `json:"findings"`
	EvidenceAuditIDs []int64          `json:"evidence_audit_ids"`
	ProposedActions  []ProposedAction `json:"proposed_actions"`
	MitreTechniques  []string         `json:"mitre_techniques"`
	Confidence       float64          `json:"confidence"`
	Status           string           `json:"status"`
	ApprovedAt       *time.Time       `json:"approved_at,omitempty"`
	ApprovedBy       string           `json:"approved_by,omitempty"`
	RejectionReason  string           `json:"rejection_reason,omitempty"`
	CompletedAt      *time.Time       `json:"completed_at,omitempty"`
	ExecutedAt       *time.Time       `json:"executed_at,omitempty"`
	ExecutedBy       string           `json:"executed_by,omitempty"`
	CreatedAt        time.Time        `json:"created_at"`
	UpdatedAt        time.Time        `json:"updated_at"`
}

// Insert persists a Result for the given tenant + seed. Returns the
// new investigation id, or the existing id when the tenant + seed
// already has an investigation (idempotent re-trigger).
//
// Re-validates the cited-evidence invariant — even if a caller
// somehow handed us a malformed Result, the persisted row must be
// well-formed.
func (s *Store) Insert(ctx context.Context, tenantID string, res *Result) (string, error) {
	if s == nil || s.Pool == nil {
		return "", errors.New("store: missing pool")
	}
	if err := res.Validate(); err != nil {
		return "", err
	}
	findingsJSON, err := json.Marshal(res.Findings)
	if err != nil {
		return "", fmt.Errorf("store: marshal findings: %w", err)
	}
	actionsJSON, err := json.Marshal(res.ProposedActions)
	if err != nil {
		return "", fmt.Errorf("store: marshal actions: %w", err)
	}

	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", fmt.Errorf("store: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", fmt.Errorf("store: set tenant: %w", err)
	}

	// ON CONFLICT (tenant_id, seed_audit_id) DO NOTHING + RETURNING id —
	// when the unique constraint fires, RETURNING is empty, so we re-
	// SELECT the existing row.
	const ins = `
INSERT INTO audit_investigations
    (tenant_id, seed_audit_id, findings, evidence_audit_ids, proposed_actions,
     mitre_techniques, confidence, status, completed_at)
VALUES ($1::uuid, $2, $3::jsonb, $4::bigint[], $5::jsonb, $6::text[], $7, 'draft', $8)
ON CONFLICT (tenant_id, seed_audit_id) DO NOTHING
RETURNING id`
	var id string
	err = tx.QueryRow(ctx, ins,
		tenantID, res.SeedAuditID, string(findingsJSON), res.EvidenceAuditIDs,
		string(actionsJSON), res.MitreTechniques, res.Confidence, res.GeneratedAt,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// Existing investigation — fetch its id.
		const sel = `SELECT id::text FROM audit_investigations WHERE tenant_id = $1::uuid AND seed_audit_id = $2`
		if err := tx.QueryRow(ctx, sel, tenantID, res.SeedAuditID).Scan(&id); err != nil {
			return "", fmt.Errorf("store: re-select existing: %w", err)
		}
	} else if err != nil {
		return "", fmt.Errorf("store: insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("store: commit: %w", err)
	}
	return id, nil
}

// Get loads a single investigation by id.
func (s *Store) Get(ctx context.Context, tenantID, id string) (*Investigation, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("store: missing pool")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("store: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, fmt.Errorf("store: set tenant: %w", err)
	}
	const q = `
SELECT id::text, tenant_id::text, seed_audit_id, findings::text,
       evidence_audit_ids, proposed_actions::text, mitre_techniques,
       confidence, status,
       approved_at, COALESCE(approved_by::text, ''),
       COALESCE(rejection_reason, ''),
       completed_at, executed_at, COALESCE(executed_by::text, ''),
       created_at, updated_at
FROM audit_investigations
WHERE id = $1::uuid
LIMIT 1`
	var inv Investigation
	var findingsTxt, actionsTxt string
	if err := tx.QueryRow(ctx, q, id).Scan(
		&inv.ID, &inv.TenantID, &inv.SeedAuditID, &findingsTxt,
		&inv.EvidenceAuditIDs, &actionsTxt, &inv.MitreTechniques,
		&inv.Confidence, &inv.Status,
		&inv.ApprovedAt, &inv.ApprovedBy, &inv.RejectionReason,
		&inv.CompletedAt, &inv.ExecutedAt, &inv.ExecutedBy,
		&inv.CreatedAt, &inv.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("store: get: %w", err)
	}
	if err := json.Unmarshal([]byte(findingsTxt), &inv.Findings); err != nil {
		return nil, fmt.Errorf("store: unmarshal findings: %w", err)
	}
	if err := json.Unmarshal([]byte(actionsTxt), &inv.ProposedActions); err != nil {
		return nil, fmt.Errorf("store: unmarshal actions: %w", err)
	}
	return &inv, nil
}

// ListFilter governs the List query.
type ListFilter struct {
	Status string
	Limit  int
}

// List returns investigations ordered by created_at DESC.
func (s *Store) List(ctx context.Context, tenantID string, f ListFilter) ([]Investigation, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("store: missing pool")
	}
	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("store: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, fmt.Errorf("store: set tenant: %w", err)
	}
	const q = `
SELECT id::text, tenant_id::text, seed_audit_id, findings::text,
       evidence_audit_ids, proposed_actions::text, mitre_techniques,
       confidence, status,
       approved_at, COALESCE(approved_by::text, ''),
       COALESCE(rejection_reason, ''),
       completed_at, executed_at, COALESCE(executed_by::text, ''),
       created_at, updated_at
FROM audit_investigations
WHERE ($1 = '' OR status = $1)
ORDER BY created_at DESC
LIMIT $2`
	rows, err := tx.Query(ctx, q, f.Status, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list: %w", err)
	}
	defer rows.Close()
	out := make([]Investigation, 0, 16)
	for rows.Next() {
		var inv Investigation
		var findingsTxt, actionsTxt string
		if err := rows.Scan(
			&inv.ID, &inv.TenantID, &inv.SeedAuditID, &findingsTxt,
			&inv.EvidenceAuditIDs, &actionsTxt, &inv.MitreTechniques,
			&inv.Confidence, &inv.Status,
			&inv.ApprovedAt, &inv.ApprovedBy, &inv.RejectionReason,
			&inv.CompletedAt, &inv.ExecutedAt, &inv.ExecutedBy,
			&inv.CreatedAt, &inv.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("store: scan: %w", err)
		}
		if err := json.Unmarshal([]byte(findingsTxt), &inv.Findings); err != nil {
			return nil, fmt.Errorf("store: unmarshal findings: %w", err)
		}
		if err := json.Unmarshal([]byte(actionsTxt), &inv.ProposedActions); err != nil {
			return nil, fmt.Errorf("store: unmarshal actions: %w", err)
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// Approve flips status draft → approved and stamps approved_at /
// approved_by. Caller is expected to already have validated the
// approver's permission; the GUC-scoped policy enforces tenant
// isolation but does NOT check approver scope.
func (s *Store) Approve(ctx context.Context, tenantID, id, approverUserID string) error {
	now := time.Now().UTC()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("store: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("store: set tenant: %w", err)
	}
	const q = `
UPDATE audit_investigations
   SET status = 'approved', approved_at = $2, approved_by = NULLIF($3, '')::uuid, updated_at = $2
 WHERE id = $1::uuid AND status = 'draft'`
	tag, err := tx.Exec(ctx, q, id, now, approverUserID)
	if err != nil {
		return fmt.Errorf("store: approve: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("store: investigation not in draft state")
	}
	return tx.Commit(ctx)
}

// Reject flips status draft → rejected and records the reason. The
// rejection_reason is required so the audit trail captures the
// rationale for not acting.
func (s *Store) Reject(ctx context.Context, tenantID, id, reason string) error {
	if reason == "" {
		return errors.New("store: rejection reason required")
	}
	now := time.Now().UTC()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("store: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("store: set tenant: %w", err)
	}
	const q = `
UPDATE audit_investigations
   SET status = 'rejected', rejection_reason = $2, updated_at = $3
 WHERE id = $1::uuid AND status = 'draft'`
	tag, err := tx.Exec(ctx, q, id, reason, now)
	if err != nil {
		return fmt.Errorf("store: reject: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("store: investigation not in draft state")
	}
	return tx.Commit(ctx)
}
