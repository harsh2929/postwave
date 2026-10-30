// SPDX-License-Identifier: AGPL-3.0-only
//
// approvals.go — the Postgres-backed ApprovalGate. A manual_review node (or any
// node with RequiresApproval=true) pauses the flow here: the gate records a
// per-node approval request in automation_message_approvals (migration 0202) on
// first sight and reports the operator's decision back to the engine, which
// parks the execution while pending and resumes it once approved.

package runtime

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PgxApprovalGate implements ApprovalGate over automation_message_approvals.
type PgxApprovalGate struct {
	Pool *pgxpool.Pool
}

// RequiresApproval honors the node's own RequiresApproval flag (the engine only
// consults this for nodes that already set it; manual_review bypasses it and
// gates by type). A future refinement could consult a per-tenant policy.
func (g *PgxApprovalGate) RequiresApproval(ctx context.Context, tenantID, automationID, nodeID string) bool {
	return true
}

// RequestOrCheck requests approval for the node on first sight (idempotent via
// the per-node unique index) and maps the operator's transactional_status onto
// the engine's status vocabulary (pending | approved | rejected).
func (g *PgxApprovalGate) RequestOrCheck(ctx context.Context, tenantID, automationID, nodeID, subscriberEmail string) (string, string, error) {
	if g == nil || g.Pool == nil {
		// No gate configured → never block (matches the nil-Approvals path).
		return "approved", "", nil
	}
	tx, err := g.beginTenant(ctx, tenantID)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_message_approvals
    (tenant_id, automation_id, node_id, transactional_status, requested_at)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, 'requested', now())
ON CONFLICT (
    tenant_id,
    COALESCE(automation_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(journey_id, '00000000-0000-0000-0000-000000000000'::uuid),
    node_id
) DO NOTHING`, tenantID, automationID, nodeID); err != nil {
		return "", "", err
	}
	var id, status string
	if err := tx.QueryRow(ctx, `
SELECT id::text, transactional_status
  FROM automation_message_approvals
 WHERE tenant_id = $1::uuid
   AND automation_id IS NOT DISTINCT FROM NULLIF($2,'')::uuid
   AND node_id = $3`, tenantID, automationID, nodeID).Scan(&id, &status); err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	switch status {
	case "approved":
		return "approved", id, nil
	case "rejected", "revoked":
		return "rejected", id, nil
	default: // 'marketing' (initial) | 'requested'
		return "pending", id, nil
	}
}

func (g *PgxApprovalGate) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("approval gate: tenant id required")
	}
	tx, err := g.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}
