package subscribers

// SUB-067 — Pre-send Audience Refine / Optimization.
//
// Before a campaign goes out, the PreSendRefiner suppresses likely-
// unsubscribers at send time and gives them a cooling-off window instead of
// another email that pushes them to churn. The gate reads each subscriber's
// cached churn_score (subscribers.churn_score, migration 0180, recomputed
// every 6h by the subscriberscore package): subscribers at or above an
// operator-configurable threshold (default 80/100) are temporarily excluded
// from THIS campaign's send and an exclusion row is recorded in
// subscriber_send_exclusions (migration 0948) with an expires_at cooling-off
// re-entry instant. Rows past expires_at are inactive, so the subscriber
// automatically re-enters the eligible pool — the same cooling-off re-entry
// pattern resend_unopened.go uses.
//
// Wire surface (campaign-scoped, mounted via subscriberDeps):
//
//	POST   /api/v1/campaigns/{id}/presend-refine   write — preview+commit gate
//	GET    /api/v1/campaigns/{id}/presend-refine   read  — current active set
//	DELETE /api/v1/campaigns/{id}/presend-refine   write — clear (force re-entry)
//
// The POST is preview-AND-commit: it computes the exclusion set and persists
// it so the send path can read it back. Pass {"dry_run": true} to preview the
// counts + sample WITHOUT writing exclusion rows (the Compose checklist UI
// uses this).

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Pre-send refine defaults.
const (
	// DefaultChurnThreshold is the churn_score (0..100) at/above which a
	// subscriber is excluded from a send by default.
	DefaultChurnThreshold = 80
	// DefaultCoolingOffHours is the re-entry window: an excluded subscriber
	// auto-re-enters the eligible pool this many hours after the exclusion.
	DefaultCoolingOffHours = 24
	// presendSampleCap bounds the affected-subscribers sample returned in the
	// preview so a 5M-row tenant doesn't ship a giant body.
	presendSampleCap = 25
)

// RefineForSend computes the churn-risk exclusion set for a campaign and
// (unless DryRun) persists it to subscriber_send_exclusions with a cooling-off
// expires_at. Returns the preview summary the Compose checklist + send path
// read. Runs in one tenant-scoped tx so a partial commit never lands.
func (r *Repo) RefineForSend(ctx context.Context, tenantID, campaignID string, in PreSendRefineInput) (*PreSendRefineResult, error) {
	threshold := in.ChurnThreshold
	if threshold == 0 {
		threshold = DefaultChurnThreshold
	}
	if threshold < 0 || threshold > 100 {
		return nil, fmt.Errorf("%w: churn_threshold must be in [0,100]", ErrInvalidInput)
	}
	coolingHours := in.CoolingOffHours
	if coolingHours == 0 {
		coolingHours = DefaultCoolingOffHours
	}
	if coolingHours < 0 {
		return nil, fmt.Errorf("%w: cooling_off_hours must be >= 0", ErrInvalidInput)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Candidates: enabled, non-archived subscribers at/above the churn
	// threshold. exclude_recently_paused additionally drops those already
	// holding an unexpired exclusion (any campaign) so a recently-cooled
	// subscriber isn't immediately re-mailed under a different campaign.
	q := `
SELECT s.id::text, COALESCE(s.email::text,''), COALESCE(s.churn_score,0)
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid
   AND s.status = 'enabled' AND s.archived_at IS NULL
   AND COALESCE(s.churn_score,0) >= $2`
	queryArgs := []any{tenantID, threshold}
	if in.ExcludeRecentlyPaused {
		q += `
   AND NOT EXISTS (
     SELECT 1 FROM subscriber_send_exclusions e
      WHERE e.tenant_id = s.tenant_id AND e.subscriber_id = s.id
        AND e.campaign_id <> $3::uuid
        AND (e.expires_at IS NULL OR e.expires_at > now()))`
		queryArgs = append(queryArgs, campaignID)
	}
	q += `
 ORDER BY s.churn_score DESC`

	rows, err := tx.Query(ctx, q, queryArgs...)
	if err != nil {
		return nil, err
	}
	type cand struct {
		id    string
		email string
		churn int
	}
	cands := []cand{}
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.email, &c.churn); err != nil {
			rows.Close()
			return nil, err
		}
		cands = append(cands, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	var expiresAt *time.Time
	if coolingHours > 0 {
		e := time.Now().UTC().Add(time.Duration(coolingHours) * time.Hour)
		expiresAt = &e
	}

	sample := make([]PreSendExcludedSubscriber, 0, presendSampleCap)
	coolingOffCount := 0
	for _, c := range cands {
		if expiresAt != nil {
			coolingOffCount++
		}
		if len(sample) < presendSampleCap {
			sample = append(sample, PreSendExcludedSubscriber{
				SubscriberID: c.id,
				Email:        c.email,
				ChurnScore:   c.churn,
				Reason:       "churn_risk",
			})
		}
		if in.DryRun {
			continue
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_send_exclusions
  (tenant_id, subscriber_id, campaign_id, reason, churn_score_at_exclusion, expires_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'churn_risk', $4, $5)
ON CONFLICT (tenant_id, subscriber_id, campaign_id) DO UPDATE
   SET reason                   = 'churn_risk',
       churn_score_at_exclusion = EXCLUDED.churn_score_at_exclusion,
       expires_at               = EXCLUDED.expires_at`,
			tenantID, c.id, campaignID, c.churn, expiresAt); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	res := &PreSendRefineResult{
		CampaignID:            campaignID,
		ChurnThreshold:        threshold,
		CoolingOffHours:       coolingHours,
		ExcludedCount:         len(cands),
		CoolingOffCount:       coolingOffCount,
		DryRun:                in.DryRun,
		AffectedSample:        sample,
		ExcludeRecentlyPaused: in.ExcludeRecentlyPaused,
	}
	if expiresAt != nil {
		res.CoolingOffUntil = expiresAt
	}
	return res, nil
}

// QueryChurnRiskSuppressedForSend returns the subscriber ids currently
// excluded from a campaign's send (active = no expiry, or expiry in the
// future). The send path calls this to subtract the cooling-off set from the
// mailed audience so the sent list never diverges from the mailed list.
func (r *Repo) QueryChurnRiskSuppressedForSend(ctx context.Context, tenantID, campaignID string) ([]string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text
  FROM subscriber_send_exclusions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND (expires_at IS NULL OR expires_at > now())
 ORDER BY churn_score_at_exclusion DESC`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GetSendExclusions returns the active exclusion summary for a campaign.
func (r *Repo) GetSendExclusions(ctx context.Context, tenantID, campaignID string) (*PreSendRefineResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text, churn_score_at_exclusion, reason, expires_at
  FROM subscriber_send_exclusions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND (expires_at IS NULL OR expires_at > now())
 ORDER BY churn_score_at_exclusion DESC`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &PreSendRefineResult{
		CampaignID:     campaignID,
		ChurnThreshold: DefaultChurnThreshold,
		AffectedSample: []PreSendExcludedSubscriber{},
	}
	var latestExpiry *time.Time
	for rows.Next() {
		var ex PreSendExcludedSubscriber
		var expiresAt *time.Time
		if err := rows.Scan(&ex.SubscriberID, &ex.ChurnScore, &ex.Reason, &expiresAt); err != nil {
			return nil, err
		}
		res.ExcludedCount++
		if expiresAt != nil {
			res.CoolingOffCount++
			if latestExpiry == nil || expiresAt.After(*latestExpiry) {
				latestExpiry = expiresAt
			}
		}
		if len(res.AffectedSample) < presendSampleCap {
			res.AffectedSample = append(res.AffectedSample, ex)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	res.CoolingOffUntil = latestExpiry
	return res, tx.Commit(ctx)
}

// ClearSendExclusions removes all exclusion rows for a campaign (force
// re-entry). Returns the number of rows cleared.
func (r *Repo) ClearSendExclusions(ctx context.Context, tenantID, campaignID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_send_exclusions WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// MountPreSendRefineRoutes registers the SUB-067 campaign-scoped pre-send
// refinement endpoints. POST/DELETE are write-scoped; GET is read-scoped.
func MountPreSendRefineRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/campaigns/{id}/presend-refine", d.RefineForSend)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/campaigns/{id}/presend-refine", d.GetSendExclusions)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/campaigns/{id}/presend-refine", d.ClearSendExclusions)
}

// RefineForSend POST /api/v1/campaigns/{id}/presend-refine
func (d *Deps) RefineForSend(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in PreSendRefineInput
	// Body is optional — an empty POST uses the defaults. Decode best-effort.
	if r.Body != nil && r.ContentLength != 0 {
		if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	out, err := d.Repo.RefineForSend(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	if !out.DryRun {
		d.emit(t.ID, "campaign.presend_refine.committed", map[string]any{
			"campaign_id": out.CampaignID, "excluded_count": out.ExcludedCount,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// GetSendExclusions GET /api/v1/campaigns/{id}/presend-refine
func (d *Deps) GetSendExclusions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetSendExclusions(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ClearSendExclusions DELETE /api/v1/campaigns/{id}/presend-refine
func (d *Deps) ClearSendExclusions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	cleared, err := d.Repo.ClearSendExclusions(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "campaign.presend_refine.cleared", map[string]any{
		"campaign_id": chi.URLParam(r, "id"), "cleared": cleared,
	})
	writeJSON(w, http.StatusOK, map[string]any{"cleared": cleared})
}
