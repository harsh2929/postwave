// SPDX-License-Identifier: AGPL-3.0-only
//
// Package resend_unopened implements the "resend this campaign to
// recipients who didn't open it" operator action — a near-universal
// ESP affordance that typically lifts an additional 5-15% open
// rate from already-paid-for traffic.
//
// Flow:
//
//   1. The operator picks an original campaign + a new subject
//      line (the same subject reaching the same inbox a week later
//      reliably underperforms; the resend MUST swap subject).
//   2. We count the unopened recipients: every subscriber that
//      received a subscriber_event for the original but never
//      generated an 'opened' event (and isn't bounced/unsubscribed).
//      Computed in-DB as a COUNT — the list itself is not
//      materialized (it would be up to millions of rows).
//   3. We clone the original campaign as a new draft, swap the
//      subject, and stamp a `resend_of=<original_id>` tag in the
//      campaign's tracking_settings JSONB for attribution.
//
// NOTE: this endpoint is clone-only. It never inserts campaign_recipients or
// changes the clone to a dispatching state. The caller must freeze/review the
// clone's intended non-opener audience, run clone-scoped Campaign Assurance,
// and use the canonical /queue endpoint. This explicit contract prevents a
// convenience action from becoming a second send authority.
//
// Surface:
//
//   POST /api/v1/campaigns/{id}/resend-unopened
//        body: {subject, name?, send_after_hours?}

package resend_unopened

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
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 4 << 10

// MinHoursBetweenSends is the cooling-off period: 24h is the
// industry-standard minimum so the resend doesn't arrive in the
// same Gmail/Outlook conversation thread as the original.
const MinHoursBetweenSends = 24

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// LiveDispatch is shared with the canonical campaign queue. nil is closed.
	LiveDispatch dispatchcontrol.Gate
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Nil-safe at the call site.
	Logger *slog.Logger
}

type resendReq struct {
	Subject        string `json:"subject"`
	Name           string `json:"name"`
	SendAfterHours int    `json:"send_after_hours"`
}

// MountRoutes registers the resend endpoint. Creating a resend lifecycle needs
// both campaign-authoring and transactional-send authority.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	live := apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)
	r.With(live).Post("/api/v1/campaigns/{id}/resend-unopened", d.Resend)
}

// Resend POST /api/v1/campaigns/{id}/resend-unopened.
func (d *Deps) Resend(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if err := dispatchcontrol.Check(d.LiveDispatch, r.Context(), t.ID); err != nil {
		dispatchcontrol.WriteHTTPError(w, err)
		return
	}
	srcID := chi.URLParam(r, "id")
	if srcID == "" {
		httperror.WriteValidation(w, "missing_id", "")
		return
	}
	var body resendReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		code := httpbody.ErrorCode(err)
		status := httpbody.StatusCode(err)
		if status >= 500 {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		httperror.Write(w, status, code, httpbody.PublicMessage(err))
		return
	}
	newSubject := strings.TrimSpace(body.Subject)
	if newSubject == "" {
		httperror.WriteValidation(w, "missing_subject", "a fresh subject line is required for resends")
		return
	}
	hours := body.SendAfterHours
	if hours < MinHoursBetweenSends {
		hours = MinHoursBetweenSends
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Verify source exists and the subject we're using differs.
	var srcName, srcSubject string
	if err := tx.QueryRow(r.Context(),
		`SELECT name, subject FROM campaigns
		  WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		srcID, t.ID).Scan(&srcName, &srcSubject); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if strings.EqualFold(strings.TrimSpace(newSubject), strings.TrimSpace(srcSubject)) {
		httperror.WriteValidation(w, "duplicate_subject",
			"resend subject must differ from the original")
		return
	}

	// Count the unopened recipients (computed in-DB; the full list is never
	// read back, so we never materialize it).
	audienceSize, err := countUnopenedRecipients(r.Context(), tx, t.ID, srcID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if audienceSize == 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "no_unopened",
			"every recipient of the original opened it")
		return
	}

	// Clone via INSERT SELECT, override subject/name/audience.
	cols, err := cloneableColumns(r.Context(), tx)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	quoted := make([]string, 0, len(cols))
	for _, c := range cols {
		quoted = append(quoted, `"`+c+`"`)
	}
	colList := strings.Join(quoted, ", ")

	newName := strings.TrimSpace(body.Name)
	if newName == "" {
		newName = "Resend: " + srcName
	}

	var newID string
	if err := tx.QueryRow(r.Context(), `
INSERT INTO campaigns (
  id, tenant_id, name, subject, status, scheduled_at, sent_at,
  created_at, updated_at,
  `+colList+`
)
SELECT gen_random_uuid(), tenant_id, $3, $4, 'draft', NULL, NULL,
       now(), now(),
       `+colList+`
  FROM campaigns WHERE id = $1::uuid AND tenant_id = $2::uuid
RETURNING id::text`, srcID, t.ID, newName, newSubject).Scan(&newID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Stamp the lineage in tracking_settings so analytics can credit
	// the resend back to the original. Best-effort: column may be
	// absent in older deploys.
	_, _ = tx.Exec(r.Context(), `
UPDATE campaigns
   SET tracking_settings = COALESCE(tracking_settings, '{}'::jsonb)
                         || jsonb_build_object('resend_of', $2::text)
 WHERE id = $1::uuid`, newID, srcID)

	// Reset archive flags if they exist.
	_, _ = tx.Exec(r.Context(),
		`UPDATE campaigns SET archive_public = false, archive_slug = NULL, archive_excerpt = NULL WHERE id = $1::uuid`, newID)

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                 newID,
		"name":               newName,
		"subject":            newSubject,
		"status":             "draft",
		"original_id":        srcID,
		"audience_size":      audienceSize,
		"send_after_hours":   hours,
		"assurance_required": true,
		"next_action":        "freeze_non_opener_audience_then_run_campaign_assurance_and_queue",
		"queue_path":         "/api/v1/campaigns/" + newID + "/queue",
	})
}

// countUnopenedRecipients returns how many subscriber_emails received any
// event for the original campaign except an 'opened' (and excluding
// bounced/complained/unsubscribed).
//
// Definition of "received" here is operationally broad: any subscriber that
// triggered ANY event ('opened', 'clicked', 'bounced', etc.) for the
// campaign. Subscribers who generated zero events (likely Apple-MPP
// blockers) are excluded — we can't tell whether they received.
//
// This used to materialize the full email list into a Go slice (capped at
// a 1M LIMIT) AND persist it as a jsonb array in tracking_settings. The
// list was never read back anywhere, so we now compute only the COUNT in
// the database — bounded memory regardless of audience size.
func countUnopenedRecipients(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
WITH any_event AS (
  SELECT DISTINCT subscriber_email
    FROM subscriber_events
   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
), opened AS (
  SELECT DISTINCT subscriber_email
    FROM subscriber_events
   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
     AND event_type = 'opened'
), bounced AS (
  SELECT DISTINCT subscriber_email
    FROM subscriber_events
   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
     AND event_type IN ('bounced','complained','unsubscribed')
)
SELECT count(*)::int
  FROM any_event
 WHERE subscriber_email NOT IN (SELECT subscriber_email FROM opened)
   AND subscriber_email NOT IN (SELECT subscriber_email FROM bounced)`,
		tenantID, campaignID).Scan(&n)
	return n, err
}

// Columns the clone must NOT carry over from its source, either because the
// INSERT sets them explicitly or because they are facts about the SOURCE's
// dispatch that a brand-new draft has no claim to.
//
// started_at and finished_at are the second kind. Campaigns.Repo.Update freezes
// delivered content once started_at is set — a clone that inherited its parent's
// start instant would be born un-editable, so "duplicate this and fix the typo"
// would produce a campaign that refuses the fix. Excluding them here leaves the
// columns at their NULL default, which is also simply true: this campaign has
// not started.
var explicitlySetColumns = map[string]struct{}{
	"id":           {},
	"tenant_id":    {},
	"name":         {},
	"subject":      {},
	"status":       {},
	"scheduled_at": {},
	"sent_at":      {},
	"created_at":   {},
	"updated_at":   {},
	"started_at":   {},
	"finished_at":  {},
}

func cloneableColumns(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'campaigns'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			continue
		}
		if _, skip := explicitlySetColumns[c]; skip {
			continue
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
