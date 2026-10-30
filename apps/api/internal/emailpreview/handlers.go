// SPDX-License-Identifier: AGPL-3.0-only
package emailpreview

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"io"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the handler so main.go can register it with one struct
// literal.
type Deps struct {
	Logger *slog.Logger
	// Engine, when non-nil, renders plain-HTML input through the
	// Listmonk-fork engine's template preview endpoint — the same
	// renderer campaign sends use (A31). Nil keeps the local pipeline
	// only; the response then labels plain-HTML previews "fallback".
	Engine *EngineRenderer
	// Quota, when set, meters render-previews against the tenant's
	// deliverability entitlement. nil ⇒ unmetered (current behaviour).
	Quota QuotaMeter
}

// QuotaMeter consumes one unit of a metered deliverability resource for a
// tenant. allowed=false means the quota is exhausted (the caller should reply
// 402); a non-nil err is the caller's cue to fail open.
type QuotaMeter interface {
	// Consume takes one unit. On refusal (allowed=false) it also returns the
	// ceiling the refusal was MEASURED AGAINST, read in the same transaction
	// that made the decision.
	//
	// Same transaction on purpose. Reading the allowance afterwards produced
	// denials that contradicted themselves: an admin raising the limit in
	// between yielded "monthly quota exhausted" reporting 1 of 10 used — and an
	// admin PUT is the very remedy such a denial names.
	//
	// A nil ceiling means the numbers are unknown (ungated tenant, or the read
	// failed). Callers must omit limit/current entirely rather than send a
	// sentinel.
	Consume(ctx context.Context, tenantID, resource string) (remaining int, allowed bool, ceiling *deliverability_control.Ceiling, err error)
}

// maxBodyBytes mirrors the package-private maxMJMLBytes. We re-enforce
// it at the HTTP layer with http.MaxBytesReader so a hostile client
// can't stream gigabytes through us before we notice.
const maxBodyBytes = 1 << 20 // 1 MiB

// renderRequest is the JSON shape of POST /api/v1/email-preview/render.
type renderRequest struct {
	MJML string            `json:"mjml"`
	Vars map[string]string `json:"vars"`
}

// renderResponse is what we send back. Previews are keyed by client id
// so the React client doesn't have to know struct field names.
// Renderer is "mjml" | "engine" | "fallback" — "fallback" means the
// pass-through stub produced the base HTML and the client should label
// the preview as approximate (A31).
type renderResponse struct {
	Previews map[string]string `json:"previews"`
	Warnings []string          `json:"warnings"`
	Renderer string            `json:"renderer"`
}

// Render handles POST /api/v1/email-preview/render. Tenant-scoped: we
// enforce the tenant context but don't actually use the tenant id —
// rendering is pure compute. The check is present to make sure the
// endpoint stays behind the same auth layer as everything else.
func (d *Deps) Render(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in renderRequest
	if err := httpbody.DecodeJSON(w, r, maxBodyBytes, &in); err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeJSONErr(w, http.StatusRequestEntityTooLarge,
				"payload_too_large", "MJML body must be under 1 MiB")
			return
		}
		if errors.Is(err, io.EOF) {
			writeJSONErr(w, http.StatusBadRequest, "empty_body", "request body is empty")
			return
		}
		httperror.WriteValidation(w, "bad_json", httpbody.PublicMessage(err))
		return
	}

	// Metered AFTER the body is parsed, deliberately.
	//
	// It used to consume a unit first. A malformed or oversized request then
	// burned an allowance unit and returned 400/413 having rendered nothing, so
	// 500 bad requests could exhaust a 500-preview month and the 501st good one
	// was told "monthly render-preview quota exhausted" — a denial whose own
	// message was untrue. Metering after the parse means a unit is only spent on
	// a request that could actually produce a render.
	// Fail open on a metering error so a transient DB hiccup cannot block a
	// paid feature.
	if d.Quota != nil {
		if _, allowed, ceiling, err := d.Quota.Consume(r.Context(), t.ID, "render_previews"); err != nil {
			if d.Logger != nil {
				d.Logger.Warn("emailpreview: quota meter error; allowing", "tenant_id", t.ID, "err", err.Error())
			}
		} else if !allowed {
			denial := entitlement.Denial{
				Subject:  "render_previews",
				Reason:   entitlement.ReasonPlan,
				Resource: "render_previews",
				// A distinct code, NOT plan_limit_exceeded. Nothing in this repo
				// raises these ceilings on a plan change — the only writer of
				// `deliverability_entitlements` limits is the tenant-admin PUT —
				// and reusing the plan-ceiling code routed the denial into
				// apps/web's "Upgrade your plan" copy, so the server withheld the
				// upgrade claim while the client asserted it from the code string.
				Code:    "deliverability_allowance_exhausted",
				Message: "monthly render-preview quota exhausted",
				Remedy:  entitlement.RemedyContactWorkspaceAdmin,
			}
			// The numbers ONLY when the refusal actually measured them. A nil
			// ceiling means ungated or unreadable, and a sentinel would be worse
			// than omission: `-1` is a number to a client, and `limit - current`
			// renders it as a plausible zero.
			if ceiling != nil {
				limit, current := int64(ceiling.Limit), int64(ceiling.Used)
				denial.Limit, denial.Current, denial.Tier = &limit, &current, ceiling.Tier
			}
			entitlement.Write(w, denial)
			return
		}
	}

	preview, err := BuildPreviewWithEngine(r.Context(), d.Engine, in.MJML, in.Vars)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
		// BuildPreview can wrap MJML CLI stderr/exec errors that we don't
		// want echoed to clients. Route through WriteInternal so the raw
		// text is logged but the response stays the generic envelope.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, renderResponse{
		Previews: map[string]string{
			"gmail":   preview.GmailHTML,
			"outlook": preview.OutlookHTML,
			"apple":   preview.AppleHTML,
			"dark":    preview.DarkHTML,
		},
		Warnings: preview.Warnings,
		Renderer: preview.Renderer,
	})
}

// writeJSON / writeJSONErr — same shape as the rest of the API gateway.
// Defined locally because the helpers in apps/api/internal/handlers are
// package-private and we don't want to import that package (it would
// pull in a dozen unrelated deps).
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
