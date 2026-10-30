// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for the Next Best Product recommender. The desktop
// Settings > Personalization > Recommendations panel uses these
// endpoints to read/write nbp_settings and to preview the
// recommendations for a chosen anchor subscriber.
//
// Routes (all under /api/v1/nbp):
//
//   GET    /api/v1/nbp/settings                    -> current per-tenant settings (defaults if no row)
//   PUT    /api/v1/nbp/settings                    -> upsert per-tenant settings
//   GET    /api/v1/nbp/recommend?subscriber_id=ID  -> live recommendations for a subscriber
//   GET    /api/v1/nbp/syntax-example              -> the canonical Liquid snippet (for help text)

package nbp

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	nbpJSONMaxBodyBytes    int64 = 16 << 10
	maxRecommendationLimit       = 24
)

// Mount wires the routes onto router under the canonical /api/v1/nbp prefix.
// The caller passes the authenticated group router directly so startup route
// authorization validation observes the complete outer middleware chain on
// every leaf; API-key scope checks are layered on top here.
//
// logger is used by httperror.WriteInternal to record server-side error
// context (tenant_id, request_id, err) without leaking err text in the
// HTTP response. May be nil; httperror tolerates that.
func Mount(router chi.Router, repo *Repo, recommender *Recommender, logger *slog.Logger) {
	if router == nil {
		return
	}
	router.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/nbp/settings", getSettingsHandler(repo, logger))
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/nbp/settings", putSettingsHandler(repo, logger))
	router.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/nbp/recommend", recommendHandler(recommender, logger))
	// No scope check — this is a static help string used by the
	// compose UI to populate the example block. Returning it via
	// HTTP rather than baking it into the desktop bundle means
	// the example stays in lockstep with the merge grammar.
	router.Get("/api/v1/nbp/syntax-example", syntaxExampleHandler())
}

// MountExtended wires strategy experiments and campaign-performance reads.
// Vendor sidecar configuration is intentionally absent until a real adapter
// and catalog-sync worker ship as one reviewed capability.
func MountExtended(router chi.Router, expRepo *ExperimentRepo, perfRepo *PerformanceRepo, logger *slog.Logger) {
	if router == nil {
		return
	}
	router.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/nbp/experiments", listExperimentsHandler(expRepo, logger))
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/nbp/experiments", upsertExperimentHandler(expRepo, logger))
	router.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/nbp/performance/{campaign_id}", listPerformanceHandler(perfRepo, logger))
}

func listExperimentsHandler(repo *ExperimentRepo, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		exps, err := repo.List(r.Context(), t.ID)
		if err != nil {
			httperror.WriteInternal(w, logger, err, r.Context())
			return
		}
		if exps == nil {
			exps = []Experiment{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": exps})
	}
}

func upsertExperimentHandler(repo *ExperimentRepo, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		var in Experiment
		if err := httpbody.DecodeJSON(w, r, nbpJSONMaxBodyBytes, &in); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
		out, err := repo.Upsert(r.Context(), t.ID, in)
		if err != nil {
			httperror.WriteInternal(w, logger, err, r.Context())
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func listPerformanceHandler(repo *PerformanceRepo, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		campaignID := strings.TrimSpace(chi.URLParam(r, "campaign_id"))
		if campaignID == "" {
			httperror.WriteValidation(w, "missing_campaign_id", "")
			return
		}
		items, err := repo.ListForCampaign(r.Context(), t.ID, campaignID)
		if err != nil {
			httperror.WriteInternal(w, logger, err, r.Context())
			return
		}
		if items == nil {
			items = []CampaignPerformance{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"campaign_id": campaignID,
			"items":       items,
		})
	}
}

func getSettingsHandler(repo *Repo, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		s, err := repo.GetSettings(r.Context(), t.ID)
		if err != nil && err != ErrNotFound {
			httperror.WriteInternal(w, logger, err, r.Context())
			return
		}
		writeJSON(w, http.StatusOK, s)
	}
}

func putSettingsHandler(repo *Repo, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		// Reject pathologically large bodies. The settings payload is
		// small (10 keys); 16 KB is more than enough.
		var in Settings
		if err := httpbody.DecodeJSON(w, r, nbpJSONMaxBodyBytes, &in); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
		out, err := repo.UpsertSettings(r.Context(), t.ID, in)
		if err != nil {
			if errors.Is(err, ErrUnsupportedStrategy) {
				httperror.WriteValidation(w, "unsupported_strategy", err.Error())
				return
			}
			httperror.WriteInternal(w, logger, err, r.Context())
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func recommendHandler(recommender *Recommender, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		subID := strings.TrimSpace(r.URL.Query().Get("subscriber_id"))
		if subID == "" {
			httperror.WriteValidation(w, "missing_subscriber_id", "")
			return
		}
		if _, err := uuid.Parse(subID); err != nil {
			httperror.WriteValidation(w, "invalid_subscriber_id", "subscriber_id must be a UUID")
			return
		}
		limit := 0
		if s := r.URL.Query().Get("limit"); s != "" {
			n, err := strconv.Atoi(strings.TrimSpace(s))
			if err != nil || n < 1 || n > maxRecommendationLimit {
				httperror.WriteValidation(w, "invalid_limit", "limit must be an integer from 1 to 24")
				return
			}
			limit = n
		}
		campaignID := strings.TrimSpace(r.URL.Query().Get("campaign_id"))
		if campaignID != "" {
			if _, err := uuid.Parse(campaignID); err != nil {
				httperror.WriteValidation(w, "invalid_campaign_id", "campaign_id must be a UUID")
				return
			}
		}
		recs, err := recommender.RecommendForSubscriber(r.Context(), RecommendInput{
			TenantID:     t.ID,
			SubscriberID: subID,
			Limit:        limit,
			CampaignID:   campaignID,
		})
		if err != nil {
			httperror.WriteInternal(w, logger, err, r.Context())
			return
		}
		if recs == nil {
			recs = []Recommendation{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"items":         recs,
			"subscriber_id": subID,
			"helper_name":   LiquidHelperName,
		})
	}
}

func syntaxExampleHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"helper_name": LiquidHelperName,
			"example":     SyntaxExample(),
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
