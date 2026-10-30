package reporting

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

var (
	ErrNotFound     = errors.New("reporting: not found")
	ErrInvalidInput = errors.New("reporting: invalid input")
)

type Repo struct {
	Pool *db.Pool
}

func (r *Repo) MetricRegistry(ctx context.Context, tenantID string) ([]MetricDefinition, error) {
	out := BuiltinMetricRegistry()
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT key, label, product_area, source, aggregation, value_type, dimensions,
       runtime_status
FROM report_metric_registry
WHERE tenant_id = $1::uuid
ORDER BY product_area, key`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item MetricDefinition
		if err := rows.Scan(&item.Key, &item.Label, &item.ProductArea, &item.Source,
			&item.Aggregation, &item.ValueType, &item.Dimensions, &item.RuntimeStatus); err != nil {
			return nil, err
		}
		out = appendOrReplaceMetric(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Metrics the product DISCOVERED from the tenant's own event stream.
	//
	// Merged after the curated table on purpose: an operator who has explicitly
	// defined a metric in report_metric_registry has said what they want it to
	// mean, and a discovered row must never overwrite that. appendOrReplaceMetric
	// is keyed, so a curated entry with the same key wins by arriving first only
	// if discovery does not replace it — hence the explicit skip below.
	curated := map[string]bool{}
	for _, item := range out {
		curated[item.Key] = true
	}
	discovered, err := tx.Query(ctx, `
SELECT key, label, event_name, aggregation, value_type, last_seen_at
  FROM metric_definitions
 WHERE tenant_id = $1::uuid
   AND source = 'track'
   AND status = 'active'
 ORDER BY key`, tenantID)
	if err != nil {
		return nil, err
	}
	defer discovered.Close()
	for discovered.Next() {
		var key, label, eventName, aggregation, valueType string
		var lastSeen time.Time
		if err := discovered.Scan(&key, &label, &eventName, &aggregation, &valueType, &lastSeen); err != nil {
			return nil, err
		}
		if curated[key] {
			continue
		}
		out = append(out, MetricDefinition{
			Key:         key,
			Label:       label,
			ProductArea: "custom",
			Source:      "product_events",
			Aggregation: aggregation,
			ValueType:   valueType,
			Dimensions:  []string{"day", "event_name"},
			// "supported", not "planned": these execute. A registry that lists a
			// metric it cannot compute is a worse phantom than the empty table
			// this replaced, because the caller only finds out at preview time.
			RuntimeStatus: "supported",
		})
	}
	if err := discovered.Err(); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) Preview(ctx context.Context, tenantID string, in ReportRequest) (*PreviewResponse, error) {
	normalizeRequest(&in)
	registryItems, err := r.MetricRegistry(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	registry := registryMap(registryItems)
	validation := Validate(in, registry)
	out := &PreviewResponse{
		SchemaVersion: "klv12.reporting.v1",
		Valid:         validation.Valid,
		Warnings:      validation.Warnings,
		Errors:        validation.Errors,
	}
	for _, metric := range in.Metrics {
		if def, ok := registry[metric.Key]; ok {
			out.Metrics = append(out.Metrics, def)
		}
	}
	if !validation.Valid {
		return out, nil
	}
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, metric := range in.Metrics {
		def := registry[metric.Key]
		if def.RuntimeStatus != "supported" {
			continue
		}
		rows, err := previewMetric(ctx, tx, tenantID, def, in)
		if err != nil {
			return nil, err
		}
		out.Rows = append(out.Rows, rows...)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// UpsertDefinition saves a report definition.
//
// ownerUserID records WHO saved it. The column has existed since the table did
// and was referenced by no Go code — no insert wrote it, no select read it — so
// every saved report was anonymous: the library could not show "my reports", an
// audit could not say who built a definition that queries customer data, and a
// departing colleague's work was unfindable.
//
// Empty is permitted and stored as NULL. API-key and automation callers have no
// user, and a report saved by an integration is legitimately ownerless — NULL
// says that honestly where a synthetic id would lie.
func (r *Repo) UpsertDefinition(ctx context.Context, tenantID string, in ReportRequest, ownerUserID string) (*ReportDefinition, error) {
	normalizeRequest(&in)
	if in.Name == "" {
		return nil, fmt.Errorf("%w: name is required", ErrInvalidInput)
	}
	registryItems, err := r.MetricRegistry(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if validation := Validate(in, registryMap(registryItems)); !validation.Valid {
		return nil, fmt.Errorf("%w: %s", ErrInvalidInput, strings.Join(validation.Errors, "; "))
	}
	metrics, _ := json.Marshal(in.Metrics)
	filters, _ := json.Marshal(in.Filters)
	timeRange, _ := json.Marshal(in.TimeRange)
	schedule, _ := json.Marshal(in.Schedule)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO report_definitions
    (tenant_id, name, description, product_area, status, metrics, dimensions,
     filters, time_range, visualization, schedule, owner_user_id)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::text[], $8::jsonb, $9::jsonb, $10, $11::jsonb,
     NULLIF($12, '')::uuid)
RETURNING id::text, tenant_id::text, name, description, product_area, status,
       metrics, dimensions, filters, time_range, visualization, schedule,
       created_at, updated_at`,
		tenantID, in.Name, in.Description, in.ProductArea, in.Status, string(metrics),
		in.Dimensions, string(filters), string(timeRange), in.Visualization, string(schedule),
		ownerUserID)
	out, err := scanDefinition(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDefinitions returns report definitions newest-edited-first with keyset
// pagination on (updated_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned when
// more rows remain. updated_at is mutable, so a row edited concurrently with
// paging may shift between pages — acceptable for this admin list. status is
// the optional filter (empty means all).
func (r *Repo) ListDefinitions(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]ReportDefinition, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when paging)
	// takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(status), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, description, product_area, status,
       metrics, dimensions, filters, time_range, visualization, schedule,
       created_at, updated_at
FROM report_definitions
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
`+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []ReportDefinition{}
	for rows.Next() {
		item, err := scanDefinition(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) GetDefinition(ctx context.Context, tenantID, id string) (*ReportDefinition, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, description, product_area, status,
       metrics, dimensions, filters, time_range, visualization, schedule,
       created_at, updated_at
FROM report_definitions
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id)
	out, err := scanDefinition(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) RunDefinition(ctx context.Context, tenantID, id string) (*ReportRun, error) {
	def, err := r.GetDefinition(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	req := ReportRequest{
		Name:          def.Name,
		ProductArea:   def.ProductArea,
		Status:        def.Status,
		Metrics:       def.Metrics,
		Dimensions:    def.Dimensions,
		Filters:       def.Filters,
		TimeRange:     def.TimeRange,
		Visualization: def.Visualization,
		Schedule:      def.Schedule,
	}
	preview, err := r.Preview(ctx, tenantID, req)
	if err != nil {
		return nil, err
	}
	requestRaw, _ := json.Marshal(req)
	resultRaw, _ := json.Marshal(preview)
	now := time.Now().UTC()
	// How current the DATA was, read from the data itself. Stamping time.Now()
	// here would be the lie this column exists to prevent: it would claim every
	// answer is current, including one computed over a pipeline that last landed
	// six hours ago. NULL when the source is empty or unreadable — "provenance
	// unknown" is honest, "now" is not.
	computedAsOf := r.sourceFreshness(ctx, tenantID)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO report_runs
    (tenant_id, definition_id, status, request, result, rows_total, started_at, completed_at,
     metric_version, computed_as_of)
VALUES
    ($1::uuid, $2::uuid, 'completed', $3::jsonb, $4::jsonb, $5, $6, $6, $7, $8)
RETURNING id::text, tenant_id::text, COALESCE(definition_id::text, ''), status,
       request, result, error, rows_total, started_at, completed_at, created_at,
       metric_version, computed_as_of`,
		tenantID, id, string(requestRaw), string(resultRaw), len(preview.Rows), now,
		MetricRegistryVersion, computedAsOf)
	out, err := scanRun(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListRuns returns report runs newest-first with keyset pagination on
// (created_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned
// when more rows remain.
func (r *Repo) ListRuns(ctx context.Context, tenantID string, limit int, cursor pagination.Cursor) ([]ReportRun, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{tenantID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (created_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(definition_id::text, ''), status,
       request, result, error, rows_total, started_at, completed_at, created_at,
       metric_version, computed_as_of
FROM report_runs
WHERE tenant_id = $1::uuid
`+keyset+`
ORDER BY created_at DESC, id DESC
LIMIT $2`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []ReportRun{}
	for rows.Next() {
		item, err := scanRun(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) GetRun(ctx context.Context, tenantID, id string) (*ReportRun, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, COALESCE(definition_id::text, ''), status,
       request, result, error, rows_total, started_at, completed_at, created_at,
       metric_version, computed_as_of
FROM report_runs
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id)
	out, err := scanRun(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func previewMetric(ctx context.Context, tx pgx.Tx, tenantID string, metric MetricDefinition, req ReportRequest) ([]map[string]any, error) {
	if metric.Computation == "ratio" {
		return previewRatioMetric(ctx, tx, tenantID, metric, req)
	}
	since, until := resolveWindow(req.TimeRange)
	if hasDimension(req.Dimensions, "day") {
		return previewMetricByDay(ctx, tx, tenantID, metric, since, until)
	}
	value, err := previewMetricTotal(ctx, tx, tenantID, metric, since, until)
	if err != nil {
		return nil, err
	}
	return []map[string]any{{
		"metric":       metric.Key,
		"product_area": metric.ProductArea,
		"value":        value,
	}}, nil
}

// resolveWindow turns a report's TimeRange into concrete [since, until) bounds.
// An explicit From/To wins; otherwise the preset maps to a trailing window
// (default 30 days). Previously every report query hardcoded a 30-day window
// and ignored the requested range entirely.
func resolveWindow(tr TimeRange) (time.Time, time.Time) {
	now := time.Now().UTC()
	if tr.From != nil || tr.To != nil {
		since := now.AddDate(0, 0, -presetDays(""))
		if tr.From != nil {
			since = tr.From.UTC()
		}
		until := now
		if tr.To != nil {
			until = tr.To.UTC()
		}
		return since, until
	}
	return now.AddDate(0, 0, -presetDays(tr.Preset)), now
}

func presetDays(preset string) int {
	switch preset {
	case "24h", "1d":
		return 1
	case "7d":
		return 7
	case "14d":
		return 14
	case "90d":
		return 90
	case "180d":
		return 180
	case "365d", "1y":
		return 365
	case "30d", "":
		return 30
	default:
		return 30
	}
}

// previewRatioMetric resolves a ratio metric by computing its numerator
// and denominator components against the same registry. The numerator
// and denominator must be `count`-style metrics (otherwise we'd recurse
// indefinitely on ratio-of-ratios — explicitly disallowed at validation).
// A zero denominator yields value=0 and a denominator_zero=true marker;
// callers (UI / CSV export) format from there.
func previewRatioMetric(ctx context.Context, tx pgx.Tx, tenantID string, metric MetricDefinition, req ReportRequest) ([]map[string]any, error) {
	if metric.Numerator == "" || metric.Denominator == "" {
		return nil, fmt.Errorf("%w: ratio metric %q missing components", ErrInvalidInput, metric.Key)
	}
	registry := registryMap(BuiltinMetricRegistry())
	num, okN := registry[metric.Numerator]
	den, okD := registry[metric.Denominator]
	if !okN || !okD {
		return nil, fmt.Errorf("%w: ratio metric %q references unknown component", ErrInvalidInput, metric.Key)
	}
	if num.Computation == "ratio" || den.Computation == "ratio" {
		return nil, fmt.Errorf("%w: ratio metric %q cannot reference another ratio", ErrInvalidInput, metric.Key)
	}
	since, until := resolveWindow(req.TimeRange)
	if hasDimension(req.Dimensions, "day") {
		numRows, err := previewMetricByDay(ctx, tx, tenantID, num, since, until)
		if err != nil {
			return nil, err
		}
		denRows, err := previewMetricByDay(ctx, tx, tenantID, den, since, until)
		if err != nil {
			return nil, err
		}
		denByDay := map[string]int{}
		for _, row := range denRows {
			day, _ := row["day"].(string)
			val, _ := row["value"].(int)
			denByDay[day] = val
		}
		out := make([]map[string]any, 0, len(numRows))
		for _, row := range numRows {
			day, _ := row["day"].(string)
			n, _ := row["value"].(int)
			d := denByDay[day]
			out = append(out, ratioRow(metric, n, d, map[string]any{"day": day}))
		}
		return out, nil
	}
	n, err := previewMetricTotal(ctx, tx, tenantID, num, since, until)
	if err != nil {
		return nil, err
	}
	d, err := previewMetricTotal(ctx, tx, tenantID, den, since, until)
	if err != nil {
		return nil, err
	}
	return []map[string]any{ratioRow(metric, n, d, nil)}, nil
}

func ratioRow(metric MetricDefinition, numerator, denominator int, extra map[string]any) map[string]any {
	rate := 0.0
	denominatorZero := denominator == 0
	if !denominatorZero {
		rate = float64(numerator) / float64(denominator)
	}
	out := map[string]any{
		"metric":           metric.Key,
		"product_area":     metric.ProductArea,
		"value":            rate,
		"value_type":       "rate",
		"numerator":        numerator,
		"denominator":      denominator,
		"denominator_zero": denominatorZero,
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func previewMetricTotal(ctx context.Context, tx pgx.Tx, tenantID string, metric MetricDefinition, since, until time.Time) (int, error) {
	switch metric.Key {
	case "campaign.sent":
		return countCampaignEvent(ctx, tx, tenantID, "sent", since, until)
	case "campaign.delivered":
		return countCampaignEvent(ctx, tx, tenantID, "delivered", since, until)
	case "campaign.opened":
		return countCampaignEvent(ctx, tx, tenantID, "opened", since, until)
	case "campaign.clicked":
		return countCampaignEvent(ctx, tx, tenantID, "clicked", since, until)
	case "campaign.bounced":
		return countCampaignEvent(ctx, tx, tenantID, "bounced", since, until)
	case "campaign.unsubscribed":
		return countCampaignEvent(ctx, tx, tenantID, "unsubscribed", since, until)
	case "form.submitted":
		return countFormSubmissions(ctx, tx, tenantID, "", since, until)
	case "form.confirmed":
		return countFormSubmissions(ctx, tx, tenantID, "confirmed", since, until)
	case "onsite.view":
		return countGrowthEvent(ctx, tx, tenantID, "view", since, until)
	case "onsite.conversion":
		return countGrowthEvent(ctx, tx, tenantID, "conversion", since, until)
	case "commerce.product_events":
		return countProductEvents(ctx, tx, tenantID, "", since, until)
	default:
		// Discovered metrics: one event name, counted.
		if name, ok := discoveredEventName(metric.Key); ok {
			return countProductEvents(ctx, tx, tenantID, name, since, until)
		}
		return 0, fmt.Errorf("%w: metric %q has no total executor", ErrInvalidInput, metric.Key)
	}
}

func previewMetricByDay(ctx context.Context, tx pgx.Tx, tenantID string, metric MetricDefinition, since, until time.Time) ([]map[string]any, error) {
	eventType, table := eventBinding(metric.Key)
	if table == "" {
		return nil, fmt.Errorf("%w: metric %q has no grouped executor", ErrInvalidInput, metric.Key)
	}
	var rows pgx.Rows
	var err error
	switch table {
	case "campaign_report_events":
		rows, err = tx.Query(ctx, `
SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*)::int
FROM campaign_report_events
WHERE tenant_id = $1::uuid AND event_type = $2
  AND at >= $3 AND at < $4
GROUP BY 1
ORDER BY 1`, tenantID, eventType, since, until)
	case "form_submissions":
		status := eventType
		if status == "submitted" {
			status = ""
		}
		rows, err = tx.Query(ctx, `
SELECT to_char(date_trunc('day', submitted_at), 'YYYY-MM-DD') AS day, count(*)::int
FROM form_submissions
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
  AND submitted_at >= $3 AND submitted_at < $4
GROUP BY 1
ORDER BY 1`, tenantID, status, since, until)
	case "growth_surface_events":
		rows, err = tx.Query(ctx, `
SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*)::int
FROM growth_surface_events
WHERE tenant_id = $1::uuid AND event_type = $2
  AND at >= $3 AND at < $4
GROUP BY 1
ORDER BY 1`, tenantID, eventType, since, until)
	case "product_events":
		// eventType is "any" for the built-in all-events metric and the event
		// name for a discovered one.
		name := eventType
		if name == "any" {
			name = ""
		}
		rows, err = tx.Query(ctx, `
SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day, count(*)::int
FROM product_events
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR event_name = $2)
  AND occurred_at >= $3 AND occurred_at < $4
GROUP BY 1
ORDER BY 1`, tenantID, name, since, until)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var day string
		var value int
		if err := rows.Scan(&day, &value); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"metric":       metric.Key,
			"product_area": metric.ProductArea,
			"day":          day,
			"value":        value,
		})
	}
	return out, rows.Err()
}

func countCampaignEvent(ctx context.Context, tx pgx.Tx, tenantID, eventType string, since, until time.Time) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM campaign_report_events
WHERE tenant_id = $1::uuid AND event_type = $2
  AND at >= $3 AND at < $4`, tenantID, eventType, since, until).Scan(&n)
	return n, err
}

func countFormSubmissions(ctx context.Context, tx pgx.Tx, tenantID, status string, since, until time.Time) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM form_submissions
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
  AND submitted_at >= $3 AND submitted_at < $4`, tenantID, status, since, until).Scan(&n)
	return n, err
}

func countGrowthEvent(ctx context.Context, tx pgx.Tx, tenantID, eventType string, since, until time.Time) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM growth_surface_events
WHERE tenant_id = $1::uuid AND event_type = $2
  AND at >= $3 AND at < $4`, tenantID, eventType, since, until).Scan(&n)
	return n, err
}

// countProductEvents counts product events, optionally for ONE event name.
//
// An empty eventName means every event, which is what the built-in
// commerce.product_events metric asks for; a non-empty one is a discovered
// metric counting only its own event.
func countProductEvents(ctx context.Context, tx pgx.Tx, tenantID, eventName string, since, until time.Time) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM product_events
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR event_name = $2)
  AND occurred_at >= $3 AND occurred_at < $4`, tenantID, eventName, since, until).Scan(&n)
	return n, err
}

func eventBinding(key string) (eventType, table string) {
	switch key {
	case "campaign.sent":
		return "sent", "campaign_report_events"
	case "campaign.delivered":
		return "delivered", "campaign_report_events"
	case "campaign.opened":
		return "opened", "campaign_report_events"
	case "campaign.clicked":
		return "clicked", "campaign_report_events"
	case "campaign.bounced":
		return "bounced", "campaign_report_events"
	case "campaign.unsubscribed":
		return "unsubscribed", "campaign_report_events"
	case "form.submitted":
		return "submitted", "form_submissions"
	case "form.confirmed":
		return "confirmed", "form_submissions"
	case "onsite.view":
		return "view", "growth_surface_events"
	case "onsite.conversion":
		return "conversion", "growth_surface_events"
	case "commerce.product_events":
		return "any", "product_events"
	default:
		if name, ok := discoveredEventName(key); ok {
			return name, "product_events"
		}
		return "", ""
	}
}

// discoveredEventName recovers the event name from a discovered metric key.
//
// The `track.` prefix is what keeps a tenant's event called `campaign.opened`
// from redefining the built-in metric of that name for their own reports.
func discoveredEventName(key string) (string, bool) {
	const prefix = "track."
	if !strings.HasPrefix(key, prefix) {
		return "", false
	}
	name := strings.TrimSpace(strings.TrimPrefix(key, prefix))
	if name == "" {
		return "", false
	}
	return name, true
}

func scanDefinition(row pgx.Row) (*ReportDefinition, error) {
	var out ReportDefinition
	var metricsRaw, filtersRaw, rangeRaw, scheduleRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Description,
		&out.ProductArea, &out.Status, &metricsRaw, &out.Dimensions, &filtersRaw,
		&rangeRaw, &out.Visualization, &scheduleRaw, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(metricsRaw, &out.Metrics)
	out.Filters = decodeMap(filtersRaw)
	_ = json.Unmarshal(rangeRaw, &out.TimeRange)
	out.Schedule = decodeMap(scheduleRaw)
	if out.Metrics == nil {
		out.Metrics = []MetricSpec{}
	}
	if out.Dimensions == nil {
		out.Dimensions = []string{}
	}
	return &out, nil
}

func scanRun(row pgx.Row) (*ReportRun, error) {
	var out ReportRun
	var requestRaw, resultRaw []byte
	var metricVersion *string
	if err := row.Scan(&out.ID, &out.TenantID, &out.DefinitionID, &out.Status,
		&requestRaw, &resultRaw, &out.Error, &out.RowsTotal, &out.StartedAt,
		&out.CompletedAt, &out.CreatedAt, &metricVersion, &out.ComputedAsOf); err != nil {
		return nil, err
	}
	if metricVersion != nil {
		out.MetricVersion = *metricVersion
	}
	out.Request = decodeMap(requestRaw)
	out.Result = decodeMap(resultRaw)
	return &out, nil
}

func appendOrReplaceMetric(items []MetricDefinition, item MetricDefinition) []MetricDefinition {
	for i := range items {
		if items[i].Key == item.Key {
			items[i] = item
			return items
		}
	}
	return append(items, item)
}

func hasDimension(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	if out == nil {
		out = map[string]any{}
	}
	return out
}

// sourceFreshness reports how current the reporting source data is.
//
// The newest event the reporting tables hold, which is the most recent moment a
// report over them can describe. Deliberately NOT the wall clock: the gap
// between this and a run's started_at IS the answer's age, and collapsing them
// is what makes two surfaces disagree about the same saved report with no way to
// tell a lag from a defect.
//
// Best-effort: nil on any error or an empty source. A missing stamp reads as
// "unknown", which a client can render honestly; a fabricated one cannot be
// distinguished from a real one.
func (r *Repo) sourceFreshness(ctx context.Context, tenantID string) *time.Time {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var at *time.Time
	if err := tx.QueryRow(ctx, `
SELECT max(at) FROM campaign_report_events WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&at); err != nil {
		return nil
	}
	_ = tx.Commit(ctx)
	return at
}
