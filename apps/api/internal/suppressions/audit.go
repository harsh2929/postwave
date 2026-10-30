// audit.go — GAP-LS-008. Per-row audit trail for suppression
// mutations. One row in suppression_audit per add/remove/update/expire
// so an operator can answer "who removed this address from the list
// and when?" during a compliance review.
//
// Writers call AuditLogger.Record inside (or alongside) the same tx
// as the mutating INSERT/UPDATE/DELETE. We intentionally do NOT use a
// pg trigger — the actor (user_id, api_key_id) only exists at the
// gateway layer, so the audit row has to be written from go.

package suppressions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// AuditAction matches the CHECK constraint in migration 0246.
type AuditAction string

const (
	AuditActionAdd    AuditAction = "add"
	AuditActionRemove AuditAction = "remove"
	AuditActionUpdate AuditAction = "update"
	AuditActionExpire AuditAction = "expire"
)

// AuditEntry is one row of the audit log surface. The write path
// (Record) sets the identifying fields; the read path (Store.
// AuditForEmailPaged / RecentAuditForEmail) additionally hydrates ID,
// CreatedAt and the derived Actor convenience field (actor_user_id
// when present, else actor_api_key_id) so the dashboard can render a
// "who did this" column without re-deriving it client-side.
type AuditEntry struct {
	ID            string         `json:"id,omitempty"`
	TenantID      string         `json:"tenant_id"`
	Email         string         `json:"email"`
	Action        AuditAction    `json:"action"`
	Actor         string         `json:"actor,omitempty"`
	ActorUserID   string         `json:"actor_user_id,omitempty"`
	ActorAPIKeyID string         `json:"actor_api_key_id,omitempty"`
	Reason        string         `json:"reason,omitempty"`
	SourceTable   string         `json:"source_table"`
	Payload       map[string]any `json:"payload,omitempty"`
	CreatedAt     *time.Time     `json:"created_at,omitempty"`
}

// AuditLogger writes rows to suppression_audit. Nil-safe: every method
// no-ops on a nil receiver so callers can wire it as an optional
// dependency and skip-on-nil at call sites.
type AuditLogger struct {
	Pool *db.Pool
}

// Record inserts a single audit row. Best-effort by contract: the
// caller MUST NOT roll back the mutating tx on an audit-write failure
// (we'd rather lose a log line than block a legitimate suppression
// add). Errors are returned for visibility/logging only.
func (a *AuditLogger) Record(ctx context.Context, e AuditEntry) error {
	if a == nil || a.Pool == nil {
		return nil
	}
	if e.TenantID == "" || e.Email == "" || e.Action == "" || e.SourceTable == "" {
		return errors.New("suppressions audit: missing required field")
	}
	payload := e.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("suppressions audit: marshal payload: %w", err)
	}
	tx, err := db.WithTenant(ctx, a.Pool, e.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// nullableUUID wraps a maybe-empty string so the inet column
	// accepts NULL when the actor wasn't set on the request.
	if _, err := tx.Exec(ctx, `
INSERT INTO suppression_audit
    (tenant_id, email, action, actor_user_id, actor_api_key_id,
     reason, source_table, payload)
VALUES ($1::uuid, $2::citext, $3, NULLIF($4,'')::uuid, NULLIF($5,'')::uuid,
        NULLIF($6,''), $7, $8::jsonb)`,
		e.TenantID, e.Email, string(e.Action),
		e.ActorUserID, e.ActorAPIKeyID,
		e.Reason, e.SourceTable, raw,
	); err != nil {
		return fmt.Errorf("suppressions audit: insert: %w", err)
	}
	return tx.Commit(ctx)
}
