// SPDX-License-Identifier: AGPL-3.0-only
//
// extras.go — Refined Product Events PR 1 endpoints + repo queries.
// Catalog (distinct event names + counts + last-seen + 7d sparkline),
// insights stats (totals + unique subs + daily series), SSE live tail,
// CSV export. Repo also gets per-event filters (ListByEvent /
// ListBySubscriberAndEvent) so handlers can branch without rebuilding
// the existing functions.

package track

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// ---------------------------------------------------------------------
// Repo: per-event-name filter queries
// ---------------------------------------------------------------------

// ListByEvent returns recent product events of one event_name across
// the tenant. before is an optional cursor (occurred_at < before).
func (r *Repo) ListByEvent(ctx context.Context, tenantID, eventName string, limit int, before *time.Time) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, eventName, limit}
	q := `
SELECT id, tenant_id::text, subscriber_id::text, event_name, properties,
       occurred_at, received_at
FROM product_events
WHERE tenant_id = $1::uuid AND event_name = $2`
	if before != nil && !before.IsZero() {
		args = append(args, before.UTC())
		q += " AND occurred_at < $4"
	}
	q += " ORDER BY occurred_at DESC LIMIT $3"
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var props map[string]interface{}
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.SubscriberID, &ev.EventName,
			&props, &ev.OccurredAt, &ev.ReceivedAt); err != nil {
			return nil, err
		}
		ev.Properties = props
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListBySubscriberAndEvent narrows to (subscriber_id, event_name).
func (r *Repo) ListBySubscriberAndEvent(ctx context.Context, tenantID, subscriberID, eventName string, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, subscriber_id::text, event_name, properties,
       occurred_at, received_at
FROM product_events
WHERE tenant_id = $1::uuid AND subscriber_id::text = $2 AND event_name = $3
ORDER BY occurred_at DESC LIMIT $4`, tenantID, subscriberID, eventName, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var props map[string]interface{}
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.SubscriberID, &ev.EventName,
			&props, &ev.OccurredAt, &ev.ReceivedAt); err != nil {
			return nil, err
		}
		ev.Properties = props
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListNewerThan returns events with id > sinceID, oldest first. Powers
// the SSE live tail handler.
func (r *Repo) ListNewerThan(ctx context.Context, tenantID string, sinceID int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, subscriber_id::text, event_name, properties,
       occurred_at, received_at
FROM product_events
WHERE tenant_id = $1::uuid AND id > $2
ORDER BY id ASC LIMIT $3`, tenantID, sinceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var props map[string]interface{}
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.SubscriberID, &ev.EventName,
			&props, &ev.OccurredAt, &ev.ReceivedAt); err != nil {
			return nil, err
		}
		ev.Properties = props
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// MaxID returns the highest currently-stored event id for the tenant.
// Used to seed the SSE cursor so a fresh tail only shows events that
// arrive AFTER the operator opened the stream.
func (r *Repo) MaxID(ctx context.Context, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM product_events WHERE tenant_id = $1::uuid`,
		tenantID,
	).Scan(&id); err != nil {
		return 0, err
	}
	return id, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Catalog (distinct event names + per-event counts + last-seen + 7d series)
// ---------------------------------------------------------------------

// CatalogRow is one entry in the event catalog list.
type CatalogRow struct {
	EventName  string    `json:"eventName"`
	Count      int64     `json:"count"`
	UniqueSubs int64     `json:"uniqueSubscribers"`
	FirstSeen  time.Time `json:"firstSeen"`
	LastSeen   time.Time `json:"lastSeen"`
	// Daily counts for the last 7 days, oldest-first. Powers the
	// inline sparkline in the catalog list.
	Daily []TrackDailyBucket `json:"daily"`
}

// TrackDailyBucket is one day's slice of event volume.
type TrackDailyBucket struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

const (
	catalogDailySeriesPeriodDays = 7
	trackAggregateTimeZone       = "UTC"
)

// EventCatalogResponse makes the two independently-scoped windows explicit:
// item counts and subscriber totals use PeriodDays, while every row's Daily
// mini-series always uses DailySeriesPeriodDays. FirstSeen and LastSeen are
// also period-scoped rather than lifetime bounds.
type EventCatalogResponse struct {
	Items                   []CatalogRow `json:"items"`
	TotalDistinctEventNames int64        `json:"totalDistinctEventNames"`
	PeriodDays              int          `json:"periodDays"`
	DailySeriesPeriodDays   int          `json:"dailySeriesPeriodDays"`
	EventBoundsScope        string       `json:"eventBoundsScope"`
	TimeZone                string       `json:"timeZone"`
	AsOf                    time.Time    `json:"asOf"`
}

// EventCatalog GET /api/v1/track/catalog?days=30
//
// Returns one row per distinct event_name across the period with
// counts + a 7-day daily series for an inline sparkline. days clamped
// to [1, 365], default 30.
func (d *Deps) EventCatalog(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	asOf := time.Now().UTC()
	cutoff := utcDailyWindowStart(asOf, days)
	tx, err := db.WithTenantOptions(r.Context(), d.Repo.Pool, t.ID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT event_name,
       COUNT(*)::bigint                                  AS total,
       COUNT(DISTINCT subscriber_id)::bigint             AS unique_subs,
       MIN(occurred_at)                                  AS first_seen,
       MAX(occurred_at)                                  AS last_seen,
       COUNT(*) OVER()::bigint                           AS total_distinct
  FROM product_events
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2
   AND occurred_at <= $3
 GROUP BY event_name
 ORDER BY total DESC, event_name
 LIMIT 200`, t.ID, cutoff, asOf)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: query item aggregates: %w", err), r.Context())
		return
	}
	catalogByName := map[string]*CatalogRow{}
	order := []string{}
	var totalDistinctEventNames int64
	for rows.Next() {
		var c CatalogRow
		var rowTotalDistinct int64
		if err := rows.Scan(&c.EventName, &c.Count, &c.UniqueSubs, &c.FirstSeen, &c.LastSeen, &rowTotalDistinct); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: scan item aggregate: %w", err), r.Context())
			return
		}
		if rowTotalDistinct < 0 ||
			(len(order) > 0 && rowTotalDistinct != totalDistinctEventNames) {
			rows.Close()
			httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: inconsistent total distinct event names %d", rowTotalDistinct), r.Context())
			return
		}
		totalDistinctEventNames = rowTotalDistinct
		catalogByName[c.EventName] = &c
		order = append(order, c.EventName)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: read item aggregates: %w", err), r.Context())
		return
	}
	if totalDistinctEventNames < int64(len(order)) {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: total distinct event names %d is below returned rows %d", totalDistinctEventNames, len(order)), r.Context())
		return
	}

	// Per-day series — last 7 days. Single grouped query keyed by
	// (event_name, day); each name's slice gets the buckets that
	// belong to it.
	seriesCutoff := utcDailyWindowStart(asOf, catalogDailySeriesPeriodDays)
	sparseDailyByName := make(map[string][]TrackDailyBucket, len(order))
	if len(order) > 0 {
		dr, err := tx.Query(r.Context(), `
SELECT event_name,
       to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       COUNT(*)::bigint AS n
  FROM product_events
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2
   AND occurred_at <= $3
   AND event_name = ANY($4::text[])
 GROUP BY event_name, day
 ORDER BY event_name, day`, t.ID, seriesCutoff, asOf, order)
		if err != nil {
			httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: query daily series: %w", err), r.Context())
			return
		}
		for dr.Next() {
			var name, day string
			var n int64
			if err := dr.Scan(&name, &day, &n); err != nil {
				dr.Close()
				httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: scan daily series: %w", err), r.Context())
				return
			}
			if _, ok := catalogByName[name]; !ok {
				dr.Close()
				httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: daily series returned unrequested event name %q", name), r.Context())
				return
			}
			sparseDailyByName[name] = append(sparseDailyByName[name], TrackDailyBucket{Date: day, Count: n})
		}
		dr.Close()
		if err := dr.Err(); err != nil {
			httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: read daily series: %w", err), r.Context())
			return
		}
	}

	out := make([]CatalogRow, 0, len(order))
	for _, name := range order {
		daily, err := densifyUTCDailyBuckets(
			seriesCutoff,
			catalogDailySeriesPeriodDays,
			sparseDailyByName[name],
		)
		if err != nil {
			httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: densify %q daily series: %w", name, err), r.Context())
			return
		}
		catalogByName[name].Daily = daily
		out = append(out, *catalogByName[name])
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track catalog: commit read snapshot: %w", err), r.Context())
		return
	}
	writeJSON(w, http.StatusOK, EventCatalogResponse{
		Items:                   out,
		TotalDistinctEventNames: totalDistinctEventNames,
		PeriodDays:              days,
		DailySeriesPeriodDays:   catalogDailySeriesPeriodDays,
		EventBoundsScope:        "period",
		TimeZone:                trackAggregateTimeZone,
		AsOf:                    asOf,
	})
}

// ---------------------------------------------------------------------
// Insights stats (totals + unique subscribers + daily series)
// ---------------------------------------------------------------------

// EventStatsResponse is the wire shape for /track/stats — the
// "Activity" insights row at the top of the Product Events page.
type EventStatsResponse struct {
	PeriodDays        int                `json:"periodDays"`
	TotalEvents       int64              `json:"totalEvents"`
	UniqueSubscribers int64              `json:"uniqueSubscribers"`
	UniqueEventNames  int64              `json:"uniqueEventNames"`
	Daily             []TrackDailyBucket `json:"daily"`
	TimeZone          string             `json:"timeZone"`
	AsOf              time.Time          `json:"asOf"`
}

// EventStats GET /api/v1/track/stats?event_name=&days=30
//
// Optional event_name filter so the same insights shape powers
// both the page-level overview and the per-event drilldown.
func (d *Deps) EventStats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 30)
	if days < 1 || days > 365 {
		days = 30
	}
	eventName := strings.TrimSpace(r.URL.Query().Get("event_name"))
	asOf := time.Now().UTC()
	cutoff := utcDailyWindowStart(asOf, days)

	tx, err := db.WithTenantOptions(r.Context(), d.Repo.Pool, t.ID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	resp := EventStatsResponse{
		PeriodDays: days,
		TimeZone:   trackAggregateTimeZone,
		AsOf:       asOf,
	}

	// Totals + unique counts in a single query.
	if err := tx.QueryRow(r.Context(), `
SELECT COUNT(*)::bigint,
       COUNT(DISTINCT subscriber_id)::bigint,
       COUNT(DISTINCT event_name)::bigint
 FROM product_events
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2
   AND occurred_at <= $4
   AND ($3 = '' OR event_name = $3)`,
		t.ID, cutoff, eventName, asOf,
	).Scan(&resp.TotalEvents, &resp.UniqueSubscribers, &resp.UniqueEventNames); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track stats: query totals: %w", err), r.Context())
		return
	}

	rows, err := tx.Query(r.Context(), `
SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       COUNT(*)::bigint
  FROM product_events
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2
   AND occurred_at <= $4
   AND ($3 = '' OR event_name = $3)
 GROUP BY day
 ORDER BY day`, t.ID, cutoff, eventName, asOf)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track stats: query daily series: %w", err), r.Context())
		return
	}
	sparseDaily := make([]TrackDailyBucket, 0, days)
	for rows.Next() {
		var b TrackDailyBucket
		if err := rows.Scan(&b.Date, &b.Count); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Slog, fmt.Errorf("track stats: scan daily series: %w", err), r.Context())
			return
		}
		sparseDaily = append(sparseDaily, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track stats: read daily series: %w", err), r.Context())
		return
	}
	resp.Daily, err = densifyUTCDailyBuckets(cutoff, days, sparseDaily)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track stats: densify daily series: %w", err), r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track stats: commit read snapshot: %w", err), r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// utcDailyWindowStart returns the first UTC midnight in a window of exactly
// days calendar buckets ending in the UTC day containing asOf.
func utcDailyWindowStart(asOf time.Time, days int) time.Time {
	asOf = asOf.UTC()
	today := time.Date(asOf.Year(), asOf.Month(), asOf.Day(), 0, 0, 0, 0, time.UTC)
	return today.AddDate(0, 0, -(days - 1))
}

// densifyUTCDailyBuckets converts grouped database results into an exact
// oldest-first calendar sequence. Missing days are represented as explicit
// zeroes; malformed, duplicate, negative, or out-of-window rows fail closed
// rather than creating a plausible but misleading chart.
func densifyUTCDailyBuckets(
	start time.Time,
	days int,
	sparse []TrackDailyBucket,
) ([]TrackDailyBucket, error) {
	if days < 1 || days > 365 {
		return nil, fmt.Errorf("invalid UTC daily window length %d", days)
	}
	start = time.Date(
		start.UTC().Year(),
		start.UTC().Month(),
		start.UTC().Day(),
		0,
		0,
		0,
		0,
		time.UTC,
	)
	dense := make([]TrackDailyBucket, days)
	indexByDate := make(map[string]int, days)
	for i := range days {
		date := start.AddDate(0, 0, i).Format(time.DateOnly)
		dense[i] = TrackDailyBucket{Date: date, Count: 0}
		indexByDate[date] = i
	}
	seen := make(map[string]struct{}, len(sparse))
	for _, bucket := range sparse {
		index, ok := indexByDate[bucket.Date]
		if !ok {
			return nil, fmt.Errorf("bucket date %q is outside the requested UTC window", bucket.Date)
		}
		if bucket.Count < 0 {
			return nil, fmt.Errorf("bucket date %q has negative count %d", bucket.Date, bucket.Count)
		}
		if _, duplicate := seen[bucket.Date]; duplicate {
			return nil, fmt.Errorf("bucket date %q is duplicated", bucket.Date)
		}
		seen[bucket.Date] = struct{}{}
		dense[index].Count = bucket.Count
	}
	return dense, nil
}

// ---------------------------------------------------------------------
// SSE live tail
// ---------------------------------------------------------------------

// EventStream GET /api/v1/track/stream?event_name=
//
// Server-Sent Events handler. Polls product_events every 2s for rows
// newer than the last delivered id and writes them as `data:` frames.
// Optional event_name filter so an operator watching a specific event
// (e.g. `checkout_completed`) isn't drowned out by background traffic.
//
// Same polling-over-LISTEN/NOTIFY rationale as the audit SSE handler:
// emitter runs in N services; polling on the read side with a tight
// id cursor stays cheap on the (tenant_id, id) index.
func (d *Deps) EventStream(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	stream, canFlush := sse.Open(w)
	if !canFlush {
		writeJSON(w, http.StatusInternalServerError, errEnv("no_flusher", "streaming unsupported"))
		return
	}
	eventName := strings.TrimSpace(r.URL.Query().Get("event_name"))
	repo := d.EventStreamRepo
	if repo == nil {
		repo = d.Repo
	}
	if repo == nil {
		httperror.WriteInternal(
			w,
			d.Slog,
			errors.New("track event stream repository is not configured"),
			r.Context(),
		)
		return
	}

	// A fresh stream is a live tail, not a replay endpoint. Resolve the current
	// high-water mark before committing SSE headers; if the database cannot
	// establish that boundary, fail closed instead of seeding zero and
	// replaying tenant history.
	sinceID, err := repo.MaxID(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(
			w,
			d.Slog,
			fmt.Errorf("track event stream: bootstrap cursor: %w", err),
			r.Context(),
		)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if stream.Sendf("event: hello\ndata: {\"sinceId\":%d}\n\n", sinceID) != nil {
		return
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			// A failed write means the client is gone.
			if stream.Sendf(": heartbeat\n\n") != nil {
				return
			}
		case <-ticker.C:
			fresh, err := repo.ListNewerThan(r.Context(), t.ID, sinceID, 50)
			if err != nil {
				// Transient db error — don't kill the stream.
				continue
			}
			matched := 0
			for _, ev := range fresh {
				if ev.ID > sinceID {
					sinceID = ev.ID
				}
				if eventName != "" && ev.EventName != eventName {
					continue
				}
				blob, err := json.Marshal(ev)
				if err != nil {
					continue
				}
				_, _ = fmt.Fprintf(stream, "event: track\ndata: %s\n\n", blob)
				matched++
			}
			if matched > 0 && stream.Flush() != nil {
				return
			}
		}
	}
}

// ---------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------

const (
	productEventCSVDefaultLimit = 10_000
	productEventCSVHardCap      = 10_000
)

type productEventCSVExportOptions struct {
	EventName     string
	SubscriberID  string
	OccurredAfter *time.Time
	Limit         int
}

// parseProductEventCSVExportOptions freezes one explicit export scope before
// any database work starts. `occurred_after` is an inclusive lower bound:
// events whose occurred_at is exactly the supplied instant are included.
func parseProductEventCSVExportOptions(r *http.Request) (productEventCSVExportOptions, error) {
	query := r.URL.Query()
	opts := productEventCSVExportOptions{
		EventName:    strings.TrimSpace(query.Get("event_name")),
		SubscriberID: strings.TrimSpace(query.Get("subscriber_id")),
		Limit:        productEventCSVDefaultLimit,
	}

	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		// Preserve the endpoint's historical fail-safe default for malformed,
		// zero, and negative limits while enforcing the public hard ceiling.
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			opts.Limit = parsed
		}
	}
	if opts.Limit > productEventCSVHardCap {
		opts.Limit = productEventCSVHardCap
	}

	const occurredAfterParam = "occurred_after"
	if values, present := query[occurredAfterParam]; present {
		if len(values) != 1 {
			return productEventCSVExportOptions{},
				fmt.Errorf("%s must be supplied at most once", occurredAfterParam)
		}
		raw := strings.TrimSpace(values[0])
		if raw != "" {
			parsed, err := time.Parse(time.RFC3339Nano, raw)
			if err != nil {
				return productEventCSVExportOptions{},
					fmt.Errorf("%s must be an RFC3339 timestamp with a timezone", occurredAfterParam)
			}
			parsed = parsed.UTC()
			opts.OccurredAfter = &parsed
		}
	}
	return opts, nil
}

const productEventCSVExportFromWhere = `
  FROM product_events
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR event_name = $2)
   AND ($3 = '' OR subscriber_id::text = $3)
   AND ($4::timestamptz IS NULL OR occurred_at >= $4::timestamptz)
   AND occurred_at <= $5::timestamptz`

const productEventCSVExportAsOfSQL = `SELECT transaction_timestamp()`

const productEventCSVExportTruncatedSQL = `
SELECT EXISTS (
	SELECT 1` + productEventCSVExportFromWhere + `
	 ORDER BY id DESC
	 LIMIT 1
	 OFFSET $6
)`

const productEventCSVExportRowsSQL = `
SELECT id, subscriber_id::text, event_name, properties::text,
       occurred_at, received_at` + productEventCSVExportFromWhere + `
 ORDER BY id DESC
 LIMIT $6`

// ExportEventsCSV GET
// /api/v1/track/events.csv?event_name=&subscriber_id=&occurred_after=&limit=
//
// Streams a tenant-scoped event list as CSV. occurred_after is an inclusive
// RFC3339 lower bound. The export is always capped at 10,000 data rows; a
// bounded lookahead sets X-Postwave-Truncated before the first body byte when
// additional matching rows exist.
func (d *Deps) ExportEventsCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	opts, err := parseProductEventCSVExportOptions(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_occurred_after", err.Error()))
		return
	}

	tx, err := db.WithTenantOptions(r.Context(), d.Repo.Pool, t.ID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Slog, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Freeze the database server's transaction timestamp inside the
	// repeatable-read snapshot. Both the bounded lookahead and streamed rows
	// use this exact upper bound, so future-dated events cannot influence
	// truncation or leak into the export.
	var asOf time.Time
	if err := tx.QueryRow(r.Context(), productEventCSVExportAsOfSQL).Scan(&asOf); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track csv: freeze snapshot timestamp: %w", err), r.Context())
		return
	}
	asOf = asOf.UTC()

	var occurredAfter any
	if opts.OccurredAfter != nil {
		occurredAfter = *opts.OccurredAfter
	}
	args := []any{
		t.ID,
		opts.EventName,
		opts.SubscriberID,
		occurredAfter,
		asOf,
		opts.Limit,
	}

	var truncated bool
	if err := tx.QueryRow(r.Context(), productEventCSVExportTruncatedSQL, args...).Scan(&truncated); err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track csv: determine truncation: %w", err), r.Context())
		return
	}

	rows, err := tx.Query(r.Context(), productEventCSVExportRowsSQL, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Slog, fmt.Errorf("track csv: query rows: %w", err), r.Context())
		return
	}
	defer rows.Close()

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="postwave-product-events-`+asOf.Format("20060102-150405")+`.csv"`)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Postwave-Export-Limit", strconv.Itoa(opts.Limit))
	if truncated {
		w.Header().Set("X-Postwave-Truncated", "true")
	}
	w.WriteHeader(http.StatusOK)
	csvWriter := csv.NewWriter(w)
	if err := writeSpreadsheetSafeCSVRecord(csvWriter, []string{
		"id",
		"occurred_at",
		"received_at",
		"subscriber_id",
		"event_name",
		"properties_json",
	}); err != nil {
		d.logf("track: csv header write failed tenant=%s err=%v", t.ID, err)
		return
	}
	// csv.Writer buffers. Flush its header, then notify the gateway's
	// conditional-response wrapper that this is a stream so it does not
	// materialize the complete (potentially 10,000-row) export in memory.
	csvWriter.Flush()
	if err := csvWriter.Error(); err != nil {
		d.logf("track: csv header flush failed tenant=%s err=%v", t.ID, err)
		return
	}
	_ = http.NewResponseController(w).Flush()
	for rows.Next() {
		var (
			id           int64
			subscriberID string
			name         string
			props        string
			occurred     time.Time
			received     time.Time
		)
		if err := rows.Scan(&id, &subscriberID, &name, &props, &occurred, &received); err != nil {
			d.logf("track: csv row scan failed tenant=%s err=%v", t.ID, err)
			return
		}
		if err := writeSpreadsheetSafeCSVRecord(csvWriter, []string{
			strconv.FormatInt(id, 10),
			occurred.UTC().Format(time.RFC3339Nano),
			received.UTC().Format(time.RFC3339Nano),
			subscriberID,
			name,
			props,
		}); err != nil {
			d.logf("track: csv row write failed tenant=%s event_id=%d err=%v", t.ID, id, err)
			return
		}
	}
	if err := rows.Err(); err != nil {
		d.logf("track: csv rows failed tenant=%s err=%v", t.ID, err)
		return
	}
	csvWriter.Flush()
	if err := csvWriter.Error(); err != nil {
		d.logf("track: csv flush failed tenant=%s err=%v", t.ID, err)
	}
}

func writeSpreadsheetSafeCSVRecord(writer *csv.Writer, cells []string) error {
	safe := make([]string, len(cells))
	for i, cell := range cells {
		safe[i] = spreadsheetSafeCSVCell(cell)
	}
	return writer.Write(safe)
}

// spreadsheetSafeCSVCell neutralizes formula injection when an export is
// opened in Excel, Numbers, or another spreadsheet. A leading apostrophe is
// the conventional reversible escape: spreadsheet UIs treat the cell as
// literal text, while machine consumers can still recover the source value by
// removing that one prefix when the next meaningful rune is formula-active.
//
// We also protect formula markers hidden behind leading whitespace and any
// control/format rune prefix. encoding/csv remains responsible for preserving
// quotes, commas, and line breaks.
func spreadsheetSafeCSVCell(value string) string {
	for _, r := range value {
		switch {
		case r == '=' || r == '+' || r == '-' || r == '@':
			return "'" + value
		case unicode.IsControl(r) || unicode.In(r, unicode.Cf):
			return "'" + value
		case unicode.IsSpace(r):
			continue
		default:
			return value
		}
	}
	return value
}
