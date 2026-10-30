// SPDX-License-Identifier: AGPL-3.0-only
//
// Package onboarding_progress surfaces "how far through tenant
// setup are we?" as a live N-of-M checklist. The numbers come
// from SELECTs across the existing tables — there's no progress
// state to maintain because every step's done-ness is implied by
// whether a row exists.
//
// Steps surfaced (the canonical first-week-of-ESP-setup list):
//
//   1.  verified_sending_identity     ≥1 sending_identity verify_state='verified'
//   2.  configured_dkim_dmarc         same row has dmarc_verified_at + dkim_verified_at
//   3.  created_subscriber            ≥1 subscriber row
//   4.  uploaded_subscribers_bulk     ≥1 subscriber_import that finished ('ready')
//                                     and wrote at least one contact
//   5.  designed_first_campaign       ≥1 campaign row (any status)
//   6.  sent_first_campaign           ≥1 real recipient send in our delivery ledger
//   7.  created_signup_form           ≥1 forms row
//   8.  configured_unsubscribe_brand  ≥1 custom_domain row
//   9.  invited_team_member           ≥2 user rows
//   10. connected_product_events      ≥1 product_events row (added 2026-05-27 so
//                                     the desktop OnboardingChecklist's
//                                     "connect-events" step has a server fact)
//
// Surfaces:
//
//   GET /api/v1/onboarding-progress
//
// Returns total + completed count + per-step status. The
// front-end uses the percentage as the "complete your setup"
// progress bar; the per-step rows drive the actionable checklist.

package onboarding_progress

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// Step is one row of the checklist.
type Step struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Completed   bool   `json:"completed"`
}

type stepDef struct {
	key         string
	label       string
	description string
	check       string // SQL fragment: must SELECT EXISTS(...) AS bool
}

// canonical checklist. The SQL fragments are tenant-scoped at the
// callsite via `$1` placeholder.
var checklist = []stepDef{
	{
		key:         "verified_sending_identity",
		label:       "Verify a sending domain",
		description: "Add the DKIM/SPF/DMARC records at your registrar and run the verifier.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM sending_identities
		   WHERE tenant_id = $1::uuid AND verify_state = 'verified')`,
	},
	{
		key:         "configured_dkim_dmarc",
		label:       "DKIM + DMARC fully resolved",
		description: "Both DKIM and DMARC records are passing the periodic re-verifier.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM sending_identities
		   WHERE tenant_id = $1::uuid
		     AND dkim_verified_at IS NOT NULL
		     AND dmarc_verified_at IS NOT NULL)`,
	},
	{
		key:         "created_subscriber",
		label:       "Add a subscriber",
		description: "At least one subscriber row exists (via the API, a form, or an import).",
		check: `SELECT EXISTS (
		  SELECT 1 FROM subscribers WHERE tenant_id = $1::uuid)`,
	},
	{
		key:         "uploaded_subscribers_bulk",
		label:       "Bulk-import subscribers from CSV",
		description: "Imports unlock the bulk operations + dedupe affordances.",
		// 'ready' is the worker's only successful terminal status
		// (subscriber_import finalizeClaim; subscriber_imports_status_check).
		// A ready import that wrote nothing — every row skipped or failed —
		// has not bulk-imported anyone yet.
		check: `SELECT EXISTS (
		  SELECT 1 FROM subscriber_imports
		   WHERE tenant_id = $1::uuid AND status = 'ready' AND rows_imported > 0)`,
	},
	{
		key:         "designed_first_campaign",
		label:       "Design your first campaign",
		description: "A draft is enough — you can preview without sending.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid)`,
	},
	{
		key:         "sent_first_campaign",
		label:       "Send your first campaign",
		description: "Crosses the line from setup to operating.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM campaign_recipients recipient
		  JOIN campaigns campaign
		    ON campaign.id = recipient.campaign_id
		   AND campaign.tenant_id = recipient.tenant_id
		 WHERE recipient.tenant_id = $1::uuid
		   AND recipient.status = 'sent'
		   AND recipient.sent_at IS NOT NULL
		   AND campaign.is_sandbox IS NOT TRUE)`,
	},
	{
		key:         "created_signup_form",
		label:       "Publish a signup form",
		description: "Embeddable form unlocks the growth-source attribution + double-opt-in flow.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM forms WHERE tenant_id = $1::uuid)`,
	},
	{
		key:         "configured_unsubscribe_brand",
		label:       "Configure your branded sending domain",
		description: "Custom domain for tracking + unsubscribe links so they don't read 'moosewave.com'.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM custom_domains WHERE tenant_id = $1::uuid)`,
	},
	{
		key:         "invited_team_member",
		label:       "Invite a teammate",
		description: "Multi-operator access is a 30-second action that saves a 'who has the password' incident later.",
		check: `SELECT EXISTS (
		  SELECT count(*) FROM users WHERE tenant_id = $1::uuid HAVING count(*) >= 2)`,
	},
	{
		key:         "connected_product_events",
		label:       "Connect product events",
		description: "POST events from your app to /api/v1/track so sequences can react to behaviour, not just to email engagement.",
		check: `SELECT EXISTS (
		  SELECT 1 FROM product_events WHERE tenant_id = $1::uuid)`,
	},
}

// MountRoutes registers the read endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/onboarding-progress", d.Get)
	// The DECISIONS half. Done-ness above is derived and already shared; these
	// were per-device localStorage keys, so the product re-asked on every device
	// until answered on every device.
	r.With(read).Get("/api/v1/onboarding/steps", d.GetStepStates)
	// Writing a decision needs write authority: mounting the PUT under the same
	// read scope as its GET let a read-only key record dismissals and skips, and
	// a read scope must never carry a write.
	//
	// ScopeWriteCampaigns rather than ScopeAdmin, following the repo's existing
	// self-write precedent (PUT /api/v1/me/prefs/subscribers_view pairs a read
	// scope on the GET with the matching write scope on the PUT). Admin would be
	// wrong in the other direction: these are one person's own choices, scoped to
	// (tenant, user, step) precisely so one admin cannot answer for a colleague —
	// requiring admin to record them would contradict that. write:campaigns is
	// the editor tier, and the onboarding steps are campaign and audience setup.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Put("/api/v1/onboarding/steps", d.PutStepState)
}

// Get GET /api/v1/onboarding-progress.
//
// Single round-trip: every step's done-ness in one SELECT via
// EXISTS subqueries unioned across the checklist.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	steps := make([]Step, len(checklist))
	for i, s := range checklist {
		steps[i] = Step{
			Key:         s.key,
			Label:       s.label,
			Description: s.description,
			Completed:   safeCheck(r.Context(), tx, s.check, t.ID),
		}
	}
	done := 0
	for _, s := range steps {
		if s.Completed {
			done++
		}
	}
	total := len(steps)
	pct := 0
	if total > 0 {
		pct = (done * 100) / total
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"steps":     steps,
		"completed": done,
		"total":     total,
		"percent":   pct,
		"all_done":  done == total,
	})
}

// safeCheck runs one EXISTS-style probe and treats any error
// (table missing in older deploys, RLS edge case) as "not done"
// rather than failing the whole endpoint.
//
// Every probe shares one transaction, and PostgreSQL aborts a transaction on
// its first error: without the savepoint, one failing probe would report every
// later step as "not done" too.
func safeCheck(ctx context.Context, tx pgx.Tx, query, tenantID string) bool {
	probe, err := tx.Begin(ctx)
	if err != nil {
		return false
	}
	defer func() { _ = probe.Rollback(ctx) }()
	var done bool
	if err := probe.QueryRow(ctx, query, tenantID).Scan(&done); err != nil {
		return false
	}
	return done
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

var _ = errors.New

// stepState is one person's decision about one onboarding step.
type stepState struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

// validStepStates is a CLOSED vocabulary.
//
// Closed so a client cannot invent a state the other two surfaces will not
// understand — which is how one shared fact becomes three again. `dismissed`
// and `snoozed` are "not now"; `skipped` and `inapplicable` are "not us";
// `delegated` is "someone else is doing this". Only the second pair should stay
// gone, which is why they are distinguishable at all.
var validStepStates = map[string]bool{
	"dismissed":    true,
	"snoozed":      true,
	"skipped":      true,
	"inapplicable": true,
	"delegated":    true,
}

// GetStepStates GET /api/v1/onboarding/steps.
//
// The decisions this USER has made. Done-ness is not here: it stays derived by
// Get above, because a stored copy would drift the moment someone deleted the
// thing that completed the step.
func (d *Deps) GetStepStates(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u.ID == "" {
		writeErr(w, http.StatusUnauthorized, "no_user", "an authenticated user is required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT step_key, state, COALESCE(reason, '')
  FROM onboarding_step_state
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t.ID, u.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	steps := map[string]stepState{}
	for rows.Next() {
		var key string
		var st stepState
		if err := rows.Scan(&key, &st.State, &st.Reason); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		steps[key] = st
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"steps": steps})
}

// PutStepState PUT /api/v1/onboarding/steps.
//
// Upsert, because a decision is idempotent: dismissing an already-dismissed step
// is not an error, and a client retrying on a flaky connection must not fail.
func (d *Deps) PutStepState(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u.ID == "" {
		writeErr(w, http.StatusUnauthorized, "no_user", "an authenticated user is required")
		return
	}
	var in struct {
		StepKey string `json:"step_key"`
		State   string `json:"state"`
		Reason  string `json:"reason,omitempty"`
	}
	// io.LimitReader TRUNCATES rather than refusing: it hands the decoder the
	// first 8 KiB of an over-size body and says nothing, so the caller is told
	// "request body is not valid JSON" about a body whose JSON was fine and
	// merely long. That is a diagnosis pointing at the wrong thing, and it is
	// the reason httpbody exists — it distinguishes "malformed" from "too
	// large" and answers 413 with the limit for the second.
	if err := httpbody.DecodeJSON(w, r, 8<<10, &in); err != nil {
		writeErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.StepKey = strings.TrimSpace(in.StepKey)
	in.State = strings.TrimSpace(in.State)
	if in.StepKey == "" {
		writeErr(w, http.StatusBadRequest, "invalid_step", "step_key is required")
		return
	}
	if !validStepStates[in.State] {
		writeErr(w, http.StatusBadRequest, "invalid_state",
			"state must be one of dismissed, snoozed, skipped, inapplicable, delegated")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `
INSERT INTO onboarding_step_state (tenant_id, user_id, step_key, state, reason, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), now())
ON CONFLICT (tenant_id, user_id, step_key)
  DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, updated_at = now()`,
		t.ID, u.ID, in.StepKey, in.State, in.Reason); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
