// SPDX-License-Identifier: AGPL-3.0-only
//
// list_membership.go — the cross-service wire for a flow's "Move to list"
// action.
//
// The action used to call Listmonk's PUT /api/subscribers/lists from the
// engine. That put the contact on the ENGINE's list and nowhere else. The list
// a campaign sends to is Moosewave's (list_subscribers, read by the campaign
// audience resolver and the Members tab), and nothing brings an engine-side
// membership back — so a flow that moved someone to a list never got them a
// single campaign sent to that list. It also failed permanently for any list
// named by its Moosewave uuid, because it Atoi'd the id.
//
// The engine now enqueues an automation.list_membership outbox row, exactly as
// send_sms and send_email do, and apps/api writes the membership through the
// canonical owned writer (lists.AutomationListMembershipHandler), resolving the
// list id in either form.

package runtime

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// listMembershipKind matches lists.AutomationListMembershipKind in apps/api.
// Don't change it — it is the cross-service wire contract for the outbox row.
const listMembershipKind = "automation.list_membership"

// ListMembershipRequest is the payload a move_to_list action enqueues. ListID
// is opaque to the engine: the list's engine id (what the flow editor saves)
// or its Moosewave uuid. apps/api resolves whichever it is.
type ListMembershipRequest struct {
	SubscriberEmail string `json:"subscriber_email"`
	ListID          string `json:"list_id"`
	AutomationID    string `json:"automation_id"`
	NodeID          string `json:"node_id"`
	RunID           string `json:"run_id,omitempty"`
}

// ListMembershipEmitter enqueues a list membership for apps/api to write.
type ListMembershipEmitter interface {
	Emit(ctx context.Context, tenantID string, req ListMembershipRequest) error
}

// PgxListMembershipEmitter writes an automation.list_membership outbox row,
// mirroring PgxSMSEmitter.
type PgxListMembershipEmitter struct {
	Pool *pgxpool.Pool
}

func (e *PgxListMembershipEmitter) Emit(ctx context.Context, tenantID string, req ListMembershipRequest) error {
	// A misconfigured emitter must not report success: the engine would
	// advance past a membership that was never written. A nil receiver, an
	// unset pool or an empty tenant are wiring faults.
	if tenantID == "" {
		return fmt.Errorf("automation list membership: tenant id required")
	}
	if e == nil || e.Pool == nil {
		return fmt.Errorf("automation list membership: emitter is not configured")
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("automation list membership: marshal: %w", err)
	}
	tx, err := e.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("automation list membership: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("automation list membership: bind tenant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`, tenantID, listMembershipKind, string(payload)); err != nil {
		return fmt.Errorf("automation list membership: enqueue: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("automation list membership: commit: %w", err)
	}
	return nil
}
