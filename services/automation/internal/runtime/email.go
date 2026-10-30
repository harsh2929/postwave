package runtime

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// emailKind matches campaigns.AutomationEmailOutboxKind in apps/api. Don't
// change — it is the cross-service wire contract for the automation.email
// outbox row.
const emailKind = "automation.email"

// EmailSendRequest is the payload a send_email node enqueues for apps/api to
// deliver.
//
// WHY THIS EXISTS
// ---------------
// A flow's send_email used to call Listmonk's /api/tx DIRECTLY from the engine.
// That skipped, in one line, every guardrail the campaign path enforces:
// suppression lookup, consent, frequency caps, quiet hours, send windows, and
// the tenant kill switch. A flow could mail a suppressed address, at 3am, past
// the frequency cap, while the tenant was paused.
//
// It also could not work at all for a Moosewave template: the engine did
// strconv.Atoi(node.TemplateID), but campaign_templates.id is a uuid, so every
// Moosewave template id failed to parse and the node failed permanently.
//
// TemplateID is therefore a STRING here — a uuid (Moosewave) or a numeric
// listmonk id — and apps/api resolves it, exactly as it does for the campaign
// path. The engine never touches provider credentials and cannot bypass consent.
type EmailSendRequest struct {
	SubscriberEmail string `json:"subscriber_email"`
	// TemplateID is opaque to the engine: a Moosewave template uuid or a numeric
	// listmonk template id. apps/api resolves whichever it is.
	TemplateID   string         `json:"template_id"`
	Subject      string         `json:"subject,omitempty"`
	Data         map[string]any `json:"data,omitempty"`
	AutomationID string         `json:"automation_id"`
	NodeID       string         `json:"node_id"`
	RunID        string         `json:"run_id,omitempty"`
}

// EmailEmitter enqueues a transactional email for apps/api to deliver, where it
// passes through the same suppression/consent/frequency/quiet-hours stack as a
// campaign send. nil falls back to the legacy direct-to-Listmonk path (dev/test).
type EmailEmitter interface {
	Emit(ctx context.Context, tenantID string, req EmailSendRequest) error
}

// PgxEmailEmitter writes an automation.email outbox row, mirroring
// PgxSMSEmitter exactly.
type PgxEmailEmitter struct {
	Pool *pgxpool.Pool
}

func (e *PgxEmailEmitter) Emit(ctx context.Context, tenantID string, req EmailSendRequest) error {
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
		return fmt.Errorf("automation email: tenant id required")
	}
	if e == nil || e.Pool == nil {
		return fmt.Errorf("automation email: emitter is not configured")
	}
	return emitEmailOutbox(ctx, tenantID, req, func(ctx context.Context, options pgx.TxOptions) (emailOutboxTx, error) {
		return e.Pool.BeginTx(ctx, options)
	})
}

type emailOutboxTx interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type beginEmailOutboxTx func(context.Context, pgx.TxOptions) (emailOutboxTx, error)

func emitEmailOutbox(
	ctx context.Context,
	tenantID string,
	req EmailSendRequest,
	begin beginEmailOutboxTx,
) error {
	payload, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("automation email: marshal: %w", err)
	}
	tx, err := begin(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("automation email: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("automation email: bind tenant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`, tenantID, emailKind, string(payload)); err != nil {
		return fmt.Errorf("automation email: enqueue: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("automation email: commit: %w", err)
	}
	return nil
}
