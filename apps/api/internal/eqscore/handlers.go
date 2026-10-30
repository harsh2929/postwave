// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — POST /api/v1/deliverability/eq-score.
//
// Accepts caller-authored message content and returns a Result. Sender
// authentication and reputation are resolved from tenant-scoped server state;
// callers cannot self-attest security fields that later feed persisted trends.

package eqscore

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// Deps bundles handler dependencies.
type Deps struct {
	// SenderAuth is an injectable authoritative resolver. Production falls back
	// to the DB-backed implementation when Pool is present.
	SenderAuth SenderAuthResolver
	// Reputation is injectable. Production falls back to seven-day campaign
	// report history when Pool is present.
	Reputation Reputation
	// Pool is optional. When non-nil, every successful grade is
	// persisted to eq_score_history so the rolling-30-day average can
	// be read by downstream consumers (the placement predictor's
	// engagement-risk component, the EQ-trend chart).
	Pool *db.Pool
	// Logger is used to log 5xx infra errors via httperror.WriteInternal.
	// Nil is tolerated — nothing is logged but the response is still
	// written with a generic 500 envelope.
	Logger *slog.Logger
	// RateLimit bounds repeated history writes. Production wires the shared
	// authenticated per-tenant limiter; nil is tolerated by focused tests.
	RateLimit func(http.Handler) http.Handler
	// PersistScore is an injectable history writer. Production falls back to
	// RecordScore; a write failure fails the request so the API never claims a
	// trend receipt that was silently lost.
	PersistScore func(context.Context, *db.Pool, HistoryRecord) error
}

// MountRoutes registers the EQ Score endpoint on r.
func (d *Deps) MountRoutes(r chi.Router) {
	middlewares := []func(http.Handler) http.Handler{
		apikeys.RequireScope(apikeys.ScopeWriteCampaigns),
	}
	if d.RateLimit != nil {
		middlewares = append(middlewares, d.RateLimit)
	}
	r.With(middlewares...).
		Post("/api/v1/deliverability/eq-score", d.Grade)
}

// scoreRequest is the caller-authored wire format.
// CampaignID and DraftLabel are optional persistence breadcrumbs —
// when present, the eq_score_history row carries them so the
// dashboard can group iterations per draft.
type scoreRequest struct {
	Subject    string `json:"subject"`
	HTML       string `json:"html"`
	Text       string `json:"text"`
	From       string `json:"from"`
	CampaignID string `json:"campaign_id,omitempty"`
	DraftLabel string `json:"draft_label,omitempty"`
}

const (
	eqScoreJSONMaxBodyBytes   int64 = 256 << 10
	eqScoreMaxSubjectBytes          = 998
	eqScoreMaxFromBytes             = 512
	eqScoreMaxDraftLabelBytes       = 160
)

// Grade serves POST /api/v1/deliverability/eq-score.
func (d *Deps) Grade(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in scoreRequest
	if err := httpbody.DecodeJSON(w, r, eqScoreJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if message := validateScoreRequest(in); message != "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("invalid_request", message))
		return
	}
	resolver := d.senderAuthResolver()
	if resolver == nil {
		httperror.WriteInternal(w, d.Logger, errors.New("eqscore: sender auth resolver is unavailable"), r.Context())
		return
	}
	auth, err := resolver.ResolveSenderAuth(r.Context(), t.ID, in.From)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	res, err := Score(
		r.Context(),
		AuthoritativeInput(in.Subject, in.HTML, in.Text, in.From, auth),
		t.ID,
		d.reputation(),
	)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if d.Pool != nil || d.PersistScore != nil {
		rec := HistoryRecord{
			TenantID:     t.ID,
			Score:        res.Score,
			Grade:        res.Grade,
			ContentScore: res.Content.Score,
			AuthScore:    res.Auth.Score,
			ReputationSc: subScoreOrSkipped(res),
			FromAddress:  in.From,
			CampaignID:   in.CampaignID,
			DraftLabel:   in.DraftLabel,
		}
		persist := d.PersistScore
		if persist == nil {
			persist = RecordScore
		}
		if err := persist(r.Context(), d.Pool, rec); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	observability.EQScoreGradesTotal.WithLabelValues(res.Grade).Inc()
	writeJSON(w, http.StatusOK, res)
}

func validateScoreRequest(in scoreRequest) string {
	if len(in.Subject) > eqScoreMaxSubjectBytes {
		return "subject is too long"
	}
	if len(in.From) > eqScoreMaxFromBytes {
		return "from is too long"
	}
	if _, valid := senderDomain(in.From); !valid {
		return "from must be a valid email address"
	}
	if len(in.DraftLabel) > eqScoreMaxDraftLabelBytes {
		return "draft_label is too long"
	}
	if campaignID := strings.TrimSpace(in.CampaignID); campaignID != "" {
		if _, err := uuid.Parse(campaignID); err != nil {
			return "campaign_id must be a valid UUID"
		}
	}
	return ""
}

func (d *Deps) senderAuthResolver() SenderAuthResolver {
	if d.SenderAuth != nil {
		return d.SenderAuth
	}
	if d.Pool == nil {
		return nil
	}
	return NewDBSenderAuthResolver(d.Pool)
}

func (d *Deps) reputation() Reputation {
	if d.Reputation != nil {
		return d.Reputation
	}
	if d.Pool == nil {
		return nil
	}
	return NewDBReputation(d.Pool)
}

// subScoreOrSkipped returns the reputation sub-score, or -1 (=
// "store NULL") when the sub-score was skipped (because the tenant
// had no history yet). The Skipped slice is the canonical signal —
// if "reputation" is present there, the score field is meaningless.
func subScoreOrSkipped(res Result) int {
	for _, s := range res.Skipped {
		if s == "reputation" {
			return -1
		}
	}
	return res.Reputation.Score
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
