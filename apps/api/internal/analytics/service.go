package analytics

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Service holds the pgx pool and exposes the read queries that back the
// analytics handlers. All queries open their own db.WithTenant transaction
// so RLS is enforced even when the caller is misconfigured.
type Service struct {
	Pool *db.Pool
}

// NewService is a thin constructor.
func NewService(pool *db.Pool) *Service { return &Service{Pool: pool} }

// ensureOwnedCampaign prevents aggregate-only queries from turning an
// unknown, malformed, or other-tenant campaign into a misleading successful
// zero-value report. Both missing and foreign identifiers intentionally
// collapse to pgx.ErrNoRows so callers can expose one non-disclosing 404.
func ensureOwnedCampaign(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	campaignID string,
) error {
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return pgx.ErrNoRows
	}
	if _, err := uuid.Parse(strings.TrimSpace(campaignID)); err != nil {
		return pgx.ErrNoRows
	}
	return tx.QueryRow(ctx, `
SELECT 1
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, campaignID).Scan(new(int))
}

// SubscriberTimeseriesPoint is one daily cumulative subscriber-count bucket.
type SubscriberTimeseriesPoint struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

// SubscriberTimeseries returns cumulative enabled-subscriber totals at
// end-of-day for the last N days. It intentionally uses the subscribers
// table directly instead of materialized analytics state so the dashboard
// reflects imports and manual subscriber edits immediately.
func (s *Service) SubscriberTimeseries(ctx context.Context, tenantID string, days int) ([]SubscriberTimeseriesPoint, error) {
	if days <= 0 {
		days = 30
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Audit fix BE-3: previously a correlated COUNT(*) ran per
	// generated day — N index range scans on subscribers (1M+ rows).
	// Rewritten as one baseline COUNT + a single pre-aggregated
	// daily_adds + a window SUM, so the planner does one indexed
	// pass over the relevant date range instead of 90 separate scans.
	rows, err := tx.Query(ctx, `
WITH days AS (
  SELECT generate_series(
    (date_trunc('day', now()) - (($2::int - 1) * interval '1 day'))::date,
    date_trunc('day', now())::date,
    interval '1 day'
  )::date AS day
),
daily_adds AS (
  SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS new_count
    FROM subscribers
   WHERE tenant_id = $1::uuid
     AND status    = 'enabled'
     AND created_at >= (date_trunc('day', now()) - (($2::int - 1) * interval '1 day'))::date
   GROUP BY 1
),
baseline AS (
  SELECT COUNT(*)::int AS base
    FROM subscribers
   WHERE tenant_id = $1::uuid
     AND status    = 'enabled'
     AND created_at < (date_trunc('day', now()) - (($2::int - 1) * interval '1 day'))::date
)
SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
       ((SELECT base FROM baseline)
         + COALESCE(SUM(a.new_count) OVER (ORDER BY d.day), 0))::int AS count
  FROM days d
  LEFT JOIN daily_adds a ON a.day = d.day
 ORDER BY d.day ASC`, tenantID, days)
	if err != nil {
		return nil, fmt.Errorf("subscriber timeseries query: %w", err)
	}
	defer rows.Close()
	out := make([]SubscriberTimeseriesPoint, 0, days)
	for rows.Next() {
		var p SubscriberTimeseriesPoint
		if err := rows.Scan(&p.Date, &p.Count); err != nil {
			return nil, fmt.Errorf("subscriber timeseries scan: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("subscriber timeseries rows: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ----------------------------------------------------------------------
// Per-group time series (A19, desktop audit 2026-06-10)
// ----------------------------------------------------------------------

// TimeseriesPoint is one daily bucket in a grouped time series.
type TimeseriesPoint struct {
	Date  string `json:"date"` // YYYY-MM-DD
	Value int    `json:"value"`
}

// TimeseriesSeries is one group's daily series.
type TimeseriesSeries struct {
	Key    string            `json:"key"`   // group identity (campaign id, domain, or "other")
	Label  string            `json:"label"` // display name (campaign name, domain, "Other")
	Points []TimeseriesPoint `json:"points"`
}

// GroupedTimeseries limits.
const (
	groupedTimeseriesMaxDays   = 90
	groupedTimeseriesTopGroups = 10
)

// timeseriesOtherKey is the bucket that absorbs everything past the
// top-N groups so the payload stays bounded regardless of cardinality.
const timeseriesOtherKey = "other"

// groupedTimeseriesMetrics whitelists ?metric= values to event types.
var groupedTimeseriesMetrics = map[string]string{
	"opens":   "opened",
	"clicks":  "clicked",
	"bounces": "bounced",
}

// groupedTimeseriesKeyExpr whitelists ?group_by= values to the SQL key
// expression. Only dimensions answerable by a simple GROUP BY over
// existing campaign_report_events columns are listed:
//
//   - campaign: campaign_id — served by the
//     (tenant_id, campaign_id, event_type, at DESC) index.
//   - domain: recipient domain derived from subscriber_email — same
//     tenant-window scan class as the dashboard sparkline queries.
//
// "list" is deliberately ABSENT: events carry no list_id and the
// campaign<->list mapping lives in the Listmonk engine as a
// many-to-many, so attributing an event to a list would require new
// attribution data on the write path. The handler returns a structured
// 400 for it so the desktop can keep the dimension disabled honestly.
var groupedTimeseriesKeyExpr = map[string]string{
	"campaign": "e.campaign_id::text",
	"domain":   "COALESCE(NULLIF(lower(split_part(e.subscriber_email::text, '@', 2)), ''), 'unknown')",
}

// GroupedTimeseries returns daily counts of one engagement metric for
// the last `days` days, broken down by `groupBy` (campaign | domain).
// Groups are capped at the top-10 by total volume; the remainder is
// rolled into a trailing "other" series. Each series is zero-filled to
// exactly `days` points so charts can render without client-side gap
// handling.
// filter is the F01 classification band; the zero value is unset and emits the
// exact SQL this function shipped with. `metric=bounces` under an active band
// is rejected by the handler rather than answered: a bounce is not an
// interaction the F01 classifier ever classifies, so every band would be a
// misleading answer to a question with no meaning.
func (s *Service) GroupedTimeseries(
	ctx context.Context, tenantID, groupBy, metric string, days int, filter ClassificationFilter,
) ([]TimeseriesSeries, error) {
	keyExpr, ok := groupedTimeseriesKeyExpr[groupBy]
	if !ok {
		return nil, fmt.Errorf("analytics: unsupported group_by %q", groupBy)
	}
	eventType, ok := groupedTimeseriesMetrics[metric]
	if !ok {
		return nil, fmt.Errorf("analytics: unsupported metric %q", metric)
	}
	if filter.Active() && eventType == "bounced" {
		return nil, fmt.Errorf("%w: bounces carry no engagement classification",
			ErrUnsupportedClassification)
	}
	if days <= 0 {
		days = 30
	}
	if days > groupedTimeseriesMaxDays {
		days = groupedTimeseriesMaxDays
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// One pass over the tenant's window: pre-aggregate per (key, day),
	// rank keys by total volume, fold non-top-10 keys into 'other'.
	// keyExpr comes from the whitelist map above — no injection vector
	// despite the %s.
	q := fmt.Sprintf(`
WITH bucketed AS (
  SELECT %s AS key,
         date_trunc('day', e.at)::date AS day,
         count(*)::int AS n
    FROM campaign_report_events e
   WHERE e.tenant_id = $1::uuid
     AND e.event_type = $2
     AND e.at >= date_trunc('day', now()) - (($3::int - 1) * interval '1 day')%s
   GROUP BY 1, 2
),
top AS (
  SELECT key
    FROM bucketed
   GROUP BY key
   ORDER BY SUM(n) DESC, key ASC
   LIMIT %d
)
SELECT CASE WHEN t.key IS NULL THEN '%s' ELSE b.key END AS key,
       to_char(b.day, 'YYYY-MM-DD') AS date,
       SUM(b.n)::int AS n
  FROM bucketed b
  LEFT JOIN top t ON t.key = b.key
 GROUP BY 1, 2
 ORDER BY 1, 2`, keyExpr, andWhere(filter.campaignReportEventExpr("e")),
		groupedTimeseriesTopGroups, timeseriesOtherKey)

	rows, err := tx.Query(ctx, q, tenantID, eventType, days)
	if err != nil {
		return nil, fmt.Errorf("grouped timeseries query: %w", err)
	}
	type cell struct {
		key, date string
		n         int
	}
	cells := []cell{}
	for rows.Next() {
		var c cell
		if err := rows.Scan(&c.key, &c.date, &c.n); err != nil {
			rows.Close()
			return nil, fmt.Errorf("grouped timeseries scan: %w", err)
		}
		cells = append(cells, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("grouped timeseries rows: %w", err)
	}

	byKey := map[string]map[string]int{}
	totals := map[string]int{}
	for _, c := range cells {
		m, ok := byKey[c.key]
		if !ok {
			m = map[string]int{}
			byKey[c.key] = m
		}
		m[c.date] += c.n
		totals[c.key] += c.n
	}

	labels := map[string]string{}
	if groupBy == "campaign" {
		ids := make([]string, 0, len(byKey))
		for k := range byKey {
			if k != timeseriesOtherKey {
				ids = append(ids, k)
			}
		}
		if len(ids) > 0 {
			lr, err := tx.Query(ctx, `
SELECT id::text, name FROM campaigns
 WHERE tenant_id = $1::uuid AND id = ANY ($2::uuid[])`, tenantID, ids)
			if err != nil {
				return nil, fmt.Errorf("grouped timeseries labels: %w", err)
			}
			for lr.Next() {
				var id, name string
				if err := lr.Scan(&id, &name); err != nil {
					lr.Close()
					return nil, err
				}
				labels[id] = name
			}
			lr.Close()
			if err := lr.Err(); err != nil {
				return nil, err
			}
		}
	}

	out := assembleTimeseries(byKey, totals, labels, timeseriesDates(time.Now(), days))
	return out, tx.Commit(ctx)
}

// timeseriesDates returns `days` YYYY-MM-DD strings ending today (local
// server day, matching the date_trunc('day', now()) bucketing).
func timeseriesDates(now time.Time, days int) []string {
	out := make([]string, 0, days)
	day := now.AddDate(0, 0, -(days - 1))
	for i := 0; i < days; i++ {
		out = append(out, day.AddDate(0, 0, i).Format("2006-01-02"))
	}
	return out
}

// assembleTimeseries turns the (key -> date -> count) aggregation into
// the wire shape: series sorted by total volume descending (ties by
// key), "other" forced last, each zero-filled over `dates`. Pure
// function for unit testing.
func assembleTimeseries(
	byKey map[string]map[string]int,
	totals map[string]int,
	labels map[string]string,
	dates []string,
) []TimeseriesSeries {
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		if k != timeseriesOtherKey {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if totals[keys[i]] != totals[keys[j]] {
			return totals[keys[i]] > totals[keys[j]]
		}
		return keys[i] < keys[j]
	})
	if _, ok := byKey[timeseriesOtherKey]; ok {
		keys = append(keys, timeseriesOtherKey)
	}

	out := make([]TimeseriesSeries, 0, len(keys))
	for _, k := range keys {
		label := labels[k]
		if label == "" {
			label = k
		}
		if k == timeseriesOtherKey {
			label = "Other"
		}
		points := make([]TimeseriesPoint, 0, len(dates))
		for _, d := range dates {
			points = append(points, TimeseriesPoint{Date: d, Value: byKey[k][d]})
		}
		out = append(out, TimeseriesSeries{Key: k, Label: label, Points: points})
	}
	return out
}

// LinkReport returns the per-link click breakdown for one campaign.
//
// filter is the F01 classification band. The CTR denominator (campaign
// recipients) is never filtered — only the clicks are — so `classification=human`
// answers "what fraction of recipients had a HUMAN click on this link", not a
// ratio between two differently-defined populations.
func (s *Service) LinkReport(
	ctx context.Context, tenantID, campaignID string, filter ClassificationFilter,
) ([]LinkRow, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureOwnedCampaign(ctx, tx, tenantID, campaignID); err != nil {
		return nil, fmt.Errorf("link report campaign ownership: %w", err)
	}

	const totalsQ = `
	SELECT COALESCE(
	         NULLIF(COUNT(*) FILTER (WHERE status = 'sent'), 0),
	         COUNT(*) FILTER (WHERE status <> 'cancelled')
	       )
	  FROM campaign_recipients
	 WHERE tenant_id = $2::uuid
	   AND campaign_id = $1::uuid`
	var totalRecipients int
	if err := tx.QueryRow(ctx, totalsQ, campaignID, tenantID).Scan(&totalRecipients); err != nil {
		return nil, fmt.Errorf("link report totals: %w", err)
	}

	q := `
SELECT link_url,
       COUNT(*)                      AS clicks,
       COUNT(DISTINCT subscriber_email) AS unique_clickers
	  FROM subscriber_events se
	 WHERE tenant_id = $2::uuid
	   AND campaign_id = $1::uuid
	   AND event_type  = 'clicked'
	   AND link_url IS NOT NULL` +
		andWhere(filter.subscriberEventExpr("se")) + `
	 GROUP BY link_url
	 ORDER BY clicks DESC, link_url ASC`

	rows, err := tx.Query(ctx, q, campaignID, tenantID)
	if err != nil {
		return nil, fmt.Errorf("link report query: %w", err)
	}
	defer rows.Close()

	out := []LinkRow{}
	for rows.Next() {
		var r LinkRow
		if err := rows.Scan(&r.URL, &r.Clicks, &r.UniqueClickers); err != nil {
			return nil, err
		}
		if totalRecipients > 0 {
			r.CTR = float64(r.UniqueClickers) / float64(totalRecipients)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ReportRows builds the per-subscriber lifecycle rows for the CSV export,
// honoring offset/limit for pagination.
func (s *Service) ReportRows(ctx context.Context, tenantID, campaignID string, limit, offset int) ([]CSVReportRow, int, error) {
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if limit <= 0 || limit > campaignReportCSVMaxRows {
		limit = campaignReportCSVMaxRows
	}
	if offset < 0 {
		offset = 0
	}

	// Do not let an unknown or foreign campaign collapse into an
	// indistinguishable successful empty export. RLS plus the tenant predicate
	// deliberately gives both cases the same non-disclosing ErrNoRows result.
	if err := tx.QueryRow(ctx, `
SELECT 1
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, campaignID).Scan(new(int)); err != nil {
		return nil, 0, fmt.Errorf("report campaign ownership: %w", err)
	}

	const totalQ = `
	SELECT COUNT(DISTINCT lower(subscriber_email::text))
	  FROM campaign_recipients
	 WHERE tenant_id = $2::uuid
	   AND campaign_id = $1::uuid
	   AND status <> 'cancelled'`
	var total int
	if err := tx.QueryRow(ctx, totalQ, campaignID, tenantID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("report total: %w", err)
	}

	const q = `
WITH recipients AS (
	SELECT MIN(subscriber_email::text) AS subscriber_email,
	       MIN(sent_at) FILTER (WHERE status = 'sent') AS sent_at
	  FROM campaign_recipients
	 WHERE tenant_id = $4::uuid
	   AND campaign_id = $1::uuid
	   AND status <> 'cancelled'
	 GROUP BY lower(subscriber_email::text)
	 ORDER BY lower(subscriber_email::text), MIN(subscriber_email::text)
	 LIMIT $2 OFFSET $3
)
SELECT r.subscriber_email,
	       r.sent_at,
	       MIN(at) FILTER (WHERE event_type = 'delivered')     AS delivered_at,
	       MIN(at) FILTER (WHERE event_type = 'opened')        AS opened_at,
	       MIN(at) FILTER (WHERE event_type = 'clicked')       AS first_click_at,
	       COUNT(*)  FILTER (WHERE event_type = 'clicked')     AS click_count,
	       MIN(at) FILTER (WHERE event_type = 'bounced')       AS bounced_at,
	       MIN(at) FILTER (WHERE event_type = 'complained')    AS complained_at,
	       MIN(at) FILTER (WHERE event_type = 'unsubscribed')  AS unsubscribed_at
  FROM recipients r
  LEFT JOIN subscriber_events e
    ON e.tenant_id = $4::uuid
   AND e.campaign_id = $1::uuid
   AND lower(e.subscriber_email::text) = lower(r.subscriber_email)
 GROUP BY r.subscriber_email, r.sent_at
 ORDER BY lower(r.subscriber_email), r.subscriber_email`

	rows, err := tx.Query(ctx, q, campaignID, limit, offset, tenantID)
	if err != nil {
		return nil, 0, fmt.Errorf("report rows query: %w", err)
	}
	defer rows.Close()

	out := []CSVReportRow{}
	for rows.Next() {
		var r CSVReportRow
		var sent, delivered, opened, click, bounced, complained, unsub *time.Time
		if err := rows.Scan(
			&r.SubscriberEmail,
			&sent,
			&delivered,
			&opened,
			&click,
			&r.ClickCount,
			&bounced,
			&complained,
			&unsub,
		); err != nil {
			return nil, 0, fmt.Errorf("report rows scan: %w", err)
		}
		if sent != nil {
			r.SentAt = *sent
		}
		if delivered != nil {
			r.DeliveredAt = *delivered
		}
		if opened != nil {
			r.OpenedAt = *opened
		}
		if click != nil {
			r.FirstClickAt = *click
		}
		if bounced != nil {
			r.BouncedAt = *bounced
		}
		if complained != nil {
			r.ComplainedAt = *complained
		}
		if unsub != nil {
			r.UnsubscribedAt = *unsub
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("report rows iteration: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, fmt.Errorf("report snapshot commit: %w", err)
	}
	return out, total, nil
}

// Compare returns side-by-side metrics for the given campaign ids.
// filter is the F01 classification band. interactionOnly keeps it away from the
// bounce / complaint / unsubscribe counts in the same pass: those are not
// interactions the classifier ever classifies, and zeroing them under
// `classification=human` would make a bouncing campaign look clean.
func (s *Service) Compare(
	ctx context.Context, tenantID string, ids []string, filter ClassificationFilter,
) ([]CompareRow, error) {
	if len(ids) == 0 {
		return []CompareRow{}, nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := `
WITH recipients AS (
  SELECT campaign_id,
         COALESCE(
           NULLIF(COUNT(*) FILTER (WHERE status = 'sent'), 0),
           COUNT(*) FILTER (WHERE status <> 'cancelled')
         ) AS recipients
    FROM campaign_recipients
   WHERE tenant_id = $2::uuid
     AND campaign_id = ANY ($1::uuid[])
   GROUP BY campaign_id
),
compatibility_events AS (
  -- Imported/legacy reports can have delivery receipts without a dispatch
  -- recipient snapshot. Use those facts only when no snapshot exists, so
  -- mirrored receipts cannot double-count an ordinary dispatched campaign.
  SELECT cre.*
    FROM campaign_report_events cre
   WHERE cre.tenant_id = $2::uuid
     AND cre.campaign_id = ANY ($1::uuid[])
     AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = cre.campaign_id)` +
		andWhere(interactionOnly("cre", filter.campaignReportEventExpr("cre"))) + `
),
all_recipients AS (
  SELECT campaign_id, recipients FROM recipients
  UNION ALL
  SELECT campaign_id, COUNT(DISTINCT subscriber_email) FILTER (WHERE event_type = 'sent') AS recipients
    FROM compatibility_events
   GROUP BY campaign_id
),
interaction_events AS (
  SELECT campaign_id, subscriber_email, event_type
    FROM subscriber_events se
   WHERE tenant_id = $2::uuid
     AND campaign_id = ANY ($1::uuid[])
     AND EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = se.campaign_id)` +
		andWhere(interactionOnly("se", filter.subscriberEventExpr("se"))) + `
  UNION ALL
  SELECT campaign_id, subscriber_email, event_type FROM compatibility_events
),
events AS (
  SELECT campaign_id,
         COUNT(DISTINCT subscriber_email)
           FILTER (WHERE event_type = 'opened')                  AS opens,
         COUNT(DISTINCT subscriber_email)
           FILTER (WHERE event_type = 'clicked')                 AS clicks,
         COUNT(DISTINCT subscriber_email)
           FILTER (WHERE event_type = 'bounced')                 AS bounces,
         COUNT(DISTINCT subscriber_email)
           FILTER (WHERE event_type = 'complained')              AS complaints,
         COUNT(DISTINCT subscriber_email)
           FILTER (WHERE event_type = 'unsubscribed')            AS unsubs
    FROM interaction_events
   GROUP BY campaign_id
)
SELECT r.campaign_id::text,
       r.recipients,
       COALESCE(e.opens, 0),
       COALESCE(e.clicks, 0),
       COALESCE(e.bounces, 0),
       COALESCE(e.complaints, 0),
       COALESCE(e.unsubs, 0)
  FROM all_recipients r
  LEFT JOIN events e ON e.campaign_id = r.campaign_id`

	rows, err := tx.Query(ctx, q, ids, tenantID)
	if err != nil {
		return nil, fmt.Errorf("compare query: %w", err)
	}
	defer rows.Close()

	byID := map[string]CompareRow{}
	for rows.Next() {
		var cr CompareRow
		var opens, clicks, bounces, complaints, unsubs int
		if err := rows.Scan(&cr.CampaignID, &cr.TotalRecipients, &opens, &clicks,
			&bounces, &complaints, &unsubs); err != nil {
			return nil, err
		}
		if cr.TotalRecipients > 0 {
			d := float64(cr.TotalRecipients)
			cr.OpenRate = float64(opens) / d
			cr.ClickRate = float64(clicks) / d
			cr.BounceRate = float64(bounces) / d
			cr.ComplaintRate = float64(complaints) / d
			cr.UnsubRate = float64(unsubs) / d
		}
		byID[cr.CampaignID] = cr
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]CompareRow, 0, len(ids))
	for _, id := range ids {
		if r, ok := byID[id]; ok {
			out = append(out, r)
			continue
		}
		out = append(out, CompareRow{CampaignID: id})
	}
	return out, tx.Commit(ctx)
}

// Geography returns per-country open/click totals for one campaign.
// filter is the F01 classification band. Geography is the surface where the
// blend is most visibly wrong: a datacentre-hosted scanner reports the country
// of the scanner, so an unfiltered map can invent an audience in a region where
// the sender has no subscribers at all.
func (s *Service) Geography(
	ctx context.Context, tenantID, campaignID string, filter ClassificationFilter,
) ([]GeographyRow, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureOwnedCampaign(ctx, tx, tenantID, campaignID); err != nil {
		return nil, fmt.Errorf("geography campaign ownership: %w", err)
	}

	// Audit fix BE-4: explicit tenant_id predicate alongside the RLS
	// GUC so the planner picks the (tenant_id, campaign_id, event_type)
	// covering index instead of a filtered scan over all events.
	q := `
SELECT COALESCE(country, 'unknown') AS country,
       COUNT(*) FILTER (WHERE event_type = 'opened')  AS opens,
       COUNT(*) FILTER (WHERE event_type = 'clicked') AS clicks
  FROM subscriber_events se
 WHERE tenant_id   = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type IN ('opened','clicked')` +
		andWhere(filter.subscriberEventExpr("se")) + `
 GROUP BY COALESCE(country, 'unknown')
 ORDER BY opens DESC, clicks DESC`

	rows, err := tx.Query(ctx, q, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []GeographyRow{}
	for rows.Next() {
		var r GeographyRow
		if err := rows.Scan(&r.Country, &r.Opens, &r.Clicks); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Devices returns per-mail-client open/click totals for one campaign.
// filter is the F01 classification band. The client breakdown is the single
// most machine-contaminated table in the product: Apple Mail Privacy Protection
// and Gmail's image proxy are user agents, so an unfiltered chart reports the
// prefetcher as the most popular mail client the sender's audience uses.
func (s *Service) Devices(
	ctx context.Context, tenantID, campaignID string, filter ClassificationFilter,
) ([]DeviceRow, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureOwnedCampaign(ctx, tx, tenantID, campaignID); err != nil {
		return nil, fmt.Errorf("devices campaign ownership: %w", err)
	}

	// Audit fix BE-4: tenant_id predicate for planner-friendliness.
	q := `
SELECT COALESCE(user_agent, '') AS ua,
       COUNT(*) FILTER (WHERE event_type = 'opened')  AS opens,
       COUNT(*) FILTER (WHERE event_type = 'clicked') AS clicks
  FROM subscriber_events se
 WHERE tenant_id   = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type IN ('opened','clicked')` +
		andWhere(filter.subscriberEventExpr("se")) + `
 GROUP BY COALESCE(user_agent, '')`

	rows, err := tx.Query(ctx, q, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	agg := map[string]*DeviceRow{}
	for rows.Next() {
		var ua string
		var opens, clicks int
		if err := rows.Scan(&ua, &opens, &clicks); err != nil {
			return nil, err
		}
		c := ClassifyClient(ua)
		cur := agg[c]
		if cur == nil {
			cur = &DeviceRow{Client: c}
			agg[c] = cur
		}
		cur.Opens += opens
		cur.Clicks += clicks
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]DeviceRow, 0, len(agg))
	for _, v := range agg {
		out = append(out, *v)
	}
	sortDeviceRows(out)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func sortDeviceRows(rows []DeviceRow) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Opens != rows[j].Opens {
			return rows[i].Opens > rows[j].Opens
		}
		if rows[i].Clicks != rows[j].Clicks {
			return rows[i].Clicks > rows[j].Clicks
		}
		return rows[i].Client < rows[j].Client
	})
}

// Bounces returns the categorized bounce summary for a campaign.
func (s *Service) Bounces(ctx context.Context, tenantID, campaignID string) (BounceCounts, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return BounceCounts{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureOwnedCampaign(ctx, tx, tenantID, campaignID); err != nil {
		return BounceCounts{}, fmt.Errorf("bounces campaign ownership: %w", err)
	}

	// Audit fix BE-4: tenant_id predicate for planner-friendliness.
	const q = `
SELECT COALESCE(bounce_type, '') AS bt, COUNT(*)
  FROM subscriber_events
 WHERE tenant_id   = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type  = 'bounced'
 GROUP BY COALESCE(bounce_type, '')`

	rows, err := tx.Query(ctx, q, tenantID, campaignID)
	if err != nil {
		return BounceCounts{}, err
	}
	defer rows.Close()

	var bc BounceCounts
	for rows.Next() {
		var bt string
		var n int
		if err := rows.Scan(&bt, &n); err != nil {
			return BounceCounts{}, err
		}
		bc.Total += n
		switch CategorizeBounce(bt) {
		case "hard":
			bc.Hard += n
		case "soft":
			bc.Soft += n
		case "spam_trap":
			bc.SpamTrap += n
		}
	}
	if err := rows.Err(); err != nil {
		return BounceCounts{}, err
	}
	return bc, tx.Commit(ctx)
}

// Cohorts builds the cohort matrix for the past 12 signup-month cohorts.
//
// Metric definitions:
//
//	open_rate / click_rate: distinct subscribers in the cohort with at least
//	  one matching event during week N, divided by cohort_size.
//	retention: distinct subscribers in the cohort with at least one positive
//	  engagement event (opened, clicked, or replied) during week N, divided
//	  by cohort_size. Delivery and negative lifecycle events are deliberately
//	  excluded because they do not demonstrate continued subscriber activity.
//
// Week N is measured from each subscriber's own created_at timestamp, not the
// first day of the cohort month. A week is returned only after every subscriber
// in that monthly cohort has completed it; immature trailing weeks are omitted
// instead of being represented by misleading zeroes.
func (s *Service) Cohorts(ctx context.Context, tenantID, bucket, metric string, weeks int) ([]CohortRow, error) {
	if weeks <= 0 {
		weeks = 12
	}
	if weeks > 26 {
		weeks = 26
	}
	if bucket == "" {
		bucket = "month"
	}
	if bucket != "month" {
		return nil, fmt.Errorf("analytics: only bucket=month is supported")
	}
	eventFilter, err := metricEventFilter(metric)
	if err != nil {
		return nil, err
	}

	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Audit fixes BE-1 + BE-6: previously this issued 13 queries
	// (1 cohort-list + 12 cohort-hits) and the cohort-list query
	// omitted the tenant_id predicate, forcing RLS to filter post-
	// scan instead of using the (tenant_id, created_at) index. Now
	// 2 queries total, both with explicit tenant_id WHEREs and one
	// repeatable-read snapshot so cohort sizes and event numerators cannot
	// observe different concurrent states.
	const cohortQ = `
SELECT date_trunc('month', created_at)::date AS cohort_start,
       COUNT(*)                              AS cohort_size,
       MAX(created_at)                       AS latest_signup,
       now()                                 AS as_of
  FROM subscribers
 WHERE tenant_id = $1::uuid
 GROUP BY 1
 ORDER BY 1 DESC
 LIMIT 12`

	cohortRows, err := tx.Query(ctx, cohortQ, tenantID)
	if err != nil {
		return nil, fmt.Errorf("cohort sizes: %w", err)
	}
	type cohortMeta struct {
		start       time.Time
		size        int
		matureWeeks int
	}
	cohorts := []cohortMeta{}
	for cohortRows.Next() {
		var c cohortMeta
		var latestSignup, asOf time.Time
		if err := cohortRows.Scan(&c.start, &c.size, &latestSignup, &asOf); err != nil {
			cohortRows.Close()
			return nil, err
		}
		c.matureWeeks = matureCohortWeekCount(asOf, latestSignup, weeks)
		cohorts = append(cohorts, c)
	}
	cohortRows.Close()
	if err := cohortRows.Err(); err != nil {
		return nil, err
	}
	if len(cohorts) == 0 {
		return []CohortRow{}, tx.Commit(ctx)
	}

	// Build a single hits query covering ALL cohorts: pull subscriber
	// → cohort assignment in a CTE, then aggregate hits per
	// (cohort, week_idx). RLS gates subscriber_events; we still add
	// tenant_id = $1 to make the planner pick the
	// (tenant_id, subscriber_email, ...) index instead of falling
	// back to a filtered scan.
	//
	// `eventFilter` is whitelisted by metricEventFilter to a fixed
	// string set — no SQL injection vector despite the %s.
	earliest := cohorts[len(cohorts)-1].start
	hitsQ := fmt.Sprintf(`
WITH cohort_subs AS (
  SELECT email,
         created_at AS signup_at,
         date_trunc('month', created_at)::date AS cohort
    FROM subscribers
   WHERE tenant_id = $1::uuid
     AND created_at >= $3::date
)
SELECT cs.cohort,
       FLOOR(EXTRACT(EPOCH FROM (e.at - cs.signup_at)) / 604800.0)::int AS week_idx,
       COUNT(DISTINCT e.subscriber_email) AS hits
  FROM cohort_subs cs
  JOIN subscriber_events e
    ON e.tenant_id   = $1::uuid
   AND e.subscriber_email = cs.email
   AND e.at >= cs.signup_at
   AND e.at <  cs.signup_at + ($2::int * INTERVAL '1 week')
   %s
 GROUP BY cs.cohort, week_idx`, eventFilter)

	hitsByCohort := map[time.Time][]float64{}
	hitRows, err := tx.Query(ctx, hitsQ, tenantID, weeks, earliest)
	if err != nil {
		return nil, fmt.Errorf("cohort hits: %w", err)
	}
	for hitRows.Next() {
		var start time.Time
		var idx, hits int
		if err := hitRows.Scan(&start, &idx, &hits); err != nil {
			hitRows.Close()
			return nil, err
		}
		w, ok := hitsByCohort[start]
		if !ok {
			w = make([]float64, weeks)
			hitsByCohort[start] = w
		}
		if idx >= 0 && idx < weeks {
			// Store raw counts; divide by cohort_size in the assembly
			// loop below where we have the size in scope.
			w[idx] = float64(hits)
		}
	}
	hitRows.Close()
	if err := hitRows.Err(); err != nil {
		return nil, err
	}

	out := make([]CohortRow, 0, len(cohorts))
	for _, c := range cohorts {
		row := CohortRow{
			CohortLabel: c.start.Format("2006-01"),
			CohortSize:  c.size,
			Weeks:       make([]float64, c.matureWeeks),
		}
		if c.size == 0 {
			out = append(out, row)
			continue
		}
		if raw, ok := hitsByCohort[c.start]; ok {
			for i, hits := range raw[:c.matureWeeks] {
				row.Weeks[i] = hits / float64(c.size)
			}
		}
		out = append(out, row)
	}
	return out, tx.Commit(ctx)
}

func matureCohortWeekCount(asOf, latestSignup time.Time, requestedWeeks int) int {
	if requestedWeeks <= 0 || !asOf.After(latestSignup) {
		return 0
	}
	completed := int(asOf.Sub(latestSignup) / (7 * 24 * time.Hour))
	if completed < 0 {
		return 0
	}
	if completed > requestedWeeks {
		return requestedWeeks
	}
	return completed
}

func metricEventFilter(metric string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(metric)) {
	case "", "retention":
		return "AND e.event_type IN ('opened','clicked','replied')", nil
	case "open_rate":
		return "AND e.event_type = 'opened'", nil
	case "click_rate":
		return "AND e.event_type = 'clicked'", nil
	}
	return "", fmt.Errorf("analytics: unsupported metric %q", metric)
}

// subscriberFunnelMaxCohorts caps how many signup-month cohorts the funnel
// returns so the payload stays bounded regardless of tenant age.
const subscriberFunnelMaxCohorts = 24

// SubscriberFunnel builds the subscriber cohort funnel (SUB-128):
// signup → first-purchase → repeat-purchase, bucketed by signup-month
// cohort. Conversions are computed from commerce_orders joined to
// subscribers by (case-insensitive) email — a subscriber counts as a
// first-purchaser when it has >= 1 currently paid order at or after signup,
// and a repeat-purchaser when it has >= 2. Pending, cancelled, refunded,
// pre-signup, and future-dated orders are excluded. The signup stage is every
// subscriber in the cohort (one row per subscriber by construction).
//
// This is a lifetime-to-date snapshot rather than a fixed conversion window:
// older cohorts have had more time to purchase than newer cohorts.
//
// `bucket` is currently always "month" (the only cohort granularity the
// subscribers.created_at index supports cheaply). `weeks` bounds how many
// trailing cohorts to enumerate (interpreted as months here, capped at
// subscriberFunnelMaxCohorts). `audienceID`, when non-empty, scopes the
// funnel to subscribers tagged with that audience tag (tag-based audience
// filtering, reusing subscribers.tags).
func (s *Service) SubscriberFunnel(ctx context.Context, tenantID, bucket, cohortBy, audienceID string, weeks int) (*SubscriberFunnel, error) {
	if bucket == "" {
		bucket = "month"
	}
	if bucket != "month" {
		return nil, fmt.Errorf("analytics: only bucket=month is supported")
	}
	if cohortBy == "" {
		cohortBy = "created_at_month"
	}
	if cohortBy != "created_at_month" {
		return nil, fmt.Errorf("analytics: only cohort_by=created_at_month is supported")
	}
	months := weeks
	if months <= 0 {
		months = 12
	}
	if months > subscriberFunnelMaxCohorts {
		months = subscriberFunnelMaxCohorts
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// One pass, CTE-based — mirrors the campaign cohort query shape:
	//   cohort_subs: subscribers in the trailing N signup-month cohorts,
	//                optionally narrowed to a tagged audience.
	//   joined:      each subscriber decorated with the number of currently
	//                paid orders recorded from signup through this snapshot.
	// Aggregation then counts, per cohort: signups, first-purchasers
	// (order_count >= 1), repeat-purchasers (order_count >= 2).
	//
	// The audience filter is parameterised ($3 = '' means "no filter"); the
	// tag membership uses the same `= ANY(subscribers.tags)` idiom the
	// segment compiler uses, so it rides the subscribers_tags_gin index.
	const q = `
WITH cohort_subs AS (
  SELECT s.id,
         s.email                                    AS email,
         s.created_at                               AS signup_at,
         date_trunc('month', s.created_at)::date    AS cohort
    FROM subscribers s
   WHERE s.tenant_id = $1::uuid
     AND s.created_at >= date_trunc('month', now()) - (($2::int - 1) * interval '1 month')
     AND ($3 = '' OR $3 = ANY(s.tags))
),
joined AS (
  SELECT cs.cohort,
         cs.id,
         count(o.id)::int AS order_count
    FROM cohort_subs cs
    LEFT JOIN commerce_orders o
      ON o.tenant_id = $1::uuid
     AND o.customer_email = cs.email
     AND o.status = 'paid'
     AND o.ordered_at >= cs.signup_at
     AND o.ordered_at <= now()
   GROUP BY cs.cohort, cs.id
)
SELECT to_char(cohort, 'YYYY-MM')                         AS cohort_label,
       count(*)::int                                      AS signup_count,
       count(*) FILTER (WHERE order_count >= 1)::int      AS first_purchase_count,
       count(*) FILTER (WHERE order_count >= 2)::int      AS repeat_purchase_count
  FROM joined
 GROUP BY cohort
 ORDER BY cohort DESC`

	rows, err := tx.Query(ctx, q, tenantID, months, strings.TrimSpace(audienceID))
	if err != nil {
		return nil, fmt.Errorf("subscriber funnel query: %w", err)
	}
	defer rows.Close()

	out := &SubscriberFunnel{
		Bucket:   bucket,
		CohortBy: cohortBy,
		Steps:    []SubscriberFunnelStep{},
		Cohorts:  []CohortFunnelRow{},
	}
	var totalSignup, totalFirst, totalRepeat int
	for rows.Next() {
		var r CohortFunnelRow
		if err := rows.Scan(&r.CohortLabel, &r.SignupCount,
			&r.FirstPurchaseCount, &r.RepeatPurchaseCount); err != nil {
			return nil, fmt.Errorf("subscriber funnel scan: %w", err)
		}
		r.FirstPurchaseRate = pct(r.FirstPurchaseCount, r.SignupCount)
		// Repeat rate is relative to first-purchasers — the prior stage.
		r.RepeatPurchaseRate = pct(r.RepeatPurchaseCount, r.FirstPurchaseCount)
		totalSignup += r.SignupCount
		totalFirst += r.FirstPurchaseCount
		totalRepeat += r.RepeatPurchaseCount
		out.Cohorts = append(out.Cohorts, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("subscriber funnel rows: %w", err)
	}

	out.Steps = []SubscriberFunnelStep{
		{Stage: "signup", Label: "Signed Up", Count: totalSignup, ConversionRate: 100},
		{Stage: "first_purchase", Label: "First Purchase", Count: totalFirst, ConversionRate: pct(totalFirst, totalSignup)},
		{Stage: "repeat_purchase", Label: "Repeat Purchase", Count: totalRepeat, ConversionRate: pct(totalRepeat, totalFirst)},
	}

	return out, tx.Commit(ctx)
}

// AttributionWindowDays is the lookback used by Revenue.
const AttributionWindowDays = 7

// Revenue computes attributed revenue for one campaign. It returns a zero
// report with note="no_billing_data" when the underlying paid_subscriptions
// table is missing.
func (s *Service) Revenue(ctx context.Context, tenantID, campaignID string) (RevenueReport, error) {
	out := RevenueReport{
		AttributionWindowDays: AttributionWindowDays,
		Currency:              "usd",
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureOwnedCampaign(ctx, tx, tenantID, campaignID); err != nil {
		return out, fmt.Errorf("revenue campaign ownership: %w", err)
	}

	exists, err := tableExists(ctx, tx, "paid_subscriptions")
	if err != nil {
		return out, err
	}
	if !exists {
		out.Note = "no_billing_data"
		return out, tx.Commit(ctx)
	}

	const q = `
WITH opens AS (
  SELECT subscriber_email, MAX(at) AS last_open
    FROM subscriber_events
   WHERE campaign_id = $1::uuid
     AND event_type  = 'opened'
   GROUP BY subscriber_email
)
SELECT COALESCE(SUM(p.amount_cents), 0)::bigint AS revenue,
       COUNT(*)::int                            AS conversions
  FROM paid_subscriptions p
  JOIN opens o ON o.subscriber_email = p.subscriber_email
 WHERE p.created_at BETWEEN o.last_open AND o.last_open + ($2::int * INTERVAL '1 day')`

	if err := tx.QueryRow(ctx, q, campaignID, AttributionWindowDays).
		Scan(&out.AttributedRevenueCents, &out.Conversions); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, tx.Commit(ctx)
		}
		return out, fmt.Errorf("revenue: %w", err)
	}
	return out, tx.Commit(ctx)
}

func tableExists(ctx context.Context, tx pgx.Tx, name string) (bool, error) {
	var ok bool
	err := tx.QueryRow(ctx,
		`SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = $1
        )`,
		name,
	).Scan(&ok)
	return ok, err
}

// AttributedAt picks the most recent open within the attribution window
// preceding `paidAt`, or false when no open qualifies. Pure function so the
// attribution rule is unit-testable without a live database.
func AttributedAt(opens []time.Time, paidAt time.Time, windowDays int) (time.Time, bool) {
	cutoff := paidAt.Add(-time.Duration(windowDays) * 24 * time.Hour)
	var best time.Time
	found := false
	for _, t := range opens {
		if t.After(paidAt) {
			continue
		}
		if t.Before(cutoff) {
			continue
		}
		if !found || t.After(best) {
			best = t
			found = true
		}
	}
	return best, found
}
