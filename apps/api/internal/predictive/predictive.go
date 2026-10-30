package predictive

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

type Prediction struct {
	Email                    string         `json:"email"`
	SubscriberID             string         `json:"subscriber_id,omitempty"`
	HistoricCLVCents         int            `json:"historic_clv_cents"`
	PredictedCLVCents        int            `json:"predicted_clv_cents"`
	TotalCLVCents            int            `json:"total_clv_cents"`
	ChurnRisk                float64        `json:"churn_risk"`
	PredictedOrderCount      float64        `json:"predicted_order_count"`
	AverageDaysBetweenOrders *float64       `json:"average_days_between_orders,omitempty"`
	ExpectedNextOrderAt      *time.Time     `json:"expected_next_order_at,omitempty"`
	PredictedGender          string         `json:"predicted_gender"`
	Confidence               float64        `json:"confidence"`
	DataSufficiency          string         `json:"data_sufficiency"`
	Explanation              map[string]any `json:"explanation,omitempty"`
	// ChurnDrivers is the SUB-060 ranked, human-readable "why is this
	// profile at risk?" list (migration 0912). Up to 3 entries, highest
	// impact first, computed during the model run from recency,
	// frequency-cadence, and soft-bounce signals. Stored as jsonb on
	// profile_predictions.churn_drivers and surfaced verbatim on
	// GET /api/v1/predictive/profiles/{email}. Empty slice when no driver
	// crosses the salience floor (a healthy / data-poor profile).
	ChurnDrivers []ChurnDriver `json:"churn_drivers"`
	CalculatedAt time.Time     `json:"calculated_at,omitempty"`
}

// ChurnDriver is one explainable contributor to a churn prediction
// (SUB-060). Impact is a coarse "high" | "medium" | "low" band so the UI
// can render a colour-coded chip without re-deriving thresholds.
type ChurnDriver struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Value  string `json:"value"`
	Impact string `json:"impact"`
}

type RFMScore struct {
	Email          string    `json:"email"`
	SubscriberID   string    `json:"subscriber_id,omitempty"`
	RecencyDays    *int      `json:"recency_days,omitempty"`
	Frequency      int       `json:"frequency"`
	MonetaryCents  int       `json:"monetary_cents"`
	RecencyScore   int       `json:"recency_score"`
	FrequencyScore int       `json:"frequency_score"`
	MonetaryScore  int       `json:"monetary_score"`
	RFMScore       string    `json:"rfm_score"`
	SegmentKey     string    `json:"segment_key"`
	CalculatedAt   time.Time `json:"calculated_at,omitempty"`
}

type ModelRun struct {
	ID                   string         `json:"id"`
	TenantID             string         `json:"tenant_id"`
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

type ProfileSignals struct {
	Email            string
	SubscriberID     string
	HistoricCLVCents int
	OrderCount       int
	FirstOrderAt     *time.Time
	LastOrderAt      *time.Time
	ChurnScore       *int
	// SoftBounces30d is the SUB-060 soft-bounce count in the trailing 30
	// days, feeding the "soft-bounce trend" churn driver. Optional: zero
	// (the default for callers that don't populate it) yields no
	// soft-bounce driver rather than a false-negative-free signal.
	SoftBounces30d int
}

type RunResult struct {
	Run         ModelRun `json:"run"`
	Predictions int      `json:"predictions"`
	RFMScores   int      `json:"rfm_scores"`
}

func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	readProfiles := apikeys.RequireAllScopes(
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/predictive/catalog", d.Catalog)
	// Profile predictions and CLV previews carry email addresses and stable
	// subscriber identifiers. Report access alone may read aggregate model
	// health, but recipient-linked facts require the subscriber-read scope too.
	r.With(readProfiles).Get("/api/v1/predictive/profiles", d.ListProfiles)
	r.With(readProfiles).Get("/api/v1/predictive/profiles/{email}", d.GetProfile)
	r.With(read).Get("/api/v1/predictive/rfm/segments", d.RFMSegments)
	r.With(read).Get("/api/v1/predictive/data-sufficiency", d.DataSufficiency)
	r.With(readProfiles).Get("/api/v1/clv-dashboard", d.CLVDashboard)
	r.With(admin).Post("/api/v1/predictive/recompute", d.Recompute)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "klv07.predictive.v1",
		"models": []map[string]any{
			{"key": "clv", "label": "Customer lifetime value", "runtime_status": "supported", "version": "heuristic-v1"},
			{"key": "rfm", "label": "RFM score", "runtime_status": "supported", "version": "heuristic-v1"},
			{"key": "churn", "label": "Churn risk", "runtime_status": "partial", "version": "existing-subscriber-churn-score"},
			{"key": "peer_benchmarks", "label": "Peer and industry benchmarks", "runtime_status": "partial", "version": "dashboard-benchmark-cache"},
		},
		"rfm_segments": rfmSegmentCatalog(),
	})
}

func (d *Deps) ListProfiles(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().ListProfiles(r.Context(), tenantID, r.URL.Query().Get("segment"), intParam(r, "limit", 100))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) GetProfile(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().GetProfile(r.Context(), tenantID, chi.URLParam(r, "email"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RFMSegments(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().RFMSegments(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CLVDashboard GET /api/v1/clv-dashboard returns aggregated predicted-CLV
// distribution stats (percentiles, value tiers, top + at-risk profile
// previews) over the current snapshot — SUB-127. The aggregation runs in
// Postgres so the frontend never scans the full profile set.
func (d *Deps) CLVDashboard(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().GetCLVDistribution(r.Context(), tenantID, intParam(r, "preview_limit", 10))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DataSufficiency GET /api/v1/predictive/data-sufficiency returns the
// tenant-wide rollup of which predictions are reliable per profile bucket
// (SUB-129): { insufficient: {count, percentage}, limited: {...},
// sufficient: {...}, total, last_updated }. Reads the rollup table populated
// during recompute; absent rollup (no recompute yet) yields a zeroed report.
func (d *Deps) DataSufficiency(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().GetDataSufficiency(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Recompute(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().Recompute(r.Context(), tenantID, 365)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func ComputePrediction(signal ProfileSignals, now time.Time) Prediction {
	email := strings.TrimSpace(strings.ToLower(signal.Email))
	churnScore := 0
	if signal.ChurnScore != nil {
		churnScore = *signal.ChurnScore
	}
	avgDays := averageDaysBetweenOrders(signal.OrderCount, signal.FirstOrderAt, signal.LastOrderAt)
	predictedOrders := predictedOrders(signal.OrderCount, avgDays, churnScore)
	predictedCLV := 0
	if signal.OrderCount > 0 {
		avgOrderValue := float64(signal.HistoricCLVCents) / float64(signal.OrderCount)
		predictedCLV = int(math.Round(avgOrderValue * predictedOrders))
	}
	confidence := predictionConfidence(signal.OrderCount)
	dataSufficiency := dataSufficiency(signal.OrderCount)
	var expectedNext *time.Time
	if avgDays != nil && signal.LastOrderAt != nil {
		next := signal.LastOrderAt.Add(time.Duration(*avgDays*24) * time.Hour)
		if next.Before(now) {
			next = now.Add(time.Duration(math.Max(1, *avgDays/2)*24) * time.Hour)
		}
		expectedNext = &next
	}
	churnRisk := clamp01(float64(churnScore) / 100)
	drivers := computeChurnDrivers(signal, avgDays, now)
	return Prediction{
		Email:                    email,
		SubscriberID:             signal.SubscriberID,
		HistoricCLVCents:         signal.HistoricCLVCents,
		PredictedCLVCents:        predictedCLV,
		TotalCLVCents:            signal.HistoricCLVCents + predictedCLV,
		ChurnRisk:                churnRisk,
		PredictedOrderCount:      predictedOrders,
		AverageDaysBetweenOrders: avgDays,
		ExpectedNextOrderAt:      expectedNext,
		PredictedGender:          "unknown",
		Confidence:               confidence,
		DataSufficiency:          dataSufficiency,
		Explanation: map[string]any{
			"order_count":        signal.OrderCount,
			"historic_clv_cents": signal.HistoricCLVCents,
			"churn_score":        churnScore,
			"model":              clvModelHeuristic,
			"data_sufficiency":   dataSufficiency,
		},
		ChurnDrivers: drivers,
		CalculatedAt: now,
	}
}

// computeChurnDrivers ranks the top-3 explainable churn drivers (SUB-060)
// from the same signals the heuristic already has. Order is highest-impact
// first so the UI can render the leading driver without expanding. Drivers
// that don't apply (no recency, single order, no soft bounces) are dropped
// rather than shown with a misleading "low" impact. Returns at most 3 entries.
//
// Pure + deterministic given (signal, avgDays, now) — the unit of test
// coverage for the driver extraction.
func computeChurnDrivers(signal ProfileSignals, avgDays *float64, now time.Time) []ChurnDriver {
	out := []ChurnDriver{}

	// Recency: days since last order vs. the profile's own cadence. The
	// further past one cadence-interval, the higher the impact band.
	if rd := recencyDays(signal.LastOrderAt, now); rd != nil {
		var impact string
		switch {
		case avgDays != nil && *avgDays > 0:
			ratio := float64(*rd) / *avgDays
			switch {
			case ratio >= 2:
				impact = "high"
			case ratio >= 1:
				impact = "medium"
			default:
				impact = "low"
			}
		default:
			// No cadence yet — fall back to absolute recency bands aligned
			// with the engagement-churn model edges.
			switch {
			case *rd > engagementBandAtRiskDays:
				impact = "high"
			case *rd > engagementBandRecentDays:
				impact = "medium"
			default:
				impact = "low"
			}
		}
		out = append(out, ChurnDriver{
			Key:    "recency",
			Label:  "Days since last order",
			Value:  fmt.Sprintf("%d", *rd),
			Impact: impact,
		})
	}

	// Frequency-cadence trend: a long average gap between orders signals a
	// slowing buyer. Only meaningful with ≥2 orders (avgDays is nil otherwise).
	if avgDays != nil && *avgDays > 0 {
		var impact, value string
		switch {
		case *avgDays >= 120:
			impact, value = "high", "slowing"
		case *avgDays >= 60:
			impact, value = "medium", "slowing"
		default:
			impact, value = "low", "steady"
		}
		out = append(out, ChurnDriver{
			Key:    "frequency_trend",
			Label:  "Order cadence",
			Value:  fmt.Sprintf("%s (~%.0fd between orders)", value, *avgDays),
			Impact: impact,
		})
	}

	// Soft-bounce trend: repeated soft bounces in the trailing window are an
	// early deliverability-decay churn signal. Only surfaced when present.
	if signal.SoftBounces30d > 0 {
		var impact string
		switch {
		case signal.SoftBounces30d >= 5:
			impact = "high"
		case signal.SoftBounces30d >= 2:
			impact = "medium"
		default:
			impact = "low"
		}
		out = append(out, ChurnDriver{
			Key:    "soft_bounce_trend",
			Label:  "Soft-bounce trend",
			Value:  fmt.Sprintf("%d in last 30d", signal.SoftBounces30d),
			Impact: impact,
		})
	}

	sortChurnDriversByImpactDesc(out)
	if len(out) > 3 {
		out = out[:3]
	}
	return out
}

// impactRank maps the coarse impact band to a sortable weight.
func impactRank(impact string) int {
	switch impact {
	case "high":
		return 3
	case "medium":
		return 2
	default:
		return 1
	}
}

// sortChurnDriversByImpactDesc orders highest-impact first, preserving the
// stable insertion order (recency → cadence → soft-bounce) within a tie so
// the recency driver leads when impacts are equal. Insertion sort is fine —
// the slice is at most 3 entries.
func sortChurnDriversByImpactDesc(rows []ChurnDriver) {
	for i := 1; i < len(rows); i++ {
		j := i
		for j > 0 && impactRank(rows[j-1].Impact) < impactRank(rows[j].Impact) {
			rows[j-1], rows[j] = rows[j], rows[j-1]
			j--
		}
	}
}

func ComputeRFMScores(signals []ProfileSignals, now time.Time) []RFMScore {
	out := make([]RFMScore, 0, len(signals))
	frequencies := make([]int, 0, len(signals))
	monetary := make([]int, 0, len(signals))
	for _, signal := range signals {
		frequencies = append(frequencies, signal.OrderCount)
		monetary = append(monetary, signal.HistoricCLVCents)
	}
	for _, signal := range signals {
		recencyDays := recencyDays(signal.LastOrderAt, now)
		recencyScore := scoreRecency(recencyDays)
		frequencyScore := scoreByRank(signal.OrderCount, frequencies)
		monetaryScore := scoreByRank(signal.HistoricCLVCents, monetary)
		rfm := RFMScore{
			Email:          strings.TrimSpace(strings.ToLower(signal.Email)),
			SubscriberID:   signal.SubscriberID,
			RecencyDays:    recencyDays,
			Frequency:      signal.OrderCount,
			MonetaryCents:  signal.HistoricCLVCents,
			RecencyScore:   recencyScore,
			FrequencyScore: frequencyScore,
			MonetaryScore:  monetaryScore,
			CalculatedAt:   now,
		}
		rfm.RFMScore = fmtRFM(recencyScore, frequencyScore, monetaryScore)
		rfm.SegmentKey = rfmSegment(recencyScore, frequencyScore, monetaryScore, signal.OrderCount)
		out = append(out, rfm)
	}
	return out
}

func averageDaysBetweenOrders(orderCount int, first, last *time.Time) *float64 {
	if orderCount < 2 || first == nil || last == nil || !last.After(*first) {
		return nil
	}
	value := last.Sub(*first).Hours() / 24 / float64(orderCount-1)
	return &value
}

func predictedOrders(orderCount int, avgDays *float64, churnScore int) float64 {
	if orderCount <= 0 || avgDays == nil || *avgDays <= 0 {
		return 0
	}
	base := 365 / *avgDays
	retention := 1 - clamp01(float64(churnScore)/100)
	return math.Round(base*retention*100) / 100
}

func predictionConfidence(orderCount int) float64 {
	switch {
	case orderCount >= 5:
		return 0.85
	case orderCount >= 3:
		return 0.65
	case orderCount >= 2:
		return 0.45
	case orderCount == 1:
		return 0.25
	default:
		return 0.1
	}
}

func dataSufficiency(orderCount int) string {
	switch {
	case orderCount >= 3:
		return "sufficient"
	case orderCount >= 1:
		return "limited"
	default:
		return "insufficient"
	}
}

func recencyDays(last *time.Time, now time.Time) *int {
	if last == nil {
		return nil
	}
	days := int(now.Sub(*last).Hours() / 24)
	if days < 0 {
		days = 0
	}
	return &days
}

func scoreRecency(days *int) int {
	if days == nil {
		return 1
	}
	switch {
	case *days <= 14:
		return 5
	case *days <= 30:
		return 4
	case *days <= 60:
		return 3
	case *days <= 120:
		return 2
	default:
		return 1
	}
}

func scoreByRank(value int, population []int) int {
	if len(population) == 0 {
		return 1
	}
	sorted := append([]int(nil), population...)
	sort.Ints(sorted)
	lessOrEqual := 0
	for _, item := range sorted {
		if item <= value {
			lessOrEqual++
		}
	}
	pct := float64(lessOrEqual) / float64(len(sorted))
	switch {
	case pct >= 0.8:
		return 5
	case pct >= 0.6:
		return 4
	case pct >= 0.4:
		return 3
	case pct >= 0.2:
		return 2
	default:
		return 1
	}
}

func rfmSegment(r, f, m, orders int) string {
	if orders == 0 {
		return "insufficient_data"
	}
	if r >= 4 && f >= 4 && m >= 4 {
		return "champions"
	}
	if r >= 4 && f >= 3 {
		return "loyal_customers"
	}
	if r <= 2 && f >= 4 && m >= 4 {
		return "at_risk_high_value"
	}
	if r <= 2 {
		return "hibernating"
	}
	if f <= 2 && m <= 2 {
		return "new_or_low_value"
	}
	return "needs_attention"
}

func rfmSegmentCatalog() []map[string]string {
	return []map[string]string{
		{"key": "champions", "label": "Champions"},
		{"key": "loyal_customers", "label": "Loyal customers"},
		{"key": "at_risk_high_value", "label": "At-risk high value"},
		{"key": "needs_attention", "label": "Needs attention"},
		{"key": "new_or_low_value", "label": "New or low value"},
		{"key": "hibernating", "label": "Hibernating"},
		{"key": "insufficient_data", "label": "Insufficient data"},
	}
}

func fmtRFM(r, f, m int) string {
	return fmt.Sprintf("%d%d%d", r, f, m)
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func tenantID(r *http.Request) (string, bool) {
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

func (d *Deps) repo() *Repo {
	if d == nil {
		return nil
	}
	return d.Repo
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
