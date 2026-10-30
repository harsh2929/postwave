// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

// callerFromCtx builds the agenttools.Caller for a native MCP request from
// the context the apikeys middleware populated. Scopes are NOT copied here
// — agenttools reads them from ctx so there is one authorization source.
// The sandbox flag is read from ctx (not reconstructed) so a sandbox-only
// key always simulates writes.
func callerFromCtx(ctx context.Context) agenttools.Caller {
	c := agenttools.Caller{
		Surface:   agenttools.SurfaceMCP,
		LLMFacing: true,
		Sandbox:   sandbox.IsFlagged(ctx),
		APIKeyID:  middleware.APIKeyIDFromContext(ctx),
	}
	if t, ok := middleware.TenantFromContext(ctx); ok && t != nil {
		c.TenantID = t.ID
	}
	c.ActorType, c.ActorLabel = middleware.ActorFromContext(ctx)
	return c
}

// governor returns the injected governance adapter. A nil value stays nil so
// agenttools.Execute can fail closed for LLM-facing reads; it must never be
// replaced with a permissive no-op. The full adapter is injected by main.go.
// The
// mcp_server_call_log dashboard row is written by handleToolsCall itself
// regardless of governor, so the dashboard never depends on injection.
func (d *Deps) governor() agenttools.Governor {
	return d.Gov
}

// callLogOutcome maps the richer agenttools.Outcome onto the legacy
// mcp_server_call_log vocabulary (ok | denied | error) so existing
// dashboard aggregations stay stable. Per-tool granular outcomes are
// captured separately by the full governor's audit_log emission.
func callLogOutcome(o agenttools.Outcome) string {
	switch o {
	case agenttools.OutcomeOK, agenttools.OutcomeSandboxed:
		return "ok"
	case agenttools.OutcomeDenied, agenttools.OutcomePending:
		return "denied"
	default: // error, canceled
		return "error"
	}
}

// writeToolCallResult maps an agenttools.Execute outcome to the MCP wire
// frame. Governance policy denials (scope/quota/budget) and protocol
// errors (unknown tool) become JSON-RPC error frames; handler/infra
// errors become a tool result with isError=true so the model can read and
// recover; success / sandbox-simulation / approval-pending are normal
// result frames carrying the payload as both text and structuredContent.
func (d *Deps) writeToolCallResult(w http.ResponseWriter, req *rpcRequest, res *agenttools.Result, err error) {
	if err != nil {
		switch {
		case errors.Is(err, agenttools.ErrScopeDenied):
			var se *agenttools.ScopeError
			var data any
			if errors.As(err, &se) {
				data = se.MissingScopeStrings()
			}
			writeRPCError(w, req.ID, errScopeDenied,
				"the bearer token is missing the required scopes for this tool", data)
		case errors.Is(err, agenttools.ErrQuotaExceeded):
			writeRPCError(w, req.ID, errQuotaExceeded, "per-tool call quota exceeded", nil)
		case errors.Is(err, agenttools.ErrBudgetExceeded):
			writeRPCError(w, req.ID, errBudgetExceeded, "the API key's send budget is exhausted", nil)
		case errors.Is(err, agenttools.ErrMandateDenied):
			writeRPCError(w, req.ID, errScopeDenied, "the caller's mandate does not authorize this tool", nil)
		case errors.Is(err, agenttools.ErrWriteTierReleaseHeld):
			writeRPCError(w, req.ID, errWriteTierHeld,
				"write-capable agent tools are release-held pending durable mutation and governance coupling",
				map[string]string{"code": agenttools.WriteTierReleaseHoldCode})
		case errors.Is(err, agenttools.ErrLLMDataEgressReleaseHeld):
			writeRPCError(w, req.ID, errScopeDenied,
				"tool output is not yet approved for model context",
				map[string]string{"code": agenttools.LLMDataEgressReleaseHoldCode})
		case errors.Is(err, agenttools.ErrInvalidArguments):
			var validation *agenttools.ArgumentValidationError
			data := map[string]string{"code": "invalid_tool_arguments"}
			if errors.As(err, &validation) {
				data["path"] = validation.Path
				data["reason"] = validation.Reason
			}
			writeRPCError(w, req.ID, errInvalidParams, "tool arguments failed inputSchema validation", data)
		case errors.Is(err, agenttools.ErrUnknownTool):
			writeRPCError(w, req.ID, errMethodNotFound, "unknown tool", nil)
		case errors.Is(err, agenttools.ErrInternal),
			errors.Is(err, agenttools.ErrScrubFailed),
			errors.Is(err, agenttools.ErrNoTenant),
			errors.Is(err, context.Canceled),
			errors.Is(err, context.DeadlineExceeded):
			// Infrastructure failure (a governance lookup, PII scrub, or
			// cancellation). Do NOT leak raw internal detail to the model:
			// log it server-side and return a generic frame.
			toolName := ""
			if res != nil && res.Tool != nil {
				toolName = res.Tool.Name
			}
			slog.Warn("mcp: tool internal error", "tool", toolName, "class", "internal_error")
			writeRPCError(w, req.ID, errInternalError,
				"the tool could not be executed due to an internal error", nil)
		default:
			// Defense in depth: even if a future executor returns an unclassified
			// handler/provider error, never put its arbitrary text in model context.
			toolName := ""
			if res != nil && res.Tool != nil {
				toolName = res.Tool.Name
			}
			slog.Warn("mcp: unclassified tool error", "tool", toolName, "class", "internal_error")
			writeRPCError(w, req.ID, errInternalError,
				"the tool could not be executed due to an internal error", nil)
		}
		return
	}

	payload := res.Payload
	if res.IsPending() {
		payload = map[string]any{
			"status":       "approval_required",
			"approval_ref": res.ApprovalRef,
			"message":      "this action was queued for human approval and has not run yet",
		}
	}
	textBytes, mErr := json.Marshal(payload)
	if mErr != nil {
		writeRPCError(w, req.ID, errInternalError, "failed to encode tool result", nil)
		return
	}
	writeRPCResult(w, req.ID, toolCallResult{
		Content:           []contentBlock{{Type: "text", Text: string(textBytes)}},
		StructuredContent: payload,
	})
}
