package abtests

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles dependencies for the chi-mountable handlers.
// EditLeaseGuard refuses a write while ANOTHER editor holds the campaign.
//
// A port rather than a direct call because `campaigns` imports this package, so
// importing it back is a cycle. The implementation lives in campaigns and takes
// the request, which keeps "who is asking" as one definition — a second package
// deriving its own holder identity is how the same person gets locked out on one
// route and not another.
//
// Nil means unguarded, which is what every existing test and any composition
// that has not wired it gets. That is deliberate: the lease is advisory, and a
// missing wire must not make variants unwritable.
type EditLeaseGuard interface {
	AssertRequestEditable(r *http.Request, tenantID, campaignID string) error
}

type Deps struct {
	Repo *Repo

	// EditLease refuses variant writes while another editor holds the campaign.
	//
	// `campaign_variants` IS the delivered A/B content — sendloop resolves each
	// recipient's subject and body from it — so this route changes what people
	// receive just as directly as editing the campaign body, and it was outside
	// the lease that covers PATCH.
	EditLease EditLeaseGuard

	// WinnerDeps wires the winner picker to its outside-world
	// collaborators. When non-nil, EvaluateWinnerWithDeps is used so
	// reply_rate can read real reply counts from campaign_replies via
	// WinnerDeps.ReplyCounter; otherwise the picker falls back to the
	// engagement_proxy estimator embedded in winner.go.
	WinnerDeps *WinnerDeps

	// Logger is used by httperror.WriteInternal to record server-side
	// error context (tenant_id, request_id, err) without leaking the
	// raw error text to clients. May be nil in tests;
	// httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

const abTestJSONMaxBodyBytes int64 = 2 << 20 // 2 MiB

// MountRoutes registers the A/B routes on r. Caller must mount under a tenant
// middleware-scoped group.
func (d *Deps) MountRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/campaigns/{id}/variants", d.CreateVariants)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/variants", d.ListVariants)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/ab", d.GetAB)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/campaigns/{id}/ab/settings", d.SetSettings)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/campaigns/{id}/ab/evaluate", d.Evaluate)
	// Operator-facing reader: variant scores + significance + winner banner.
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/ab-results", d.ABResults)
	// G4 follow-up: bandit allocation-drift series for the results chart.
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/campaigns/{id}/ab-weight-history", d.ABWeightHistory)
}

// ABWeightHistory GET /api/v1/campaigns/{id}/ab-weight-history
func (d *Deps) ABWeightHistory(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	series, err := d.Repo.WeightHistory(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign_id": campaignID, "series": series})
}

type variantInput struct {
	VariantLabel string `json:"variant_label"`
	Subject      string `json:"subject"`
	FromName     string `json:"from_name"`
	// FromEmail varies the sender address. Empty = inherit campaign default.
	FromEmail string `json:"from_email,omitempty"`
	BodyMJML  string `json:"body_mjml"`
	BodyHTML  string `json:"body_html"`
	// SendTimeOffsetMinutes shifts this variant's dispatch relative
	// to the parent campaign's scheduled_at. 0 = send at parent's
	// scheduled time.
	SendTimeOffsetMinutes int     `json:"send_time_offset_minutes,omitempty"`
	Weight                float64 `json:"weight"`
}

type abView struct {
	Settings ABSettings      `json:"settings"`
	Variants []Variant       `json:"variants"`
	Results  []VariantResult `json:"results"`
	Winner   *string         `json:"winner_variant_id,omitempty"`
}

// CreateVariants POST /api/v1/campaigns/{id}/variants
func (d *Deps) CreateVariants(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")

	if d.EditLease != nil {
		if err := d.EditLease.AssertRequestEditable(r, t.ID, campaignID); err != nil {
			// 409, matching the PATCH refusal: the caller may edit this
			// campaign, just not while someone else is.
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": map[string]any{
					"code":    "edit_lease_held",
					"message": err.Error(),
				},
			})
			return
		}
	}

	var in []variantInput
	if err := httpbody.DecodeJSON(w, r, abTestJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in) < 1 || len(in) > 8 {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_count", "1-8 variants required"))
		return
	}
	variants := make([]Variant, 0, len(in))
	labels := make(map[string]struct{}, len(in))
	for _, v := range in {
		v.VariantLabel = strings.TrimSpace(v.VariantLabel)
		if v.VariantLabel == "" {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_label", "variant_label required"))
			return
		}
		if _, duplicate := labels[v.VariantLabel]; duplicate {
			writeJSON(w, http.StatusBadRequest, errEnv("duplicate_label", "variant labels must be unique"))
			return
		}
		labels[v.VariantLabel] = struct{}{}
		if v.Weight < 0 {
			v.Weight = 0
		}
		variants = append(variants, Variant{
			CampaignID:            campaignID,
			TenantID:              t.ID,
			VariantLabel:          v.VariantLabel,
			Subject:               v.Subject,
			FromName:              v.FromName,
			FromEmail:             v.FromEmail,
			BodyMJML:              v.BodyMJML,
			BodyHTML:              v.BodyHTML,
			SendTimeOffsetMinutes: v.SendTimeOffsetMinutes,
			Weight:                v.Weight,
		})
	}
	out, err := d.Repo.CreateVariants(r.Context(), t.ID, campaignID, variants)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// ListVariants GET /api/v1/campaigns/{id}/variants
func (d *Deps) ListVariants(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	out, err := d.Repo.ListVariants(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetAB GET /api/v1/campaigns/{id}/ab
func (d *Deps) GetAB(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")

	view := abView{}
	settings, err := d.Repo.GetSettings(r.Context(), t.ID, campaignID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	view.Settings = settings
	view.Winner = settings.WinningVariantID

	variants, err := d.Repo.ListVariants(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	view.Variants = variants

	results, err := d.Repo.ListResults(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	view.Results = results

	writeJSON(w, http.StatusOK, view)
}

// SetSettings POST /api/v1/campaigns/{id}/ab/settings
func (d *Deps) SetSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")

	var in struct {
		WinnerMetric          WinnerMetric `json:"winner_metric"`
		EvaluationWindowHours int          `json:"evaluation_window_hours"`
		WinnerRecipientsPct   float64      `json:"winner_recipients_pct"`
		// SamplePct enables Mailchimp-Premium-style mid-flight
		// auto-pick: when set < 100, only that fraction of the
		// audience runs through variants; the winner gets shipped
		// to the remaining (100-SamplePct)% once the sample phase
		// concludes. Default 100 (all-variants mode).
		SamplePct float64 `json:"sample_pct,omitempty"`
		// G4: bandit allocation knobs. Strategy "" => keep "fixed".
		BanditStrategy           string  `json:"bandit_strategy,omitempty"`
		ExploreFloor             float64 `json:"explore_floor,omitempty"`
		RecomputeIntervalMinutes int     `json:"recompute_interval_minutes,omitempty"`
	}
	if err := httpbody.DecodeJSON(w, r, abTestJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !in.WinnerMetric.Valid() {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_metric", "winner_metric must be open_rate|click_rate|reply_rate"))
		return
	}
	if in.EvaluationWindowHours <= 0 {
		in.EvaluationWindowHours = 24
	}
	if in.WinnerRecipientsPct < 0 || in.WinnerRecipientsPct > 100 {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_pct", "winner_recipients_pct must be 0..100"))
		return
	}
	if in.SamplePct == 0 {
		in.SamplePct = 100
	}
	if in.SamplePct < 1 || in.SamplePct > 100 {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_sample_pct", "sample_pct must be 1..100"))
		return
	}
	switch in.BanditStrategy {
	case "", "fixed", "thompson", "epsilon_greedy":
	default:
		writeJSON(w, http.StatusBadRequest, errEnv("bad_bandit_strategy",
			"bandit_strategy must be fixed|thompson|epsilon_greedy"))
		return
	}
	out, err := d.Repo.UpsertSettings(r.Context(), t.ID, campaignID, ABSettings{
		CampaignID:               campaignID,
		TenantID:                 t.ID,
		WinnerMetric:             in.WinnerMetric,
		EvaluationWindowHours:    in.EvaluationWindowHours,
		WinnerRecipientsPct:      in.WinnerRecipientsPct,
		SamplePct:                in.SamplePct,
		BanditStrategy:           in.BanditStrategy,
		ExploreFloor:             in.ExploreFloor,
		RecomputeIntervalMinutes: in.RecomputeIntervalMinutes,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Evaluate POST /api/v1/campaigns/{id}/ab/evaluate
func (d *Deps) Evaluate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")

	settings, err := d.Repo.GetSettings(r.Context(), t.ID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("no_settings", "configure A/B settings first"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	results, err := d.Repo.ListResults(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	variants, err := d.Repo.ListVariants(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// An operator-triggered evaluation spends the same budget the scheduler
	// does. Exempting it would leave the horizon fixed only for the worker,
	// while anyone unhappy with "no winner yet" could re-POST until noise
	// cleared the bar — which is precisely the behaviour the budget exists to
	// stop, and the more likely one, because a person does it on purpose.
	taken, err := d.Repo.RecordWinnerLook(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	budget := settings.LookBudget()
	budget.Taken = taken
	winnerID, decided := EvaluateWinnerWithDeps(context.Background(), d.WinnerDeps, campaignID, settings.WinnerMetric, results, budget)
	if decided {
		if err := d.Repo.MarkWinner(r.Context(), t.ID, campaignID, winnerID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if settings.SamplePct < 100 && settings.SampleEvaluatedAt == nil {
			if err := d.Repo.MarkSampleEvaluated(r.Context(), t.ID, campaignID); err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
		}
		// Re-read fresh results so the winner flag is reflected.
		results, err = d.Repo.ListResults(r.Context(), t.ID, campaignID)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	resp := abView{
		Settings: settings,
		Variants: variants,
		Results:  results,
	}
	if decided {
		resp.Winner = &winnerID
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- Operator-facing reader (GET /api/v1/campaigns/{id}/ab-results) ---

// abResultsResponse is the JSON shape returned by ABResults. The
// "frequentist" + "bayesian" maps are keyed "control_vs_<label>"
// where <label> is the challenger's variant_label (lowercased).
type abResultsResponse struct {
	CampaignID  string                  `json:"campaign_id"`
	Metric      WinnerMetric            `json:"metric"`
	Variants    []abResultVariant       `json:"variants"`
	Frequentist map[string]freqOutcome  `json:"frequentist"`
	Bayesian    map[string]bayesOutcome `json:"bayesian"`
	Bonferroni  bonferroniInfo          `json:"bonferroni"`
	Winner      *winnerOutcome          `json:"winner,omitempty"`
}

type abResultVariant struct {
	ID           string  `json:"id"`
	VariantIndex int     `json:"variant_index"`
	VariantLabel string  `json:"variant_label"`
	Subject      string  `json:"subject"`
	Sent         int     `json:"sent"`
	Hits         int     `json:"hits"`
	Rate         float64 `json:"rate"`
	IsControl    bool    `json:"is_control"`
}

type freqOutcome struct {
	ZScore                  float64 `json:"z_score"`
	PValue                  float64 `json:"p_value"`
	LiftPercent             float64 `json:"lift_percent"`
	SignificantAt95         bool    `json:"significant_at_95"`            // raw alpha=0.05
	SignificantAfterCorrect bool    `json:"significant_after_correction"` // Bonferroni-adjusted
}

type bayesOutcome struct {
	ProbBBetter        float64    `json:"prob_b_better"`
	ExpectedLift       float64    `json:"expected_lift"`
	CredibleInterval95 [2]float64 `json:"credible_interval_95"`
}

type bonferroniInfo struct {
	NumComparisons int     `json:"num_comparisons"`
	FamilyAlpha    float64 `json:"family_alpha"`
	CorrectedAlpha float64 `json:"corrected_alpha"`
	AppliedToFreq  bool    `json:"applied_to_frequentist"`
	Notes          string  `json:"notes,omitempty"`
}

type winnerOutcome struct {
	VariantIndex int     `json:"variant_index"`
	VariantID    string  `json:"variant_id"`
	Method       string  `json:"method"`     // "bayesian" | "frequentist" | "not_decided"
	Confidence   float64 `json:"confidence"` // 1-p for freq, P(B>A) for bayes
}

// ABResults GET /api/v1/campaigns/{id}/ab-results?metric=open_rate|click_rate|reply_rate
//
// Reads variant counts via the existing campaign_variant_results
// (Repo.ListResults) — opens/clicks live there, and reply_rate falls
// back to the engagement_proxy in winner.go consistent with
// Evaluate. Returns a per-variant rate table plus pairwise frequentist
// + Bayesian comparisons against the control (variant_index == 0).
func (d *Deps) ABResults(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")

	metric := WinnerMetric(r.URL.Query().Get("metric"))
	if metric == "" {
		metric = WinnerMetricOpenRate
	}
	if !metric.Valid() {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_metric", "metric must be open_rate|click_rate|reply_rate"))
		return
	}

	variants, err := d.Repo.ListVariants(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	results, err := d.Repo.ListResults(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Build a quick lookup from variant_id -> Variant so we can carry
	// the human label / subject into the response.
	subj := make(map[string]string, len(variants))
	label := make(map[string]string, len(variants))
	for _, v := range variants {
		subj[v.ID] = v.Subject
		label[v.ID] = v.VariantLabel
	}

	// reply_rate: re-use the same attribution logic as the picker so
	// the reader's hit counts agree with EvaluateWinner. nil
	// attribution falls back to engagement_proxy (matches winner.go).
	var attribution map[string]int
	if metric == WinnerMetricReplyRate && d.WinnerDeps != nil && d.WinnerDeps.ReplyCounter != nil {
		if total, err := d.WinnerDeps.ReplyCounter.CountForCampaign(r.Context(), t.ID, campaignID); err == nil {
			attribution = computeReplyAttribution(results, total)
		}
	}

	out := abResultsResponse{
		CampaignID:  campaignID,
		Metric:      metric,
		Variants:    make([]abResultVariant, 0, len(results)),
		Frequentist: map[string]freqOutcome{},
		Bayesian:    map[string]bayesOutcome{},
	}

	// First: per-variant aggregates. Variant 0 is the control by
	// convention (matches winner.go's "leader vs runner-up" logic).
	counts := make([]VariantCounts, len(results))
	for i, r := range results {
		hits := successes(r, metric, attribution)
		counts[i] = VariantCounts{Sent: r.RecipientsCount, Hits: hits}
		var ratePct float64
		if r.RecipientsCount > 0 {
			ratePct = float64(hits) / float64(r.RecipientsCount)
		}
		out.Variants = append(out.Variants, abResultVariant{
			ID:           r.VariantID,
			VariantIndex: i,
			VariantLabel: label[r.VariantID],
			Subject:      subj[r.VariantID],
			Sent:         r.RecipientsCount,
			Hits:         hits,
			Rate:         ratePct,
			IsControl:    i == 0,
		})
	}

	// Pairwise comparisons: every non-control variant against the
	// control. NumComparisons is len(results)-1 (the comparisons we
	// actually run); BonferroniAlpha shrinks the per-comparison alpha
	// accordingly so we don't inflate family-wise false-positive rate.
	numComparisons := len(results) - 1
	if numComparisons < 1 {
		numComparisons = 1
	}
	const familyAlpha = 0.05
	correctedAlpha := BonferroniAlpha(familyAlpha, numComparisons)
	out.Bonferroni = bonferroniInfo{
		NumComparisons: numComparisons,
		FamilyAlpha:    familyAlpha,
		CorrectedAlpha: correctedAlpha,
		AppliedToFreq:  numComparisons > 1,
		Notes: "Bonferroni divides family-wise alpha by the number of pairwise " +
			"comparisons (control vs each challenger). The `significant_at_95` " +
			"flag uses raw alpha=0.05; `significant_after_correction` uses the " +
			"corrected alpha and is the conservative decision.",
	}

	if len(results) >= 2 {
		bestProb := -1.0
		bestPVal := 1.1
		var winnerByBayes, winnerByFreq int
		winnerByBayes = -1
		winnerByFreq = -1

		for i := 1; i < len(results); i++ {
			key := comparisonKey(label[results[i].VariantID], i)

			// Frequentist
			f := TwoProportionTest(counts[0], counts[i])
			out.Frequentist[key] = freqOutcome{
				ZScore:                  f.ZScore,
				PValue:                  f.PValue,
				LiftPercent:             f.LiftPercent,
				SignificantAt95:         f.PValue < familyAlpha && f.ZScore > 0,
				SignificantAfterCorrect: f.PValue < correctedAlpha && f.ZScore > 0,
			}

			// Bayesian — production uses fresh randomness per call.
			b := BayesianPosterior(counts[0], counts[i])
			out.Bayesian[key] = bayesOutcome{
				ProbBBetter:        b.ProbBBetter,
				ExpectedLift:       b.ExpectedLift,
				CredibleInterval95: b.CredibleInterval95,
			}

			if b.ProbBBetter > bestProb {
				bestProb = b.ProbBBetter
				winnerByBayes = i
			}
			if f.PValue < bestPVal && f.ZScore > 0 {
				bestPVal = f.PValue
				winnerByFreq = i
			}
		}

		// Pick a winner: Bayesian P(B>A) > 0.95 wins first; else
		// Bonferroni-corrected frequentist; else "not decided".
		switch {
		case winnerByBayes >= 0 && bestProb >= 0.95:
			out.Winner = &winnerOutcome{
				VariantIndex: winnerByBayes,
				VariantID:    results[winnerByBayes].VariantID,
				Method:       "bayesian",
				Confidence:   bestProb,
			}
		case winnerByFreq >= 0 && bestPVal < correctedAlpha:
			out.Winner = &winnerOutcome{
				VariantIndex: winnerByFreq,
				VariantID:    results[winnerByFreq].VariantID,
				Method:       "frequentist",
				Confidence:   1 - bestPVal,
			}
		default:
			out.Winner = &winnerOutcome{
				VariantIndex: -1,
				Method:       "not_decided",
				Confidence:   0,
			}
		}
	}

	writeJSON(w, http.StatusOK, out)
}

// comparisonKey returns the JSON map key for a control-vs-challenger
// pair. Falls back to "control_vs_<index>" when the variant has no
// label so the response is always greppable.
func comparisonKey(label string, idx int) string {
	if label == "" {
		return "control_vs_" + itoaSimple(idx)
	}
	return "control_vs_" + label
}

func itoaSimple(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// --- helpers (mirrors forms.writeJSON / errEnv pattern) ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": msg}}
}
