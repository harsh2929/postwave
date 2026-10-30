// Package sto_predictive_clv scaffolds the Phase 3 SOTA predictive-CLV /
// churn-risk / EDONO surface (`sto-predictive-clv`, P2, XL).
//
// Vendor parity reference (2026 audit):
//   - Klaviyo  — Predicted CLV / Predicted Churn / Expected Date of Next
//     Order / Avg Time Between Orders / Predicted Gender suite, all
//     surfaced as profile properties usable in segments + flows.
//   - Mailchimp — Predictive CLV + Purchase Likelihood.
//   - Braze    — Predictive Churn + Predicted Events.
//   - MoEngage — Predictions (CLV, churn, RFM, propensity).
//   - HubSpot  — Predictive lead score / deal-stage forecasting.
//
// Moosewave already ships a deterministic heuristic-v1 surface in
// `internal/predictive` (RFM scores, naive CLV extrapolation). This
// package is the ML-backed sibling: it owns the `subscriber_predictions`
// table created in migration 0344 and is the surface the segment
// builder + flows will pull from once the training worker is real.
//
// Scope of this scaffold:
//   - Data model (migration 0344)
//   - Repo with the read / upsert / list-runs queries
//   - HTTP handlers returning a happy-path stub
//   - Worker skeleton (training loop is intentionally a no-op until
//     the ML pipeline lands — see MIGRATION.md)
//
// What is deferred (see MIGRATION.md for the migration recipe):
//   - The actual ML training (BTYD-NBD / Gamma-Gamma for CLV,
//     XGBoost for churn, calibrated probability ensembles for gender /
//     age) over `subscriber_events` + `orders`.
//   - Segment-builder profile-property registration so operators can
//     write "predicted_clv_cents >= $X" rules.
//   - Flow trigger on "churn_risk crosses threshold".
//   - Backfill behaviour, drift detection, and shadow-model A/B.
package sto_predictive_clv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MinCustomersForTraining is the floor below which the worker refuses
// to train a per-tenant model and marks the run as
// `skipped_insufficient_data`. Documented as a vendor-parity threshold
// in MIGRATION.md.
const MinCustomersForTraining = 500

// MinHistoryDays is the floor for the rolling input window (the worker
// needs at least this many days of order history to fit the BTYD /
// churn models with non-degenerate parameters).
const MinHistoryDays = 180

// DefaultForecastHorizonDays is the look-ahead the worker forecasts
// over when emitting `clv_predicted_cents`, `predicted_order_count`,
// and `expected_next_order_at`.
const DefaultForecastHorizonDays = 365

// Deps wires the repo + worker into the HTTP layer. The struct mirrors
// the shape used by sibling packages (predictive, send_time_opt,
// scoring) so the main.go bootstrap stays uniform.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// Prediction is the JSON surface returned by the per-subscriber GET
// handler and emitted into the segment compiler's profile-property
// snapshot. Field names track Klaviyo conventions where possible so
// migrating tenants can keep their existing segment definitions.
type Prediction struct {
	SubscriberID         string         `json:"subscriber_id"`
	CLVPredictedCents    *int64         `json:"clv_predicted_cents,omitempty"`
	ChurnRiskScore       *float64       `json:"churn_risk_score,omitempty"`
	ExpectedNextOrderAt  *time.Time     `json:"expected_next_order_at,omitempty"`
	AvgDaysBetweenOrders *float64       `json:"avg_days_between_orders,omitempty"`
	PredictedOrderCount  *float64       `json:"predicted_order_count,omitempty"`
	PredictedGender      string         `json:"predicted_gender,omitempty"`
	PredictedAgeYears    *int           `json:"predicted_age_years,omitempty"`
	Confidence           *float64       `json:"confidence,omitempty"`
	DataSufficiency      string         `json:"data_sufficiency,omitempty"`
	ModelVersion         string         `json:"model_version"`
	Payload              map[string]any `json:"payload,omitempty"`
	ComputedAt           time.Time      `json:"computed_at"`
}

// Run mirrors `subscriber_prediction_runs` for the GET /runs surface.
type Run struct {
	ID                   string         `json:"id"`
	ModelKey             string         `json:"model_key"`
	ModelVersion         string         `json:"model_version"`
	Status               string         `json:"status"`
	InputWindowDays      int            `json:"input_window_days"`
	ScoredProfiles       int            `json:"scored_profiles"`
	InsufficientProfiles int            `json:"insufficient_profiles"`
	Metrics              map[string]any `json:"metrics,omitempty"`
	Error                string         `json:"error,omitempty"`
	StartedAt            *time.Time     `json:"started_at,omitempty"`
	CompletedAt          *time.Time     `json:"completed_at,omitempty"`
	CreatedAt            time.Time      `json:"created_at"`
}

// MountRoutes registers the HTTP surface. All read paths require the
// reports scope; the admin recompute trigger requires the admin scope
// (consistent with sibling packages).
//
// Routes:
//
//	GET  /api/v1/predictions/catalog                 — model catalog + min-data thresholds
//	GET  /api/v1/predictions/profiles                — paginated tenant snapshot
//	GET  /api/v1/predictions/profiles/{subscriberID} — one subscriber
//	GET  /api/v1/predictions/runs                    — recent training runs
//	POST /api/v1/predictions/recompute               — kick off an ad-hoc run (admin)
func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/predictions/catalog", d.Catalog)
	r.With(read).Get("/api/v1/predictions/profiles", d.ListProfiles)
	r.With(read).Get("/api/v1/predictions/profiles/{subscriberID}", d.GetProfile)
	r.With(read).Get("/api/v1/predictions/runs", d.ListRuns)
	r.With(admin).Post("/api/v1/predictions/recompute", d.Recompute)
}

// Catalog advertises which models the worker is configured to train
// and the minimum-data thresholds operators need to clear before
// predictions populate. Returned by the dashboard so the empty-state
// can be helpful instead of generic.
func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "sto.predictive.v1",
		"models": []map[string]any{
			{"key": "clv", "label": "Predicted CLV", "runtime_status": "scaffold", "version": "btyd-v0-scaffold"},
			{"key": "churn", "label": "Predicted Churn Risk", "runtime_status": "scaffold", "version": "xgb-v0-scaffold"},
			{"key": "edono", "label": "Expected Date of Next Order", "runtime_status": "scaffold", "version": "btyd-v0-scaffold"},
			{"key": "atbo", "label": "Avg Time Between Orders", "runtime_status": "scaffold", "version": "btyd-v0-scaffold"},
			{"key": "gender", "label": "Predicted Gender", "runtime_status": "scaffold", "version": "demographic-v0-scaffold"},
			{"key": "age", "label": "Predicted Age", "runtime_status": "scaffold", "version": "demographic-v0-scaffold"},
		},
		"min_data": map[string]any{
			"customers":    MinCustomersForTraining,
			"history_days": MinHistoryDays,
			"horizon_days": DefaultForecastHorizonDays,
		},
		"vendor_parity": []string{
			"klaviyo.predicted_clv",
			"klaviyo.predicted_churn",
			"klaviyo.expected_next_order_date",
			"klaviyo.avg_time_between_orders",
			"klaviyo.predicted_gender",
			"mailchimp.predictive_clv",
			"mailchimp.purchase_likelihood",
			"braze.predictive_churn",
			"moengage.predictions",
			"hubspot.predictive_lead_score",
		},
	})
}

// ListProfiles returns the tenant snapshot. The full implementation
// will accept segment-builder filters (clv_min, churn_max, etc.) — for
// now it returns the most-recent-N rows so the dashboard can paginate.
func (d *Deps) ListProfiles(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantFromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	limit := intParam(r, "limit", 100)
	out, err := d.repo().ListPredictions(r.Context(), tenantID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "limit": limit})
}

// GetProfile fetches a single subscriber's prediction snapshot. Returns
// 404 if the worker hasn't scored that subscriber yet (insufficient
// data is also surfaced as 404 + an explanatory error code so the UI
// can render onboarding state).
func (d *Deps) GetProfile(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantFromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	subscriberID := strings.TrimSpace(chi.URLParam(r, "subscriberID"))
	if subscriberID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_subscriber_id", "subscriberID required"))
		return
	}
	out, err := d.repo().GetPrediction(r.Context(), tenantID, subscriberID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_scored", "subscriber not yet scored"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListRuns surfaces the audit trail of recent training runs (status,
// metrics, error). The dashboard renders "Last refreshed N hours ago"
// from the most-recent succeeded row.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantFromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().ListRuns(r.Context(), tenantID, intParam(r, "limit", 25))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// Recompute kicks off an ad-hoc training run. The scaffold inserts a
// `skipped_insufficient_data` row so end-to-end wiring is verifiable
// without the ML pipeline being live yet.
//
// Once the worker is real, this handler will enqueue rather than
// inline-execute (training is multi-minute on a large tenant).
func (d *Deps) Recompute(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantFromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	run, err := d.repo().InsertRunPlaceholder(r.Context(), tenantID, "composite", "btyd-v0-scaffold", DefaultForecastHorizonDays)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"run":     run,
		"message": "scaffold accepted recompute; ML training pipeline not yet wired (see MIGRATION.md)",
	})
}

// ---- helpers ----

func (d *Deps) repo() *Repo {
	if d == nil {
		return nil
	}
	return d.Repo
}

func tenantFromRequest(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func intParam(r *http.Request, key string, fallback int) int {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return fallback
	}
	var n int
	if _, err := fmt.Sscanf(value, "%d", &n); err != nil || n <= 0 {
		return fallback
	}
	if n > 500 {
		return 500
	}
	return n
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

// Compile-time guard: keeps `context` imported even if the repo file
// is the only consumer in future refactors. The handlers above embed
// the request context implicitly via r.Context(), but a deferred
// context.WithTimeout wrapper is the obvious next addition.
var _ = context.Background
