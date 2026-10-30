// Package runtime's fanout.go: writes webhook.fanout outbox rows so the
// apps/api gateway can expand them into per-subscription deliveries.
// See orchestrator/fanout.go in services/migration for the same shape
// used in the migration service — these helpers are deliberately
// duplicated rather than packaged because the wire contract is narrow
// (kind="webhook.fanout", payload {event_type, body}) and crossing the
// services/* license boundary for two-string-fields would be more
// machinery than it's worth.

package runtime

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fanoutKind matches webhooks.FanoutKind in apps/api. Don't change.
const fanoutKind = "webhook.fanout"

// PgxFanoutEmitter implements FanoutEmitter against a pgxpool.Pool —
// matches the rest of services/automation, which uses pgx throughout.
// nil = no emission (the V1 default for tests + dev).
type PgxFanoutEmitter struct {
	Pool *pgxpool.Pool
}

// Emit writes one webhook.fanout outbox row scoped to tenantID. RLS on
// outbox_events requires app.tenant_id to match; we bind it inside the
// same tx as the INSERT.
func (e *PgxFanoutEmitter) Emit(ctx context.Context, tenantID, eventType string, body any) error {
	// Argument validation comes BEFORE the wiring check: an empty event type is
	// a caller bug whether or not fanout happens to be wired, and checking it
	// second made it unreachable for an unconfigured emitter.
	if eventType == "" {
		return fmt.Errorf("automation fanout: event type required")
	}
	// Unlike the email/sms/coupon emitters, this one keeps a silent no-op for a
	// missing emitter or tenant: worker.go already checks both before calling,
	// so reaching here with either unset means fanout was deliberately not
	// wired, and a fanout event is observability rather than an action taken on
	// a subscriber's behalf.
	if e == nil || e.Pool == nil || tenantID == "" {
		return nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("automation fanout: marshal body: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"event_type": eventType,
		"body":       json.RawMessage(bodyBytes),
	})
	if err != nil {
		return fmt.Errorf("automation fanout: marshal payload: %w", err)
	}
	tx, err := e.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("automation fanout: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("automation fanout: bind tenant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`,
		tenantID, fanoutKind, string(payload),
	); err != nil {
		return fmt.Errorf("automation fanout: insert: %w", err)
	}
	return tx.Commit(ctx)
}
