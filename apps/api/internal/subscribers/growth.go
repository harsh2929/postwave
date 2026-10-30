// SPDX-License-Identifier: AGPL-3.0-only
//
// growth.go — SUB-124 Audience growth report.
//
// The subscriber-level analogue of segments/growth.go. Reads the daily
// lifecycle series the snapshot worker (snapshot_worker.go) writes into the
// verified-exact-ledger-v2 table installed by migration 1773 and returns a
// chart-ready series with per-day adds/verified withdrawals plus the net delta
// over the window. The incompatible migration-1000 heuristic ledger remains
// physically separate and is never exposed through this API.
//
//   GET /api/v1/subscribers/growth?days=90
//
// The window parsing and delta maths are pure (parseGrowthDays,
// subscriberGrowthDelta) so they are table-tested without a database.

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GrowthPoint is one daily snapshot on the audience growth series.
type GrowthPoint struct {
	Date        string    `json:"date"` // YYYY-MM-DD snapshot_date
	EvaluatedAt time.Time `json:"evaluated_at"`
	Total       int64     `json:"total"`
	Added       int64     `json:"added"`
	Unsubbed    int64     `json:"unsubbed"`
	Lapsed      int64     `json:"lapsed"`
}

// GrowthResponse is the wire shape of the audience growth report.
type GrowthResponse struct {
	Days                  int           `json:"days"`
	Series                []GrowthPoint `json:"series"`
	MetricContractVersion string        `json:"metric_contract_version"`
	UnavailableMetrics    []string      `json:"unavailable_metrics"`
	// PartialMetrics names populated fields whose source coverage is
	// intentionally incomplete. Consumers must qualify these values rather
	// than presenting them as exhaustive totals.
	PartialMetrics []string `json:"partial_metrics"`
	// Totals over the window.
	TotalAdded    int64 `json:"total_added"`
	TotalUnsubbed int64 `json:"total_unsubbed"`
	// Delta / DeltaPct compare the newest total against the oldest total
	// in the window. Zero-valued when fewer than 2 points.
	Delta    int64   `json:"delta"`
	DeltaPct float64 `json:"delta_pct"`
	// Note defines the report scope and explains an empty/short series.
	Note string `json:"note,omitempty"`
}

const (
	defaultGrowthDays = 90
	minGrowthDays     = 1
	maxGrowthDays     = 365
	// This closed identifier is stored with every verified snapshot and is
	// required on the wire. It prevents legacy heuristic history from being
	// silently interpreted under the stronger current contract.
	growthMetricContractVersion = "verified-exact-ledger-v2"

	growthMetricScopeNote = "Contract: verified-exact-ledger-v2; legacy heuristic snapshots are retained for audit but never returned, so the series can be shorter after upgrade. Total/added scope: unarchived profiles; added counts profiles created that UTC day. Verified withdrawals (the unsubbed and total_unsubbed fields) are a lower bound: they count distinct profiles with a recorded granted-to-withdrawn transition in a canonical profile-wide exact-address workflow that UTC day, even after later profile archive or address maintenance. Unpaired one-click, preference-center/webhook or generic proofs, status/suppression-only changes, secondary-address decisions, and legacy withdrawals are excluded; do not present this as exhaustive churn. Lapsed is unavailable because no canonical engagement-decay definition is configured; 0 values are placeholders, not evidence that nobody lapsed."
)

var errInvalidGrowthDays = errors.New("days must be an integer from 1 through 365")

// parseGrowthDays accepts an exact integer day count. An omitted/empty value
// defaults to 90; every explicit value must match the documented [1,365]
// contract. Silently accepting suffixes, clamping, or defaulting malformed
// input makes a chart claim a different scope than the caller selected.
func parseGrowthDays(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return defaultGrowthDays, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < minGrowthDays || n > maxGrowthDays {
		return 0, errInvalidGrowthDays
	}
	return n, nil
}

// subscriberGrowthDelta computes (delta, deltaPct) between the first and
// last total of the series. Pure — unit-tested directly.
func subscriberGrowthDelta(series []GrowthPoint) (int64, float64) {
	if len(series) < 2 {
		return 0, 0
	}
	first := series[0].Total
	last := series[len(series)-1].Total
	delta := last - first
	if first == 0 {
		return delta, 0
	}
	return delta, float64(delta) / float64(first) * 100
}

// summariseGrowth sums the per-day adds/unsubs over the series. The database
// columns are int32, but a 365-day total can exceed int32; int64 plus checked
// addition keeps the response arithmetic exact and fail-closed.
func summariseGrowth(series []GrowthPoint) (totalAdded, totalUnsubbed int64, err error) {
	for _, p := range series {
		if p.Added < 0 || p.Unsubbed < 0 ||
			p.Added > math.MaxInt64-totalAdded || p.Unsubbed > math.MaxInt64-totalUnsubbed {
			return 0, 0, errors.New("subscriber growth totals are invalid")
		}
		totalAdded += p.Added
		totalUnsubbed += p.Unsubbed
	}
	return totalAdded, totalUnsubbed, nil
}

func growthReportNote(empty bool) string {
	if empty {
		return "No snapshots exist in this UTC window; the daily snapshot worker populates the series. " + growthMetricScopeNote
	}
	return growthMetricScopeNote
}

func assembleGrowthResponse(days int, series []GrowthPoint) (GrowthResponse, error) {
	out := GrowthResponse{
		Days:                  days,
		Series:                series,
		MetricContractVersion: growthMetricContractVersion,
		UnavailableMetrics:    []string{"lapsed"},
		PartialMetrics:        []string{"unsubbed"},
		Note:                  growthReportNote(len(series) == 0),
	}
	var err error
	out.TotalAdded, out.TotalUnsubbed, err = summariseGrowth(series)
	if err != nil {
		return GrowthResponse{}, err
	}
	out.Delta, out.DeltaPct = subscriberGrowthDelta(series)
	if math.IsNaN(out.DeltaPct) || math.IsInf(out.DeltaPct, 0) {
		return GrowthResponse{}, errors.New("subscriber growth delta percentage is invalid")
	}
	return out, nil
}

func validateGrowthSeries(series []GrowthPoint, days int, readAt time.Time) error {
	if days < minGrowthDays || days > maxGrowthDays {
		return errInvalidGrowthDays
	}
	if readAt.IsZero() {
		return errors.New("subscriber growth read timestamp is missing")
	}
	utcToday := readAt.UTC().Truncate(24 * time.Hour)
	firstAllowed := utcToday.AddDate(0, 0, -(days - 1))
	var previous time.Time
	for i, point := range series {
		date, err := time.Parse("2006-01-02", point.Date)
		if err != nil || date.Format("2006-01-02") != point.Date {
			return fmt.Errorf("subscriber growth point %d has an invalid date", i)
		}
		if date.Before(firstAllowed) || date.After(utcToday) {
			return fmt.Errorf("subscriber growth point %d is outside the requested UTC window", i)
		}
		if !previous.IsZero() && !date.After(previous) {
			return errors.New("subscriber growth dates are not strictly ascending")
		}
		previous = date
		if point.EvaluatedAt.IsZero() || point.EvaluatedAt.After(readAt) {
			return fmt.Errorf("subscriber growth point %d has an invalid evaluation timestamp", i)
		}
		if point.EvaluatedAt.UTC().Format("2006-01-02") != point.Date {
			return fmt.Errorf("subscriber growth point %d was not evaluated on its UTC snapshot day", i)
		}
		if point.Total < 0 || point.Added < 0 || point.Unsubbed < 0 || point.Lapsed < 0 {
			return fmt.Errorf("subscriber growth point %d contains a negative count", i)
		}
		if point.Lapsed != 0 {
			return fmt.Errorf("subscriber growth point %d claims an unavailable lapsed metric", i)
		}
	}
	if len(series) > days {
		return errors.New("subscriber growth series exceeds the requested day cardinality")
	}
	return nil
}

// GetGrowthHistory reads the daily lifecycle series for the tenant over
// the trailing window. Opens its own tenant-scoped tx so RLS fires.
func (r *Repo) GetGrowthHistory(ctx context.Context, tenantID string, days int) ([]GrowthPoint, error) {
	if days < minGrowthDays || days > maxGrowthDays {
		return nil, errInvalidGrowthDays
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH bounds AS (
    SELECT statement_timestamp() AS read_at,
           (statement_timestamp() AT TIME ZONE 'UTC')::date AS utc_today
)
SELECT history.snapshot_date::text,
       history.evaluated_at,
       history.total_count::bigint,
       history.added_count::bigint,
       history.unsubbed_count::bigint,
       history.lapsed_count::bigint,
       bounds.read_at
  FROM subscriber_growth_verified_history AS history
 CROSS JOIN bounds
 WHERE history.tenant_id = $1::uuid
   AND history.metric_contract_version = $3::text
   AND history.snapshot_date >= bounds.utc_today - ($2::int - 1)
   AND history.snapshot_date <= bounds.utc_today
 ORDER BY history.snapshot_date ASC`, tenantID, days, growthMetricContractVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GrowthPoint{}
	var readAt time.Time
	for rows.Next() {
		var p GrowthPoint
		var rowReadAt time.Time
		if err := rows.Scan(&p.Date, &p.EvaluatedAt, &p.Total, &p.Added, &p.Unsubbed, &p.Lapsed, &rowReadAt); err != nil {
			return nil, err
		}
		if readAt.IsZero() {
			readAt = rowReadAt
		} else if !readAt.Equal(rowReadAt) {
			return nil, errors.New("subscriber growth read timestamp changed within one statement")
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > 0 {
		if err := validateGrowthSeries(out, days, readAt); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// MountGrowthRoutes registers the audience growth report endpoint plus
// the manual snapshot trigger (write-gated).
func MountGrowthRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/growth", d.Growth)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/growth/snapshot", d.SnapshotGrowth)
}

// Growth GET /api/v1/subscribers/growth?days=90.
func (d *Deps) Growth(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	values, present := r.URL.Query()["days"]
	if present && len(values) != 1 {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_days", errInvalidGrowthDays.Error()))
		return
	}
	rawDays := ""
	if len(values) == 1 {
		rawDays = values[0]
	}
	days, err := parseGrowthDays(rawDays)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_days", errInvalidGrowthDays.Error()))
		return
	}
	series, err := d.Repo.GetGrowthHistory(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out, err := assembleGrowthResponse(days, series)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// snapshotGrowthPointForTenant writes/refreshes today's UTC growth row and
// returns the exact persisted point from that same SQL statement. Returning
// the write result (rather than issuing a second "days=1" read) prevents a UTC
// midnight boundary from producing a successful response with a null point.
func (r *Repo) snapshotGrowthPointForTenant(ctx context.Context, tenantID string) (*GrowthPoint, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize worker/manual refreshes for this tenant before the aggregate
	// statement takes its MVCC snapshot. Without this lock, an older statement
	// can wait on a newer ON CONFLICT writer and then overwrite its fresher
	// counts; a conditional upsert alone also cannot reliably re-select a row
	// that committed after the older statement snapshot began.
	if _, err := tx.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('subscriber-growth:' || $1::text, 1000)
)`, tenantID); err != nil {
		return nil, err
	}
	// One INSERT ... SELECT gives every metric one MVCC snapshot. The consent
	// flow is intentionally derived from the immutable exact-address event/proof
	// pair, not subscribers.updated_at: an unrelated profile edit must never be
	// relabelled as a withdrawal. The four operations below are the reviewed
	// profile-wide writers that produce this pair. DISTINCT subscriber_id
	// prevents duplicate fan-out, and the immutable binding preserves the
	// decision-time address across later rotation/deletion/demotion/archive.
	//
	// This inventory is deliberately not represented as total unsubscribes.
	// Production also has unpaired negative writers: RFC-8058 one-click appends
	// an event plus suppression, consent.RecordProof can append a standalone
	// withdrawal proof, and generic status/suppression flows can blocklist a
	// profile without this pair. The API therefore marks `unsubbed` partial and
	// describes it as a verified lower bound. TestGrowthVerifiedWithdrawalSourceInventory
	// pins both the included writers and these exclusion classes.
	// UTC bounds are explicit so a connection/session timezone cannot move a
	// tenant into tomorrow's bucket.
	row := tx.QueryRow(ctx, `
WITH bounds AS (
    SELECT statement_timestamp() AS evaluated_at,
           (statement_timestamp() AT TIME ZONE 'UTC')::date AS snapshot_date,
           ((statement_timestamp() AT TIME ZONE 'UTC')::date::timestamp
               AT TIME ZONE 'UTC') AS day_start,
           (((statement_timestamp() AT TIME ZONE 'UTC')::date + 1)::timestamp
               AT TIME ZONE 'UTC') AS day_end
), profile_counts AS (
    SELECT count(subscriber.id) FILTER (
               WHERE subscriber.archived_at IS NULL
                 AND subscriber.created_at <= bounds.evaluated_at
           )::bigint AS total_count,
           count(subscriber.id) FILTER (
               WHERE subscriber.archived_at IS NULL
                 AND subscriber.created_at >= bounds.day_start
                 AND subscriber.created_at < bounds.day_end
                 AND subscriber.created_at <= bounds.evaluated_at
           )::bigint AS added_count
      FROM bounds
      LEFT JOIN subscribers AS subscriber
        ON subscriber.tenant_id = $1::uuid
     GROUP BY bounds.evaluated_at
), withdrawal_candidates AS (
    SELECT record.id,
           record.subscriber_id,
           event.subject_id AS address_id,
           COALESCE(record.recorded_at, record.created_at) AS recorded_at
      FROM consent_records AS record
      JOIN consent_events AS event
        ON event.tenant_id = record.tenant_id
       AND event.id::text = record.evidence ->> 'event_id'
       AND event.subject_type = 'subscriber'
       AND event.category = 'email_marketing'
     CROSS JOIN bounds
     WHERE record.tenant_id = $1::uuid
       AND record.channel = 'email'
       AND record.subscriber_id IS NOT NULL
       AND NULLIF(event.subject_id, '') IS NOT NULL
       AND lower(btrim(event.subject_email::text)) = lower(btrim(record.email::text))
       AND record.consent_status = 'withdrawn'
       AND record.evidence ->> 'operation' IN (
           'bulk_consent',
           'bulk_unsubscribe',
           'channel_consent_email',
           'jurisdiction_reconfirmation'
       )
       AND COALESCE(record.recorded_at, record.created_at) >= bounds.day_start
       AND COALESCE(record.recorded_at, record.created_at) < bounds.day_end
       AND COALESCE(record.recorded_at, record.created_at) <= bounds.evaluated_at
), unsubscribe_flow AS (
    SELECT count(DISTINCT candidate.subscriber_id)::bigint AS unsubbed_count
      FROM withdrawal_candidates AS candidate
      JOIN LATERAL (
          SELECT prior_record.consent_status
            FROM consent_records AS prior_record
            JOIN consent_events AS prior_event
              ON prior_event.tenant_id = prior_record.tenant_id
             AND prior_event.id::text = prior_record.evidence ->> 'event_id'
             AND prior_event.subject_type = 'subscriber'
             AND prior_event.category = 'email_marketing'
           WHERE prior_record.tenant_id = $1::uuid
             AND prior_record.subscriber_id = candidate.subscriber_id
             AND prior_record.channel = 'email'
             AND prior_record.consent_status IN ('granted', 'withdrawn', 'pending', 'expired')
             AND prior_event.subject_id = candidate.address_id
             AND (
                 COALESCE(prior_record.recorded_at, prior_record.created_at) < candidate.recorded_at OR
                 (
                     COALESCE(prior_record.recorded_at, prior_record.created_at) = candidate.recorded_at AND
                     prior_record.id < candidate.id
                 )
             )
           ORDER BY COALESCE(prior_record.recorded_at, prior_record.created_at) DESC,
                    prior_record.id DESC
           LIMIT 1
      ) AS previous_decision
        ON previous_decision.consent_status = 'granted'
), upserted AS (
INSERT INTO subscriber_growth_verified_history AS history
    (tenant_id, snapshot_date, evaluated_at, total_count, added_count,
     unsubbed_count, lapsed_count, metric_contract_version)
SELECT $1::uuid,
       bounds.snapshot_date,
       bounds.evaluated_at,
       profile_counts.total_count,
       profile_counts.added_count,
       unsubscribe_flow.unsubbed_count,
       0,
       $2::text
  FROM bounds
 CROSS JOIN profile_counts
 CROSS JOIN unsubscribe_flow
ON CONFLICT (tenant_id, snapshot_date)
DO UPDATE SET evaluated_at = EXCLUDED.evaluated_at,
              total_count = EXCLUDED.total_count,
              added_count = EXCLUDED.added_count,
              unsubbed_count = EXCLUDED.unsubbed_count,
              lapsed_count = 0,
              metric_contract_version = EXCLUDED.metric_contract_version
WHERE history.evaluated_at <= EXCLUDED.evaluated_at
RETURNING snapshot_date::text, evaluated_at,
          total_count::bigint, added_count::bigint,
          unsubbed_count::bigint, lapsed_count::bigint
)
SELECT upserted.snapshot_date,
       upserted.evaluated_at,
       upserted.total_count,
       upserted.added_count,
       upserted.unsubbed_count,
       upserted.lapsed_count,
       bounds.evaluated_at
  FROM upserted
 CROSS JOIN bounds
UNION ALL
SELECT history.snapshot_date::text,
       history.evaluated_at,
       history.total_count::bigint,
       history.added_count::bigint,
       history.unsubbed_count::bigint,
       history.lapsed_count::bigint,
       bounds.evaluated_at
  FROM subscriber_growth_verified_history AS history
 CROSS JOIN bounds
 WHERE history.tenant_id = $1::uuid
   AND history.snapshot_date = bounds.snapshot_date
   AND history.metric_contract_version = $2::text
   AND NOT EXISTS (SELECT 1 FROM upserted)
LIMIT 1`, tenantID, growthMetricContractVersion)
	var point GrowthPoint
	var readAt time.Time
	if err := row.Scan(
		&point.Date, &point.EvaluatedAt, &point.Total, &point.Added,
		&point.Unsubbed, &point.Lapsed, &readAt,
	); err != nil {
		return nil, err
	}
	if err := validateGrowthSeries([]GrowthPoint{point}, 1, readAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &point, nil
}

// snapshotGrowthForTenant is the worker-compatible error-only wrapper. The
// manual HTTP route calls snapshotGrowthPointForTenant directly so it can echo
// the exact committed point without a racy second read.
func (r *Repo) snapshotGrowthForTenant(ctx context.Context, tenantID string) error {
	_, err := r.snapshotGrowthPointForTenant(ctx, tenantID)
	return err
}

// SnapshotGrowth POST /api/v1/subscribers/growth/snapshot — force a
// recompute of today's row (operator / internal worker trigger). Returns
// the freshly-written point. Gated on write:subscribers.
func (d *Deps) SnapshotGrowth(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	point, err := d.Repo.snapshotGrowthPointForTenant(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                      true,
		"point":                   point,
		"metric_contract_version": growthMetricContractVersion,
		"unavailable_metrics":     []string{"lapsed"},
		"partial_metrics":         []string{"unsubbed"},
		"note":                    growthMetricScopeNote,
	})
}
