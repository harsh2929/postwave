// SPDX-License-Identifier: AGPL-3.0-only
//
// G5 (campaigns 2026): per-recipient send-time optimization (PSTO).
//
// v1 backbone surface: a write endpoint that toggles
// per_recipient_optimize + the window pair on a campaign row. The
// scheduler that materializes per-subscriber rows in
// campaign_recipient_send_at lives in a G5 follow-up (it reads
// send_time_opt.best_send_hour per recipient and stages dispatch
// across the window).
//
// The read shape is already on Campaign — main.go's existing /get
// returns the three new fields automatically because of the json
// struct tags.

package campaigns

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// PSTOInput is the body of PATCH /api/v1/campaigns/{id}/psto.
type PSTOInput struct {
	PerRecipientOptimize bool       `json:"per_recipient_optimize"`
	SendWindowStart      *time.Time `json:"send_window_start"`
	SendWindowEnd        *time.Time `json:"send_window_end"`
}

// MountPSTO wires the toggle endpoint. Admin scope because PSTO
// changes the dispatch timing of a queued campaign — a level above
// regular Update which only edits content.
func MountPSTO(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/campaigns/{id}/psto", d.patchPSTO)
}

func (d *Deps) patchPSTO(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	// Per-subscriber send-time optimisation changes WHEN each recipient gets
	// the campaign, which is part of the send an approver reviewed.
	if d.refuseIfLeaseHeld(w, r, t.ID, id) {
		return
	}
	var in PSTOInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.
			// Raw json decoder text may include offsets/internals — route through
			// WriteInternal-style logging without echoing. Operator-safe code only.
			WriteError(w, err)
		return

	}
	if in.PerRecipientOptimize {
		if in.SendWindowStart == nil || in.SendWindowEnd == nil {
			writeJSON(w, http.StatusBadRequest, errEnv("missing_window",
				"send_window_start and send_window_end are required when per_recipient_optimize is true"))
			return
		}
		if !in.SendWindowEnd.After(*in.SendWindowStart) {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_window",
				"send_window_end must be after send_window_start"))
			return
		}
		// Floor the window at 1 hour. Below that PSTO is meaningless —
		// best_send_hour is hour-granular, so a sub-hour window collapses
		// to a single hour and behaves like a normal scheduled send while
		// still paying the materialization cost.
		if in.SendWindowEnd.Sub(*in.SendWindowStart) < time.Hour {
			writeJSON(w, http.StatusBadRequest, errEnv("window_too_short",
				"send window must be at least 1 hour"))
			return
		}
		// Cap the window at 30 days. Klaviyo caps 24h, AC caps 7d; we go
		// wider so "send during waking hours over 3 weeks" works, but
		// not so wide that the partial index on
		// campaign_recipient_send_at swells unboundedly.
		if in.SendWindowEnd.Sub(*in.SendWindowStart) > 30*24*time.Hour {
			writeJSON(w, http.StatusBadRequest, errEnv("window_too_long",
				"send window must be 30 days or shorter"))
			return
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	res, err := tx.Exec(r.Context(), `
UPDATE campaigns
   SET per_recipient_optimize = $2,
       send_window_start      = $3,
       send_window_end        = $4,
       updated_at             = now()
 WHERE id = $1::uuid`,
		id, in.PerRecipientOptimize, in.SendWindowStart, in.SendWindowEnd)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if res.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
		return
	}
	// Audit the dispatch-timing change within the same tx so the row is
	// only visible if the UPDATE commits. PSTO changes WHEN a queued
	// campaign reaches recipients, so it belongs in the compliance trail
	// alongside schedule/approve actions.
	_ = db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"campaign.scheduled.personalized", "campaign", id, map[string]any{
			"per_recipient_optimize": in.PerRecipientOptimize,
			"send_window_start":      in.SendWindowStart,
			"send_window_end":        in.SendWindowEnd,
		})
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Reload + return the updated campaign so the desktop can rebind
	// without a second roundtrip.
	c, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, c)
}
