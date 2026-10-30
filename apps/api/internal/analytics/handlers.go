package analytics

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles the chi-mountable analytics handlers.
type ExtendedDeps struct {
	Service *Service
	Logger  *slog.Logger
	// HumanEngagementEnabled mirrors Repo.HumanEngagementEnabled
	// (POSTWAVE_HUMAN_ENGAGEMENT). Gates the bot-stripped human-open path
	// in the engagement panel; passed through to Service.EngagementPanel.
	HumanEngagementEnabled bool
}

// New constructs a Deps from a pgx pool.
func NewExtended(pool *db.Pool) *ExtendedDeps {
	return &ExtendedDeps{Service: NewService(pool)}
}

// NewExtendedWithLogger constructs an ExtendedDeps with a logger for
// structured internal-error logging via httperror.WriteInternal.
func NewExtendedWithLogger(pool *db.Pool, logger *slog.Logger) *ExtendedDeps {
	return &ExtendedDeps{Service: NewService(pool), Logger: logger}
}

// MountRoutes registers the analytics routes on r. Caller must mount under
// the tenant middleware-scoped group.
func (d *ExtendedDeps) MountRoutes(r chi.Router) {
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	readRecipientReports := apikeys.RequireAllScopes(
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	readCampaignRecipientReports := apikeys.RequireAllScopes(
		apikeys.ScopeReadCampaigns,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)

	r.With(readReports).Get("/api/v1/campaigns/{id}/link-report", d.LinkReport)
	r.With(readCampaignRecipientReports).Get("/api/v1/campaigns/{id}/report.csv", d.ReportCSV)
	r.With(readReports).Get("/api/v1/campaigns/{id}/geography", d.Geography)
	r.With(readReports).Get("/api/v1/campaigns/{id}/devices", d.Devices)
	r.With(readReports).Get("/api/v1/campaigns/{id}/bounces", d.Bounces)
	r.With(readReports).Get("/api/v1/campaigns/{id}/revenue", d.Revenue)
	r.With(readReports).Get("/api/v1/analytics/campaigns/compare", d.Compare)
	r.With(readReports).Get("/api/v1/analytics/cohorts", d.Cohorts)
	r.With(readReports).Get("/api/v1/analytics/subscribers/funnel", d.SubscriberFunnel)
	r.With(readReports).Get("/api/v1/analytics/subscribers/timeseries", d.SubscriberTimeseries)
	r.With(readReports).Get("/api/v1/analytics/timeseries", d.GroupedTimeseries)
	r.With(readReports).Get("/api/v1/analytics/template-leaderboard", d.TemplateLeaderboardHandler)
	r.With(readReports).Get("/api/v1/analytics/fatigue", d.FatigueHandler)
	r.With(readReports).Get("/api/v1/campaigns/{id}/engagement", d.EngagementPanel)
	r.With(readRecipientReports).Get("/api/v1/subscribers/{id}/cross-channel-timeline", d.CrossChannelTimelineHandler)
}

// EngagementPanel GET /api/v1/campaigns/{id}/engagement — Surfacing
// Analytics (#3): MPP-stripped human open rate + reply rate +
// open-decoupled conversions (trust signals) plus an explicitly-estimated
// AI-surfacing score. Mirrors the d.Revenue handler.
func (d *ExtendedDeps) EngagementPanel(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	filter, ok := classificationFilterFromRequest(w, r)
	if !ok {
		return
	}
	out, err := d.Service.EngagementPanel(
		r.Context(), t.ID, chi.URLParam(r, "id"), d.HumanEngagementEnabled, filter)
	if err != nil {
		if writeCampaignReadNotFound(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// GroupedTimeseries GET /api/v1/analytics/timeseries?group_by=campaign|domain&metric=opens|clicks|bounces&days=30
//
// A19 (desktop audit 2026-06-10): per-group daily time series so the
// GroupByMenu dimensions can render real per-group charts. Groups are
// capped at the top-10 by volume plus an "other" rollup.
//
// group_by=list is recognized but rejected with a structured 400
// (code "unsupported_dimension"): campaign_report_events carries no
// per-event list attribution (campaign<->list is a many-to-many owned
// by the engine), so serving it would require new attribution data.
func (d *ExtendedDeps) GroupedTimeseries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	q := r.URL.Query()
	groupBy := strings.ToLower(strings.TrimSpace(q.Get("group_by")))
	switch groupBy {
	case "campaign", "domain":
		// supported
	case "list":
		writeErr(w, http.StatusBadRequest, "unsupported_dimension",
			"group_by=list needs per-event list attribution the events table does not carry; supported: campaign, domain")
		return
	default:
		writeErr(w, http.StatusBadRequest, "bad_group_by",
			"group_by must be one of campaign, domain")
		return
	}
	metric := strings.ToLower(strings.TrimSpace(q.Get("metric")))
	if metric == "" {
		metric = "opens"
	}
	if _, ok := groupedTimeseriesMetrics[metric]; !ok {
		writeErr(w, http.StatusBadRequest, "bad_metric",
			"metric must be one of opens, clicks, bounces")
		return
	}
	var days int
	if raw := strings.TrimSpace(q.Get("days")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeErr(w, http.StatusBadRequest, "bad_days", "days must be a positive integer")
			return
		}
		days = n
	}
	filter, ok := classificationFilterFromRequest(w, r)
	if !ok {
		return
	}
	series, err := d.Service.GroupedTimeseries(r.Context(), t.ID, groupBy, metric, days, filter)
	if err != nil {
		// The one producer-side rejection this endpoint can raise: an
		// engagement band asked of bounces. Surfaced as a 400 rather than a 500
		// because the request is answerable-in-principle-looking but has no
		// meaning — and as an empty 200 it would be read as "no bounces".
		if errors.Is(err, ErrUnsupportedClassification) {
			writeErr(w, http.StatusBadRequest, "classification_not_applicable",
				"metric=bounces carries no engagement classification; classification filters apply to opens and clicks")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{
		"series":                series,
		"classification_filter": filter.Wire(),
	})
}

// classificationFilterFromRequest parses ?classification= and writes the 400 on
// a value outside the closed set.
//
// Rejecting is the point. A typo silently downgraded to "no filter" hands back
// the blended number to a caller who believes it is filtered, which is the
// F01 failure this whole feature exists to end — except now with the customer
// certain they had asked for something better.
func classificationFilterFromRequest(w http.ResponseWriter, r *http.Request) (ClassificationFilter, bool) {
	filter, err := ParseClassificationFilter(r.URL.Query().Get("classification"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_classification",
			"classification must be one of human, machine, unknown (omit for all)")
		return ClassificationAll, false
	}
	return filter, true
}

// LinkReport GET /api/v1/campaigns/{id}/link-report
func (d *ExtendedDeps) LinkReport(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	filter, ok := classificationFilterFromRequest(w, r)
	if !ok {
		return
	}
	out, err := d.Service.LinkReport(r.Context(), t.ID, chi.URLParam(r, "id"), filter)
	if err != nil {
		if writeCampaignReadNotFound(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// SubscriberTimeseries GET /api/v1/analytics/subscribers/timeseries?range=7d|30d|90d
func (d *ExtendedDeps) SubscriberTimeseries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	rangeParam := strings.TrimSpace(r.URL.Query().Get("range"))
	if rangeParam == "" {
		rangeParam = "30d"
	}
	var days int
	switch rangeParam {
	case "7d":
		days = 7
	case "30d":
		days = 30
	case "90d":
		days = 90
	default:
		writeErr(w, http.StatusBadRequest, "bad_range", "range must be one of 7d, 30d, 90d")
		return
	}
	points, err := d.Service.SubscriberTimeseries(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{
		"range":  rangeParam,
		"points": points,
	})
}

// ReportCSV GET /api/v1/campaigns/{id}/report.csv
//
// The body is capped at 10 MiB and 50,000 rows. When more rows exist, a
// X-Postwave-Truncated header surfaces the total so callers can paginate via
// ?offset/limit. The database count and page are read from one repeatable
// snapshot; the complete CSV is encoded before response headers are committed,
// so query/scan/CSV-encoding errors never produce a partial successful export.
func (d *ExtendedDeps) ReportCSV(w http.ResponseWriter, r *http.Request) {
	// Recipient-linked exports and their error envelopes are never shared or
	// cached, including validation/404/500 paths that return before the CSV
	// success headers below.
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, err := csvPageInt(r, "limit", campaignReportCSVMaxRows)
	if err != nil || limit <= 0 || limit > campaignReportCSVMaxRows {
		writeErr(w, http.StatusBadRequest, "bad_limit",
			fmt.Sprintf("limit must be an integer between 1 and %d", campaignReportCSVMaxRows))
		return
	}
	offset, err := csvPageInt(r, "offset", 0)
	if err != nil || offset < 0 {
		writeErr(w, http.StatusBadRequest, "bad_offset", "offset must be a non-negative integer")
		return
	}

	rows, total, err := d.Service.ReportRows(r.Context(), t.ID, chi.URLParam(r, "id"), limit, offset)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	body := &cappedCSVBuffer{limit: campaignReportCSVMaxBytes}
	if err := encodeCampaignReportCSV(body, rows); err != nil {
		if errors.Is(err, errCampaignReportCSVTooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge, "export_too_large",
				"encoded report exceeds 10 MiB; request a smaller limit")
			return
		}
		httperror.WriteInternal(w, d.Logger, fmt.Errorf("encode campaign report CSV: %w", err), r.Context())
		return
	}
	if body.Len() > campaignReportCSVMaxBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "export_too_large",
			"encoded report exceeds 10 MiB; request a smaller limit")
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="campaign-report.csv"`)
	w.Header().Set("X-Postwave-Max-Rows", strconv.Itoa(campaignReportCSVMaxRows))
	w.Header().Set("X-Postwave-Total-Rows", strconv.Itoa(total))
	w.Header().Set("X-Postwave-Returned-Rows", strconv.Itoa(len(rows)))
	w.Header().Set("X-Postwave-Offset", strconv.Itoa(offset))
	w.Header().Set("Content-Length", strconv.Itoa(body.Len()))
	w.Header().Set("X-Postwave-Truncated",
		strconv.FormatBool(total > offset+len(rows)))
	if _, err := w.Write(body.Bytes()); err != nil {
		// The response is fully encoded before this point. A transport write
		// failure cannot be converted into another HTTP response, but it must
		// never be silently discarded.
		logger := d.Logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.ErrorContext(r.Context(), "write campaign report CSV", "err", err)
	}
}

const (
	campaignReportCSVMaxRows  = 50000
	campaignReportCSVMaxBytes = 10 << 20
)

var errCampaignReportCSVTooLarge = errors.New("campaign report CSV exceeds encoded byte limit")

type cappedCSVBuffer struct {
	bytes.Buffer
	limit int
}

func (b *cappedCSVBuffer) Write(p []byte) (int, error) {
	if b.limit >= 0 && len(p) > b.limit-b.Len() {
		return 0, errCampaignReportCSVTooLarge
	}
	return b.Buffer.Write(p)
}

func csvPageInt(r *http.Request, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback, nil
	}
	return strconv.Atoi(raw)
}

func encodeCampaignReportCSV(dst io.Writer, rows []CSVReportRow) error {
	cw := csv.NewWriter(dst)
	if err := cw.Write([]string{
		"subscriber_email", "sent_at", "delivered_at", "opened_at",
		"first_click_at", "click_count", "bounced_at", "complained_at",
		"unsubscribed_at",
	}); err != nil {
		return err
	}
	for _, row := range rows {
		if err := cw.Write([]string{
			csvCell(row.SubscriberEmail),
			fmtTime(row.SentAt),
			fmtTime(row.DeliveredAt),
			fmtTime(row.OpenedAt),
			fmtTime(row.FirstClickAt),
			strconv.Itoa(row.ClickCount),
			fmtTime(row.BouncedAt),
			fmtTime(row.ComplainedAt),
			fmtTime(row.UnsubscribedAt),
		}); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

func csvCell(value string) string {
	visible := strings.TrimLeft(value, " \t\r\n")
	if visible == "" {
		return value
	}
	switch visible[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}

// Compare GET /api/v1/analytics/campaigns/compare?ids=a,b,c
func (d *ExtendedDeps) Compare(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("ids"))
	if raw == "" {
		writeErr(w, http.StatusBadRequest, "missing_ids", "ids query param required")
		return
	}
	parts := strings.Split(raw, ",")
	ids := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			ids = append(ids, v)
		}
	}
	if len(ids) == 0 {
		writeErr(w, http.StatusBadRequest, "missing_ids", "ids query param required")
		return
	}
	if len(ids) > 25 {
		writeErr(w, http.StatusBadRequest, "too_many_ids", "compare accepts up to 25 ids")
		return
	}
	filter, ok := classificationFilterFromRequest(w, r)
	if !ok {
		return
	}
	out, err := d.Service.Compare(r.Context(), t.ID, ids, filter)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// Geography GET /api/v1/campaigns/{id}/geography
func (d *ExtendedDeps) Geography(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	filter, ok := classificationFilterFromRequest(w, r)
	if !ok {
		return
	}
	out, err := d.Service.Geography(r.Context(), t.ID, chi.URLParam(r, "id"), filter)
	if err != nil {
		if writeCampaignReadNotFound(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// Devices GET /api/v1/campaigns/{id}/devices
func (d *ExtendedDeps) Devices(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	filter, ok := classificationFilterFromRequest(w, r)
	if !ok {
		return
	}
	out, err := d.Service.Devices(r.Context(), t.ID, chi.URLParam(r, "id"), filter)
	if err != nil {
		if writeCampaignReadNotFound(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// Bounces GET /api/v1/campaigns/{id}/bounces
func (d *ExtendedDeps) Bounces(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Service.Bounces(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if writeCampaignReadNotFound(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// Cohorts GET /api/v1/analytics/cohorts?bucket=month&metric=open_rate
func (d *ExtendedDeps) Cohorts(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	bucket := r.URL.Query().Get("bucket")
	metric := r.URL.Query().Get("metric")
	weeks, _ := strconv.Atoi(r.URL.Query().Get("weeks"))
	out, err := d.Service.Cohorts(r.Context(), t.ID, bucket, metric, weeks)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// SubscriberFunnel GET /api/v1/analytics/subscribers/funnel
//
// SUB-128: cohort funnel analysis on subscribers — signup → first-purchase →
// repeat-purchase, bucketed by signup-month cohort. Query params:
//
//	cohort_by=created_at_month  (only supported value)
//	bucket=month                (only supported value)
//	weeks=12                    (number of trailing cohorts, max 24)
//	audience_id=<tag>           (optional: scope to a tagged audience)
//
// Returns { bucket, cohort_by, steps[], cohorts[] }: the aggregate stage
// roll-up plus the per-cohort breakdown (CohortFunnelRow).
func (d *ExtendedDeps) SubscriberFunnel(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	q := r.URL.Query()
	bucket := strings.TrimSpace(q.Get("bucket"))
	cohortBy := strings.TrimSpace(q.Get("cohort_by"))
	audienceID := strings.TrimSpace(q.Get("audience_id"))
	weeks, _ := strconv.Atoi(strings.TrimSpace(q.Get("weeks")))
	out, err := d.Service.SubscriberFunnel(r.Context(), t.ID, bucket, cohortBy, audienceID, weeks)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

// Revenue GET /api/v1/campaigns/{id}/revenue
func (d *ExtendedDeps) Revenue(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Service.Revenue(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if writeCampaignReadNotFound(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, out)
}

func writeJSONResp(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSONResp(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

func writeCampaignReadNotFound(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	writeErr(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
	return true
}

func fmtTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
