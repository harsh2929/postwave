// Package orchestrator's fanout.go: writes a webhook fan-out row into
// the shared outbox_events table so the apps/api FanoutHandler can
// expand it into per-subscription deliveries. Lives in this service
// (rather than importing a shared package) because services/migration
// is a separate Go module — see LICENSE-BOUNDARY.md.
//
// The wire shape (kind="webhook.fanout", payload schema) is duplicated
// across services on purpose: it's a narrow, slow-moving contract,
// and the alternative (a dedicated proto package shared by sibling
// services) is overkill for two string fields and a JSON body.

package orchestrator

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// fanoutKind matches webhooks.FanoutKind in apps/api. Don't change without
// updating the apps/api FanoutHandler registration.
const fanoutKind = "webhook.fanout"

// emitFanout writes a single outbox row that the gateway's outbox worker
// will expand into webhook deliveries. Best-effort: errors are returned
// for the caller to log, but the migration's terminal state has already
// committed by the time we get here so failure here doesn't roll
// anything back.
func emitFanout(ctx context.Context, db *sql.DB, tenantID, eventType string, body any) error {
	if db == nil || tenantID == "" || eventType == "" {
		return nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("emit fanout: marshal body: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"event_type": eventType,
		"body":       json.RawMessage(bodyBytes),
	})
	if err != nil {
		return fmt.Errorf("emit fanout: marshal payload: %w", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("emit fanout: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	// RLS on outbox_events requires app.tenant_id to match the row's
	// tenant_id; bind it inside this tx so the INSERT passes the
	// WITH CHECK clause.
	if _, err := tx.ExecContext(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("emit fanout: bind tenant: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`,
		tenantID, fanoutKind, string(payload),
	); err != nil {
		return fmt.Errorf("emit fanout: insert: %w", err)
	}
	return tx.Commit()
}
