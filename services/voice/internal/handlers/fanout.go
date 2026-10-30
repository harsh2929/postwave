// fanout.go: writes webhook.fanout outbox rows so the apps/api gateway
// can expand them into per-subscription deliveries. Same shape as
// services/migration/internal/orchestrator/fanout.go and
// services/automation/internal/runtime/fanout.go — duplicated rather
// than packaged because the wire contract (kind="webhook.fanout",
// payload {event_type, body}) is narrow and crossing the services/*
// license boundary for it isn't worth the indirection.

package handlers

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
// matches the rest of services/voice, which uses pgx throughout.
type PgxFanoutEmitter struct {
	Pool *pgxpool.Pool
}

// Emit writes one webhook.fanout outbox row scoped to tenantID. RLS on
// outbox_events requires app.tenant_id to match the row; we bind the
// GUC inside the same tx as the INSERT.
func (e *PgxFanoutEmitter) Emit(ctx context.Context, tenantID, eventType string, body any) error {
	if e == nil || e.Pool == nil || tenantID == "" || eventType == "" {
		return nil
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("voice fanout: marshal body: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"event_type": eventType,
		"body":       json.RawMessage(bodyBytes),
	})
	if err != nil {
		return fmt.Errorf("voice fanout: marshal payload: %w", err)
	}
	tx, err := e.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("voice fanout: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("voice fanout: bind tenant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`,
		tenantID, fanoutKind, string(payload),
	); err != nil {
		return fmt.Errorf("voice fanout: insert: %w", err)
	}
	return tx.Commit(ctx)
}
