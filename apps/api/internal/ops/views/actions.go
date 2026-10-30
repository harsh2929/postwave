package views

// actions.go — the ops console's first mutating lever: the per-tenant send
// kill switch. Unlike the check-bound remediation actions in internal/ops, this
// targets a specific tenant, so it is a distinct (but equally audited) endpoint.
//
// Every mutation: runs on a detached context with a timeout (an operator
// closing the tab must not abort a half-applied pause), is scoped to the TARGET
// tenant by the setter's WithTenant (no RLS bypass — the write reaches exactly
// one tenant's row), carries the operator's identity as the actor, and writes
// an audit_log row through the same platform-operator lane the board uses.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// KillSwitch is the narrow mutation surface. A wrapper over
// tenantcontrols.Repo.SetEmailSendingPaused satisfies it.
type KillSwitch interface {
	SetPaused(ctx context.Context, tenantID string, paused bool, reason, actor string) error
}

// ActionAudit records one operator action. main.go passes the ops AuditSink.
type ActionAudit func(ctx context.Context, event string, fields map[string]any) error

// OperatorResolver returns the authenticated operator's email from the request
// context (ops.OperatorFromContext).
type OperatorResolver func(ctx context.Context) string

type killSwitchBody struct {
	Paused *bool  `json:"paused"`
	Reason string `json:"reason"`
}

// killSwitchTimeout bounds the mutation; detached from the request so a closed
// tab cannot abort a partially-applied change.
const killSwitchTimeout = 30 * time.Second

// KillSwitchHandler serves POST /api/internal/ops/views/tenants/{id}/kill-switch.
// Body: {"paused": bool, "reason": string}. A failed mutation is a loud 500.
func KillSwitchHandler(sw KillSwitch, audit ActionAudit, operator OperatorResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, ok := canonicalUUID(chi.URLParam(r, "id"))
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_tenant_id", "tenant id must be a canonical non-zero UUID")
			return
		}
		var body killSwitchBody
		if !decodeViewJSON(w, r, &body) {
			return
		}
		if body.Paused == nil {
			writeViewError(w, http.StatusBadRequest, "paused_required", "paused must be supplied as a boolean")
			return
		}
		if body.Reason, ok = boundedMultilineText(body.Reason, 4096, 16384); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_reason", "reason must be 1 to 4096 characters")
			return
		}
		actor, ok := resolveOperator(operator, r.Context())
		if !ok {
			writeViewError(w, http.StatusInternalServerError, "operator_missing", "kill-switch endpoint reached without an authenticated operator")
			return
		}

		// Detach + timeout: the mutation must complete (and audit) even if the
		// operator navigates away mid-request.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), killSwitchTimeout)
		defer cancel()

		intent := map[string]any{
			"tenant_id": tenantID, "paused": *body.Paused, "reason": body.Reason, "actor": actor,
		}
		if audit == nil || audit(ctx, "ops.tenant.kill_switch.intent", intent) != nil {
			writeViewError(w, http.StatusServiceUnavailable, "audit_unavailable", "refusing to apply an unauditable kill-switch change")
			return
		}

		if err := sw.SetPaused(ctx, tenantID, *body.Paused, body.Reason, actor); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeViewError(w, http.StatusNotFound, "tenant_not_found", "tenant was not found")
				return
			}
			writeViewError(w, http.StatusInternalServerError, "kill_switch_failed", "kill-switch change failed")
			return
		}
		// Audit is best-effort but happens on the same detached ctx: the action
		// already succeeded; a failed audit is logged, not surfaced as a 500.
		if err := audit(ctx, "ops.tenant.sending_paused", map[string]any{
			"tenant_id": tenantID,
			"paused":    *body.Paused,
			"reason":    body.Reason,
			"actor":     actor,
		}); err != nil {
			slog.Error("ops: kill-switch outcome audit write failed", "tenant_id", tenantID, "err", err)
		}

		writeViewJSON(w, map[string]any{
			"tenant_id": tenantID,
			"paused":    *body.Paused,
			"status":    "applied",
		})
	}
}

// KillSwitchFunc adapts a plain function to the KillSwitch interface, so main.go
// can pass a closure over tenantcontrols.Repo.SetEmailSendingPaused without a
// wrapper type.
type KillSwitchFunc func(ctx context.Context, tenantID string, paused bool, reason, actor string) error

func (f KillSwitchFunc) SetPaused(ctx context.Context, tenantID string, paused bool, reason, actor string) error {
	return f(ctx, tenantID, paused, reason, actor)
}
