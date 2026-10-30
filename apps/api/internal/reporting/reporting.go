package reporting

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

const reportingJSONMaxBodyBytes int64 = 1 << 20

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

type MetricDefinition struct {
	Key           string   `json:"key"`
	Label         string   `json:"label"`
	ProductArea   string   `json:"product_area"`
	Source        string   `json:"source"`
	Aggregation   string   `json:"aggregation"`
	ValueType     string   `json:"value_type"`
	Dimensions    []string `json:"dimensions,omitempty"`
	RuntimeStatus string   `json:"runtime_status"`
	Help          string   `json:"help,omitempty"`

	// Computation marks metrics that are derived from other metrics.
	// "count" (or empty) → directly computed against an event table;
	// "ratio" → Numerator / Denominator, both must reference other
	// registered metric keys. Marketers see a percentage; the API
	// returns the raw float so callers can format.
	Computation string `json:"computation,omitempty"`
	Numerator   string `json:"numerator,omitempty"`
	Denominator string `json:"denominator,omitempty"`
}

type MetricSpec struct {
	Key         string `json:"key"`
	Alias       string `json:"alias,omitempty"`
	Aggregation string `json:"aggregation,omitempty"`
}

type TimeRange struct {
	Preset string     `json:"preset,omitempty"`
	From   *time.Time `json:"from,omitempty"`
	To     *time.Time `json:"to,omitempty"`
}

type ReportRequest struct {
	Name          string         `json:"name,omitempty"`
	Description   string         `json:"description,omitempty"`
	ProductArea   string         `json:"product_area,omitempty"`
	Status        string         `json:"status,omitempty"`
	Metrics       []MetricSpec   `json:"metrics"`
	Dimensions    []string       `json:"dimensions,omitempty"`
	Filters       map[string]any `json:"filters,omitempty"`
	TimeRange     TimeRange      `json:"time_range,omitempty"`
	Visualization string         `json:"visualization,omitempty"`
	Schedule      map[string]any `json:"schedule,omitempty"`
}

type ReportDefinition struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenant_id"`
	Name          string         `json:"name"`
	Description   string         `json:"description"`
	ProductArea   string         `json:"product_area"`
	Status        string         `json:"status"`
	Metrics       []MetricSpec   `json:"metrics"`
	Dimensions    []string       `json:"dimensions"`
	Filters       map[string]any `json:"filters"`
	TimeRange     TimeRange      `json:"time_range"`
	Visualization string         `json:"visualization"`
	Schedule      map[string]any `json:"schedule,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
}

type PreviewResponse struct {
	SchemaVersion string             `json:"schema_version"`
	Valid         bool               `json:"valid"`
	Rows          []map[string]any   `json:"rows"`
	Metrics       []MetricDefinition `json:"metrics"`
	Warnings      []string           `json:"warnings,omitempty"`
	Errors        []string           `json:"errors,omitempty"`
}

type ReportRun struct {
	ID           string         `json:"id"`
	TenantID     string         `json:"tenant_id"`
	DefinitionID string         `json:"definition_id,omitempty"`
	Status       string         `json:"status"`
	Request      map[string]any `json:"request,omitempty"`
	Result       map[string]any `json:"result,omitempty"`
	Error        string         `json:"error,omitempty"`
	RowsTotal    int            `json:"rows_total"`
	StartedAt    *time.Time     `json:"started_at,omitempty"`
	CompletedAt  *time.Time     `json:"completed_at,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`

	// Provenance. Without these a stored result cannot say what it means:
	// MetricVersion identifies WHICH definitions produced the numbers (a
	// redefined open_rate is otherwise indistinguishable from the old one), and
	// ComputedAsOf says HOW CURRENT the data was — which is not StartedAt. The
	// gap between them is the answer's age, and it is what lets two surfaces
	// agree they are showing the same thing. Empty on runs predating the
	// columns; clients render the stamp when present.
	MetricVersion string     `json:"metric_version,omitempty"`
	ComputedAsOf  *time.Time `json:"computed_as_of,omitempty"`
}

type ValidationResponse struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

func MountRoutes(r chi.Router, d *Deps) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	write := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/reporting/metric-registry", d.MetricRegistry)
	r.With(read).Get("/api/v1/reporting/blocked-products", d.BlockedProducts)
	r.With(read).Post("/api/v1/reporting/preview", d.Preview)
	r.With(read).Get("/api/v1/reporting/definitions", d.ListDefinitions)
	r.With(write).Post("/api/v1/reporting/definitions", d.UpsertDefinition)
	r.With(read).Get("/api/v1/reporting/definitions/{id}", d.GetDefinition)
	r.With(write).Post("/api/v1/reporting/definitions/{id}/runs", d.RunDefinition)
	r.With(read).Get("/api/v1/reporting/runs", d.ListRuns)
	r.With(read).Get("/api/v1/reporting/runs/{id}", d.GetRun)
	r.With(read).Get("/api/v1/reporting/runs/{id}/export.csv", d.ExportRunCSV)
	r.With(read).Get("/api/v1/reporting/runs/{id}/export.json", d.ExportRunJSON)
}

func (d *Deps) MetricRegistry(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().MetricRegistry(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "klv12.reporting.v1",
		"items":          out,
	})
}

func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ReportRequest
	if err := httpbody.DecodeJSON(w, r, reportingJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.repo().Preview(r.Context(), tenantID, in)
	if err != nil {
		if errors.Is(err, ErrInvalidInput) {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_report", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	status := http.StatusOK
	if !out.Valid {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, out)
}

func (d *Deps) ListDefinitions(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 200
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 200, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.repo().ListDefinitions(r.Context(), tenantID, r.URL.Query().Get("status"), limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over
	// the prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[ReportDefinition]{Items: out, NextCursor: next})
}

func (d *Deps) GetDefinition(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().GetDefinition(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertDefinition(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ReportRequest
	if err := httpbody.DecodeJSON(w, r, reportingJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// The saver's identity. Absent for API-key and automation callers, which is
	// recorded as NULL rather than invented.
	var ownerUserID string
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		ownerUserID = u.ID
	}
	out, err := d.repo().UpsertDefinition(r.Context(), tenantID, in, ownerUserID)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RunDefinition(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().RunDefinition(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// Keyset pagination; default page size preserves the prior LIMIT 100
	// so omitting ?limit= returns the same count as before (no regression).
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 100, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	out, next, err := d.repo().ListRuns(r.Context(), tenantID, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	// Envelope serializes as {"items":[...], "nextCursor"?} — additive over
	// the prior {"items":[...]} shape (nextCursor omitted on the last page).
	writeJSON(w, http.StatusOK, pagination.Envelope[ReportRun]{Items: out, NextCursor: next})
}

func (d *Deps) GetRun(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.repo().GetRun(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ExportRunCSV(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	run, err := d.repo().GetRun(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	body, err := RunResultToCSV(run)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "export_unavailable", httperror.MessageForStatus(http.StatusUnprocessableEntity))
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="report-run-%s.csv"`, run.ID))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (d *Deps) ExportRunJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	run, err := d.repo().GetRun(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	body, err := RunResultToJSON(run)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "export_unavailable", httperror.MessageForStatus(http.StatusUnprocessableEntity))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="report-run-%s.json"`, run.ID))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (d *Deps) BlockedProducts(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	registry, err := d.repo().MetricRegistry(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "klv12.reporting.v1",
		"items":          BlockedProductSummary(registry),
	})
}

func Validate(in ReportRequest, registry map[string]MetricDefinition) ValidationResponse {
	out := ValidationResponse{Valid: true}
	if !allowedString(in.ProductArea, []string{"", "campaign", "flow", "form", "onsite", "commerce", "deliverability", "sms", "push", "reviews", "helpdesk", "agent", "account", "custom"}) {
		out.Errors = append(out.Errors, "product_area is not supported")
	}
	if !allowedString(in.Status, []string{"", "draft", "active", "archived"}) {
		out.Errors = append(out.Errors, "status must be draft|active|archived")
	}
	if len(in.Metrics) == 0 {
		out.Errors = append(out.Errors, "at least one metric is required")
	}
	if len(in.Metrics) > 10 {
		out.Errors = append(out.Errors, "reports support at most ten metrics")
	}
	if len(in.Dimensions) > 5 {
		out.Errors = append(out.Errors, "reports support at most five dimensions")
	}
	seen := map[string]struct{}{}
	for _, metric := range in.Metrics {
		key := strings.TrimSpace(metric.Key)
		if key == "" {
			out.Errors = append(out.Errors, "metric key is required")
			continue
		}
		if _, ok := seen[key]; ok {
			out.Errors = append(out.Errors, fmt.Sprintf("metric %q is duplicated", key))
		}
		seen[key] = struct{}{}
		def, ok := registry[key]
		if !ok {
			out.Errors = append(out.Errors, fmt.Sprintf("metric %q is not registered", key))
			continue
		}
		if strings.TrimSpace(metric.Alias) != "" {
			out.Errors = append(out.Errors, fmt.Sprintf("metric %q alias is not executable yet", key))
		}
		if strings.TrimSpace(metric.Aggregation) != "" {
			out.Errors = append(out.Errors, fmt.Sprintf("metric %q aggregation override is not executable yet", key))
		}
		if def.RuntimeStatus == "supported" && !executableMetricKey(key) {
			out.Errors = append(out.Errors, fmt.Sprintf("metric %q has no report executor", key))
		}
		if def.RuntimeStatus == "planned" || def.RuntimeStatus == "partial" {
			out.Warnings = append(out.Warnings, fmt.Sprintf("metric %q is %s", key, def.RuntimeStatus))
		}
		if def.Computation == "ratio" {
			if def.Numerator == "" || def.Denominator == "" {
				out.Errors = append(out.Errors, fmt.Sprintf("ratio metric %q is missing numerator/denominator", key))
				continue
			}
			if _, ok := registry[def.Numerator]; !ok {
				out.Errors = append(out.Errors, fmt.Sprintf("ratio metric %q numerator %q is not registered", key, def.Numerator))
			}
			if _, ok := registry[def.Denominator]; !ok {
				out.Errors = append(out.Errors, fmt.Sprintf("ratio metric %q denominator %q is not registered", key, def.Denominator))
			}
		}
	}
	for _, dim := range in.Dimensions {
		dim = strings.TrimSpace(dim)
		if dim == "" {
			out.Errors = append(out.Errors, "dimension key is required")
			continue
		}
		if !allowedDimension(dim) {
			out.Errors = append(out.Errors, fmt.Sprintf("dimension %q is not supported", dim))
		} else if dim != "day" {
			out.Errors = append(out.Errors, fmt.Sprintf("dimension %q is not executable yet", dim))
		}
	}
	if in.Visualization != "" && !allowedString(in.Visualization, []string{"table", "line", "bar", "funnel", "scorecard"}) {
		out.Errors = append(out.Errors, "visualization must be table|line|bar|funnel|scorecard")
	}
	if err := validateJSONSize("filters", in.Filters); err != nil {
		out.Errors = append(out.Errors, err.Error())
	}
	if len(in.Filters) > 0 {
		out.Errors = append(out.Errors, "filters are not executable yet")
	}
	if err := validateJSONSize("schedule", in.Schedule); err != nil {
		out.Errors = append(out.Errors, err.Error())
	}
	if !validTimeRange(in.TimeRange) {
		out.Errors = append(out.Errors, "time_range must use a supported preset and have from before to")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func BuiltinMetricRegistry() []MetricDefinition {
	return []MetricDefinition{
		{Key: "campaign.sent", Label: "Campaign sent", ProductArea: "campaign", Source: "campaign_report_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "campaign_id", "channel"}, RuntimeStatus: "supported"},
		{Key: "campaign.delivered", Label: "Campaign delivered", ProductArea: "campaign", Source: "campaign_report_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "campaign_id", "channel"}, RuntimeStatus: "supported"},
		{Key: "campaign.opened", Label: "Campaign opens", ProductArea: "campaign", Source: "campaign_report_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "campaign_id", "channel"}, RuntimeStatus: "supported"},
		{Key: "campaign.clicked", Label: "Campaign clicks", ProductArea: "campaign", Source: "campaign_report_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "campaign_id", "channel"}, RuntimeStatus: "supported"},
		{Key: "campaign.bounced", Label: "Campaign bounces", ProductArea: "deliverability", Source: "campaign_report_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "campaign_id"}, RuntimeStatus: "supported"},
		{Key: "campaign.unsubscribed", Label: "Campaign unsubscribes", ProductArea: "campaign", Source: "campaign_report_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "campaign_id"}, RuntimeStatus: "supported"},
		{Key: "campaign.delivery_rate", Label: "Delivery rate", ProductArea: "deliverability", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "campaign.delivered", Denominator: "campaign.sent"},
		{Key: "campaign.open_rate", Label: "Open rate", ProductArea: "campaign", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "campaign.opened", Denominator: "campaign.delivered"},
		{Key: "campaign.click_rate", Label: "Click rate", ProductArea: "campaign", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "campaign.clicked", Denominator: "campaign.delivered"},
		{Key: "campaign.click_to_open_rate", Label: "Click-to-open rate", ProductArea: "campaign", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "campaign.clicked", Denominator: "campaign.opened"},
		{Key: "campaign.bounce_rate", Label: "Bounce rate", ProductArea: "deliverability", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "campaign.bounced", Denominator: "campaign.sent"},
		{Key: "campaign.unsubscribe_rate", Label: "Unsubscribe rate", ProductArea: "campaign", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "campaign.unsubscribed", Denominator: "campaign.delivered"},
		{Key: "form.submitted", Label: "Form submissions", ProductArea: "form", Source: "form_submissions", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "form_id", "status"}, RuntimeStatus: "supported"},
		{Key: "form.confirmed", Label: "Confirmed form submissions", ProductArea: "form", Source: "form_submissions", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "form_id"}, RuntimeStatus: "supported"},
		{Key: "form.confirmation_rate", Label: "Form confirmation rate", ProductArea: "form", Aggregation: "ratio", ValueType: "rate", RuntimeStatus: "supported", Computation: "ratio", Numerator: "form.confirmed", Denominator: "form.submitted"},
		{Key: "onsite.view", Label: "Onsite views", ProductArea: "onsite", Source: "growth_surface_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "surface_type"}, RuntimeStatus: "supported"},
		{Key: "onsite.conversion", Label: "Onsite conversions", ProductArea: "onsite", Source: "growth_surface_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "surface_type"}, RuntimeStatus: "supported"},
		{Key: "flow.executions", Label: "Flow executions", ProductArea: "flow", Source: "automation_journey_executions", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "flow_id"}, RuntimeStatus: "partial"},
		{Key: "commerce.product_events", Label: "Commerce product events", ProductArea: "commerce", Source: "product_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "event_name"}, RuntimeStatus: "supported"},
		{Key: "deliverability.provider_breakdown", Label: "Provider breakdown", ProductArea: "deliverability", Source: "subscriber_events", Aggregation: "count", ValueType: "number", Dimensions: []string{"day", "provider", "campaign_id"}, RuntimeStatus: "planned"},
		{Key: "sms.conversations", Label: "SMS conversations", ProductArea: "sms", Source: "sms_conversations", Aggregation: "count", ValueType: "number", Dimensions: []string{"day"}, RuntimeStatus: "planned"},
		{Key: "push.sent", Label: "Push sent", ProductArea: "push", Source: "mobile_push", Aggregation: "count", ValueType: "number", Dimensions: []string{"day"}, RuntimeStatus: "planned"},
		{Key: "reviews.submitted", Label: "Reviews submitted", ProductArea: "reviews", Source: "product_reviews", Aggregation: "count", ValueType: "number", Dimensions: []string{"day"}, RuntimeStatus: "planned"},
		{Key: "helpdesk.tickets", Label: "Helpdesk tickets", ProductArea: "helpdesk", Source: "support_tickets", Aggregation: "count", ValueType: "number", Dimensions: []string{"day"}, RuntimeStatus: "planned"},
	}
}

func registryMap(items []MetricDefinition) map[string]MetricDefinition {
	out := map[string]MetricDefinition{}
	for _, item := range items {
		out[item.Key] = item
	}
	return out
}

func normalizeRequest(in *ReportRequest) {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.ProductArea = defaulted(strings.TrimSpace(in.ProductArea), "custom")
	in.Status = defaulted(strings.TrimSpace(in.Status), "active")
	in.Visualization = defaulted(strings.TrimSpace(in.Visualization), "table")
	if in.Filters == nil {
		in.Filters = map[string]any{}
	}
	if in.Schedule == nil {
		in.Schedule = map[string]any{}
	}
	if in.TimeRange.Preset == "" && in.TimeRange.From == nil && in.TimeRange.To == nil {
		in.TimeRange.Preset = "30d"
	}
	for i := range in.Metrics {
		in.Metrics[i].Key = strings.TrimSpace(in.Metrics[i].Key)
	}
	for i := range in.Dimensions {
		in.Dimensions[i] = strings.TrimSpace(in.Dimensions[i])
	}
}

func executableMetricKey(key string) bool {
	for _, item := range BuiltinMetricRegistry() {
		if item.Key == key && item.RuntimeStatus == "supported" {
			return true
		}
	}
	return false
}

func validTimeRange(value TimeRange) bool {
	if value.Preset != "" && !allowedString(value.Preset, []string{"24h", "1d", "7d", "14d", "30d", "90d", "180d", "365d", "1y"}) {
		return false
	}
	since, until := resolveWindow(value)
	return since.Before(until)
}

func allowedDimension(value string) bool {
	return allowedString(value, []string{"day", "week", "month", "campaign_id", "flow_id", "form_id", "segment_id", "channel", "status", "surface_type", "event_name", "provider"})
}

func validateJSONSize(name string, value map[string]any) error {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("%s must be valid JSON", name)
	}
	if len(raw) > int(256<<10) {
		return fmt.Errorf("%s must be 256KiB or smaller", name)
	}
	return nil
}

func allowedString(value string, allowed []string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
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

func (d *Deps) repo() *Repo {
	if d == nil {
		return nil
	}
	return d.Repo
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrInvalidInput):
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_input", err.Error())
	default:
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
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
