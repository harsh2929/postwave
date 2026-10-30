// SPDX-License-Identifier: AGPL-3.0-only
//
// Package holdout implements campaign holdout groups for
// incremental-lift measurement.
//
// The marketing-attribution question: of the conversions that
// followed a campaign, how many would have happened anyway? Without
// a control group, post-send conversion rate is correlation, not
// causation. The industry-standard fix is a randomly-held-back
// fraction of the audience that does NOT receive the campaign;
// post-send their conversion rate is the counterfactual baseline.
//
// Design choices:
//
//   * Per-subscriber assignment is computed deterministically from
//     md5(seed || subscriber_id), then frozen in an immutable assignment
//     ledger in the same transaction that queues treatment recipients.
//   * The ledger is intentional evidence, not disposable booleans: without it
//     the suppressed control cohort has no send rows and cannot be reconstructed
//     later. It also carries the 90-day rotation decision for audit.
//
// Surfaces:
//
//   POST   /api/v1/campaigns/{id}/holdout              body: {percent}
//   GET    /api/v1/campaigns/{id}/holdout
//   DELETE /api/v1/campaigns/{id}/holdout
//   GET    /api/v1/campaigns/{id}/holdout/lift         lift report

package holdout

import (
	"context"
	"crypto/md5"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	requestJSONMaxBodyBytes     int64 = 4 << 10
	defaultConversionWindowDays       = 7
	defaultOutcomeMetric              = "any_conversion"
)

var outcomeMetricPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$`)

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// LiftResults owns the immutable close-once experiment result. It is
	// optional so existing composition remains source-compatible; the production
	// handler constructs the store from Pool when it is not injected by a test.
	LiftResults *LiftResultStore
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error server-side without echoing it to clients.
	Logger *slog.Logger
}

// Holdout is the API projection.
type Holdout struct {
	CampaignID              string     `json:"campaign_id"`
	Percent                 float64    `json:"percent"`
	Seed                    string     `json:"seed"`
	DecidedAt               *time.Time `json:"decided_at,omitempty"`
	HeldOutCount            int        `json:"held_out_count"`
	SentCount               int        `json:"sent_count"`
	OutcomeMetric           string     `json:"outcome_metric"`
	ConversionWindowDays    int        `json:"conversion_window_days"`
	MinimumRelativeEffect   float64    `json:"minimum_relative_effect"`
	AssignmentLedgerVersion string     `json:"assignment_ledger_version,omitempty"`
	AssignmentLedgerSHA256  string     `json:"assignment_ledger_sha256,omitempty"`
	CreatedAt               time.Time  `json:"created_at"`
	UpdatedAt               time.Time  `json:"updated_at"`
}

type createReq struct {
	Percent               float64  `json:"percent"`
	OutcomeMetric         string   `json:"outcome_metric,omitempty"`
	ConversionWindowDays  *int     `json:"conversion_window_days,omitempty"`
	MinimumRelativeEffect *float64 `json:"minimum_relative_effect,omitempty"`
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Post("/api/v1/campaigns/{id}/holdout", d.Create)
	r.With(read).Get("/api/v1/campaigns/{id}/holdout", d.Get)
	r.With(admin).Delete("/api/v1/campaigns/{id}/holdout", d.Delete)
	r.With(read).Get("/api/v1/campaigns/{id}/holdout/lift", d.Lift)
}

// Create POST /api/v1/campaigns/{id}/holdout.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	campaignID := chi.URLParam(r, "id")
	if campaignID == "" {
		writeErr(w, http.StatusBadRequest, "missing_campaign", "")
		return
	}
	var body createReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		code := httpbody.ErrorCode(err)
		if httperror.IsValidationCode(code) {
			httperror.Write(w, httpbody.StatusCode(err), code, httpbody.PublicMessage(err))
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	if body.Percent < 0 || body.Percent > 50 {
		writeErr(w, http.StatusBadRequest, "bad_percent", "percent must be 0..50")
		return
	}
	outcomeMetric := strings.TrimSpace(body.OutcomeMetric)
	if outcomeMetric == "" {
		outcomeMetric = defaultOutcomeMetric
	}
	if !outcomeMetricPattern.MatchString(outcomeMetric) {
		writeErr(w, http.StatusBadRequest, "bad_outcome_metric",
			"outcome_metric must be a stable 1-96 character event key")
		return
	}
	windowDays := defaultConversionWindowDays
	if body.ConversionWindowDays != nil {
		windowDays = *body.ConversionWindowDays
	}
	if windowDays < 1 || windowDays > 30 {
		writeErr(w, http.StatusBadRequest, "bad_conversion_window",
			"conversion_window_days must be between 1 and 30")
		return
	}
	minimumEffect := defaultMinimumRelativeEffect
	if body.MinimumRelativeEffect != nil {
		minimumEffect = *body.MinimumRelativeEffect
	}
	if minimumEffect <= 0 || minimumEffect > 1 {
		writeErr(w, http.StatusBadRequest, "bad_minimum_relative_effect",
			"minimum_relative_effect must be greater than 0 and no more than 1")
		return
	}
	seed, seedErr := freshSeed()
	if seedErr != nil {
		httperror.WriteInternal(w, d.Logger, seedErr, r.Context())
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Never hold out a transactional message.
	//
	// A holdout SUPPRESSES its control arm from the send. For a marketing
	// campaign that is the entire point; for a receipt, a password reset or a
	// shipping notice it means deliberately not sending a message the recipient
	// is waiting for, to measure something nobody asked to measure. This is the
	// PRD's one hard block, and it belongs at creation rather than at send:
	// refusing at send would mean discovering the mistake after somebody had
	// already decided the campaign was configured.
	var campaignType string
	if err := tx.QueryRow(r.Context(), `
SELECT campaign_type FROM campaigns
 WHERE id = $1::uuid AND tenant_id = $2::uuid`, campaignID, t.ID).Scan(&campaignType); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if blockedHoldoutCampaignTypes[campaignType] {
		writeErr(w, http.StatusUnprocessableEntity, "holdout_not_allowed",
			"holdouts suppress the control arm from the send, so they cannot be "+
				"applied to "+campaignType+" messages — a recipient waiting for this "+
				"message would simply not receive it")
		return
	}

	// Below the small-list floor a holdout cannot measure anything, and taking
	// a slice of a small audience out of the send costs real reach to buy a
	// number that will be noise. Refuse with the arithmetic, not a shrug.
	audience, audienceKnown, err := audienceSize(r.Context(), tx, t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if body.Percent > 0 && audienceKnown && audience < minimumHoldoutAudience {
		writeErr(w, http.StatusUnprocessableEntity, "audience_too_small",
			"this audience is "+strconv.FormatInt(audience, 10)+" subscribers; holdouts "+
				"need at least "+strconv.Itoa(minimumHoldoutAudience)+" to produce a lift "+
				"figure that is not noise, and the withheld reach would be spent for nothing")
		return
	}

	// The decision is immutable once made.
	//
	// `percent` IS the bucket cutoff, so editing it after the send has already
	// partitioned the audience silently re-randomises which people count as the
	// control arm — the report would then measure a cohort that was never
	// withheld. Updating only while decided_at IS NULL keeps the number
	// editable exactly as long as it means nothing yet.
	var storedSeed string
	err = tx.QueryRow(r.Context(), `
INSERT INTO campaign_holdouts (
    campaign_id, tenant_id, percent, seed, outcome_metric,
    conversion_window_days, minimum_relative_effect
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
ON CONFLICT (campaign_id) DO UPDATE
   SET percent = EXCLUDED.percent,
       outcome_metric = EXCLUDED.outcome_metric,
       conversion_window_days = EXCLUDED.conversion_window_days,
       minimum_relative_effect = EXCLUDED.minimum_relative_effect,
       updated_at = now()
 WHERE campaign_holdouts.decided_at IS NULL
RETURNING seed`, campaignID, t.ID, body.Percent, seed,
		outcomeMetric, windowDays, minimumEffect).Scan(&storedSeed)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusConflict, "holdout_already_decided",
			"this holdout has already been applied to a send; changing the experiment "+
				"contract now would invalidate the lift already being measured")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"campaign_id":             campaignID,
		"percent":                 body.Percent,
		"seed":                    storedSeed,
		"outcome_metric":          outcomeMetric,
		"conversion_window_days":  windowDays,
		"minimum_relative_effect": minimumEffect,
	})
}

// Get GET /api/v1/campaigns/{id}/holdout.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var h Holdout
	err = tx.QueryRow(r.Context(), `
SELECT campaign_id::text, percent::float8, seed, decided_at,
       held_out_count, sent_count, outcome_metric, conversion_window_days,
       minimum_relative_effect, COALESCE(assignment_ledger_version, ''),
       COALESCE(assignment_ledger_sha256, ''), created_at, updated_at
  FROM campaign_holdouts
 WHERE campaign_id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID).Scan(&h.CampaignID, &h.Percent, &h.Seed, &h.DecidedAt,
		&h.HeldOutCount, &h.SentCount, &h.OutcomeMetric,
		&h.ConversionWindowDays, &h.MinimumRelativeEffect,
		&h.AssignmentLedgerVersion, &h.AssignmentLedgerSHA256,
		&h.CreatedAt, &h.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "holdout not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, h)
}

// Delete DELETE /api/v1/campaigns/{id}/holdout.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// A decided holdout is immutable measurement evidence. Deleting it would
	// erase the frozen experiment contract and can cascade its assignment
	// ledger, making a previously reported lift impossible to reproduce. Lock
	// the row before deciding whether deletion is still permitted so a send
	// cannot freeze it between this check and the DELETE below.
	var decidedAt *time.Time
	err = tx.QueryRow(r.Context(), `
SELECT decided_at
  FROM campaign_holdouts
 WHERE campaign_id = $1::uuid
   AND tenant_id = $2::uuid
 FOR UPDATE`, id, t.ID).Scan(&decidedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "holdout not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if decidedAt != nil {
		writeErr(w, http.StatusConflict, "holdout_already_decided",
			"this holdout has already been applied to a send; its frozen experiment contract and assignment evidence cannot be deleted")
		return
	}

	tag, err := tx.Exec(r.Context(), `
DELETE FROM campaign_holdouts
 WHERE campaign_id = $1::uuid
   AND tenant_id = $2::uuid
   AND decided_at IS NULL`, id, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() != 1 {
		// The row is locked, so this is fail-closed defence in depth rather than
		// an expected race path.
		writeErr(w, http.StatusConflict, "holdout_state_changed",
			"the holdout changed while deletion was being reviewed; reload before trying again")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Lift GET /api/v1/campaigns/{id}/holdout/lift.
//
// Closes (once the configured window ends) and returns the immutable
// intent-to-treat comparison over the exact assignment ledger, outcome metric,
// and time window frozen when the campaign was queued.
func (d *Deps) Lift(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Load the frozen experiment contract.  This read is intentionally separate
	// from finalization so a not-yet-sent campaign and an open outcome window are
	// useful, non-error states for clients.
	var percent float64
	var decidedAt *time.Time
	var metric string
	var conversionWindowDays int
	err = tx.QueryRow(r.Context(), `
SELECT percent::float8, decided_at, outcome_metric, conversion_window_days
  FROM campaign_holdouts
 WHERE campaign_id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID).Scan(&percent, &decidedAt, &metric, &conversionWindowDays)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "holdout not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if decidedAt == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"campaign_id": id,
			"percent":     percent,
			"status":      "pending",
			"message":     "holdout not yet decided; lift not computable",
		})
		return
	}

	// End the read transaction before the finalizer opens its own tenant-scoped
	// transaction and takes the holdout row lock. Keeping this transaction open
	// would add an unnecessary connection and make lock behaviour harder to
	// reason about under concurrent report requests.
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	windowStart := decidedAt.UTC()
	windowEnd := windowStart.Add(time.Duration(conversionWindowDays) * 24 * time.Hour)
	store := d.LiftResults
	if store == nil {
		store = NewLiftResultStore(d.Pool)
	}
	result, err := store.CloseConfiguredWindow(r.Context(), t.ID, id)
	switch {
	case errors.Is(err, ErrLiftWindowOpen):
		writeJSON(w, http.StatusOK, map[string]any{
			"campaign_id":    id,
			"percent":        percent,
			"status":         "pending",
			"outcome_metric": metric,
			"window_start":   windowStart,
			"window_end":     windowEnd,
			"message":        "the frozen conversion window is still open; no lift has been finalized",
		})
		return
	case errors.Is(err, ErrLiftResultUnavailable):
		// A legacy/partial campaign with no frozen assignment ledger is not an
		// experiment. Return an explicit unavailable state and no number rather
		// than falling back to a reconstructed cohort.
		writeJSON(w, http.StatusOK, map[string]any{
			"campaign_id":    id,
			"percent":        percent,
			"status":         "unavailable",
			"outcome_metric": metric,
			"window_start":   windowStart,
			"window_end":     windowEnd,
			"message":        "the immutable assignment evidence required to calculate lift is unavailable",
		})
		return
	case err != nil:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, projectLiftResult(percent, result))
}

// projectLiftResult is the sole public projection of immutable F02 evidence.
// Compatibility aliases retain the established client wire shape, but all of
// them are sourced from the frozen intent-to-treat populations and configured
// outcome metric. No reconstructed/hash-derived approximation can reach it.
func projectLiftResult(percent float64, result *LiftResult) map[string]any {
	significance := LiftSignificance{
		ControlRate:             result.RateControl,
		TreatmentRate:           result.RateTreatment,
		AbsoluteLift:            result.AbsoluteLift,
		RelativeLift:            result.RelativeLift,
		IncrementalConversions:  result.IncrementalConversions,
		PValue:                  result.PValue,
		CILow:                   result.CILow,
		CIHigh:                  result.CIHigh,
		Powered:                 result.Powered(),
		MinimumDetectableEffect: result.MinimumDetectableEffect,
		Reason:                  result.UnderpoweredReason,
	}
	response := map[string]any{
		"campaign_id":              result.CampaignID,
		"percent":                  percent,
		"status":                   result.Status,
		"result_id":                result.ID,
		"result_version":           result.ResultVersion,
		"methodology_version":      result.MethodologyVersion,
		"methodology_statement":    result.MethodologyStatement,
		"outcome_metric":           result.Metric,
		"window_start":             result.WindowStart,
		"window_end":               result.WindowEnd,
		"generated_at":             result.GeneratedAt,
		"held_out_subs":            result.NControl,
		"sent_subs":                result.NTreatment,
		"held_out_conversions":     result.ConversionsControl,
		"sent_conversions":         result.ConversionsTreatment,
		"held_out_conversion_rate": result.RateControl,
		"sent_conversion_rate":     result.RateTreatment,
		// Deprecated aliases consumed by older web/desktop builds. Despite their
		// historical names, these are the frozen configured outcome, never a
		// campaign-click approximation.
		"held_out_clicks":       result.ConversionsControl,
		"sent_clicks":           result.ConversionsTreatment,
		"held_out_click_rate":   result.RateControl,
		"sent_click_rate":       result.RateTreatment,
		"significance":          significance,
		"calculation_mode":      "frozen_intent_to_treat",
		"assignment_set_sha256": result.AssignmentSetSHA256,
		"conversion_set_sha256": result.ConversionSetSHA256,
		"evidence_sha256":       result.EvidenceSHA256,
	}
	if result.Powered() {
		response["incremental_lift"] = *result.AbsoluteLift
		if result.RelativeLift != nil {
			response["lift_percent"] = *result.RelativeLift
		}
	} else {
		response["message"] = result.UnderpoweredReason
	}
	return response
}

func safeRate(num, den int64) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

// AssignBucket returns the bucket (0..99) for a (seed,
// subscriberID) pair. Exported so the dispatcher can call it
// when materializing the audience.
func AssignBucket(seed, subscriberID string) int {
	h := md5.Sum([]byte(seed + subscriberID))
	// First 8 hex chars → int.
	prefix := hex.EncodeToString(h[:4])
	n := new(big.Int)
	n.SetString(prefix, 16)
	return int(new(big.Int).Mod(n, big.NewInt(100)).Int64())
}

// IsHeldOut returns true when (seed, subscriberID) lands in the
// holdout bucket for the given percent (0..50).
func IsHeldOut(seed, subscriberID string, percent float64) bool {
	cutoff := int(percent + 0.5)
	return AssignBucket(seed, subscriberID) < cutoff
}

// LookupConfig reads the per-campaign holdout config (seed + percent).
// Returns (seed, percent, true, nil) when configured, (_, _, false, nil)
// when no row exists, and a non-nil error otherwise. Used by the queue
// path to decide whether to filter the audience. See D3 in
// PRODUCTION_READINESS.md.
func LookupConfig(ctx context.Context, pool *db.Pool, tenantID, campaignID string) (seed string, percent float64, exists bool, err error) {
	if pool == nil || tenantID == "" || campaignID == "" {
		return "", 0, false, nil
	}
	tx, terr := db.WithTenant(ctx, pool, tenantID)
	if terr != nil {
		return "", 0, false, terr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT seed, percent::float8 FROM campaign_holdouts
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID).Scan(&seed, &percent)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", 0, false, nil
		}
		return "", 0, false, err
	}
	return seed, percent, true, nil
}

// FilterAudience splits emails into (kept, heldOut) using the
// deterministic hash bucket. Apply at queue-fill BEFORE the A/B
// variant split so a subscriber can't simultaneously be in a
// treatment variant AND the holdout (D12 — keeps the lift report
// consistent). Percent ≤ 0 returns (emails, nil).
func FilterAudience(seed string, emails []string, percent float64) (kept, heldOut []string) {
	if percent <= 0 || len(emails) == 0 {
		return emails, nil
	}
	kept = make([]string, 0, len(emails))
	heldOut = make([]string, 0)
	for _, e := range emails {
		if IsHeldOut(seed, e, percent) {
			heldOut = append(heldOut, e)
		} else {
			kept = append(kept, e)
		}
	}
	return kept, heldOut
}

func freshSeed() (string, error) {
	// The seed is not a bearer credential, but independent campaigns need
	// independent randomisation. A clock-derived seed can collide across
	// concurrent replicas and correlate two experiments, so use the operating
	// system CSPRNG and surface failure instead of silently degrading.
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate holdout seed: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
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

// keep errors imported for future typed sentinels.
var _ = errors.New

// blockedHoldoutCampaignTypes are message classes a holdout must never touch.
//
// Named as data rather than an inline condition so the next type added to the
// campaigns CHECK constraint has an obvious place to be considered.
var blockedHoldoutCampaignTypes = map[string]bool{
	"transactional": true,
	"automated":     true,
}

// minimumHoldoutAudience is the PRD's small-list floor.
const minimumHoldoutAudience = 2000

// audienceSize returns the size of the campaign's target audience.
//
// Returns known=false rather than 0 when the audience cannot be resolved (a
// filter-mode campaign, or a list that no longer exists). A guard that treats
// "unknown" as "zero" would block every holdout it could not measure, which is
// a different and worse failure than the one it exists to prevent.
func audienceSize(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) (int64, bool, error) {
	var listID *string
	if err := tx.QueryRow(ctx, `
SELECT audience_list_id::text FROM campaigns
 WHERE id = $1::uuid AND tenant_id = $2::uuid`, campaignID, tenantID).Scan(&listID); err != nil {
		return 0, false, err
	}
	if listID == nil || *listID == "" {
		return 0, false, nil
	}
	var n int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL`,
		tenantID, *listID).Scan(&n); err != nil {
		return 0, false, err
	}
	return n, true, nil
}
