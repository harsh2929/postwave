package runtime

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// smsKind matches sms.AutomationOutboxKind in apps/api. Don't change — it's the
// cross-service wire contract for the automation.sms outbox row.
const smsKind = "automation.sms"

// SMSSendRequest is the payload a send_sms node enqueues for apps/api to deliver.
// apps/api resolves the sender, RE-CHECKS consent / quiet-hours / cost via the
// SMS Gate, sends through the provider, and records — so the engine never
// touches provider credentials or bypasses consent.
type SMSSendRequest struct {
	SubscriberEmail string `json:"subscriber_email"`
	Phone           string `json:"phone"`
	Body            string `json:"body"`
	AutomationID    string `json:"automation_id"`
	NodeID          string `json:"node_id"`
}

// SMSEmitter enqueues a transactional SMS for apps/api to deliver. nil disables
// SMS nodes (they advance as a no-op) — the dev/test default.
type SMSEmitter interface {
	Emit(ctx context.Context, tenantID string, req SMSSendRequest) error
}

// PgxSMSEmitter writes an automation.sms outbox row, mirroring PgxFanoutEmitter.
type PgxSMSEmitter struct {
	Pool *pgxpool.Pool
}

func (e *PgxSMSEmitter) Emit(ctx context.Context, tenantID string, req SMSSendRequest) error {
	// A misconfigured emitter must not report success. Returning nil here told the
	// engine the work was enqueued and it advanced to the next node — so a
	// send that never happened looked exactly like one that did: no error, no
	// retry, no DLQ entry, and a run marked complete.
	//
	// The nil-INTERFACE case is already handled at the call site (engine.go checks
	// `if e.Email != nil` before reaching this), so arriving here means somebody
	// wired an emitter. A nil receiver, an unset pool or an empty tenant are all
	// wiring faults, and the only safe answer to "did it send?" is an error.
	if tenantID == "" {
		return fmt.Errorf("automation sms: tenant id required")
	}
	if e == nil || e.Pool == nil {
		return fmt.Errorf("automation sms: emitter is not configured")
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("automation sms: marshal: %w", err)
	}
	tx, err := e.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("automation sms: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("automation sms: bind tenant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`,
		tenantID, smsKind, string(payload),
	); err != nil {
		return fmt.Errorf("automation sms: insert: %w", err)
	}
	return tx.Commit(ctx)
}
