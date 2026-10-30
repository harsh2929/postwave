// Package send_time_opt computes the per-subscriber best-send-hour from
// historical opens and persists it back on subscribers. The hour is encoded
// as hour-of-week 0-167 (Sunday 00:00 UTC = 0, Saturday 23:00 UTC = 167).
//
// Cold subscribers (< MinOpens) are left NULL; the campaign scheduler
// falls back to the tenant's global mean of opener hours.
package send_time_opt

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// MinOpens is the threshold below which a subscriber is treated as cold.
const MinOpens = 5
const scheduleJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// CampaignRecipientLoadHardCap is the maximum number of recipients we'll
// pull into memory for the schedule-by-best-time path (both the commit
// and the preview). When the load exceeds this cap the returned slice
// is truncated and the caller is told so via the `truncated` bool — the
// schedule-preview surface renders a banner so the operator knows the
// preview undercounts the actual send.
//
// 50k matches the LIMIT that was hard-coded in the legacy query; we
// promote it to a package constant so schedule_preview.go can reference
// it in its response envelope.
const CampaignRecipientLoadHardCap = 50000

// allowedStrategies enumerates the strategy labels accepted by the preview
// and commit endpoints. Unknown values are rejected rather than silently
// changing scheduling behavior.
//
// modal_hour       — collapse every warm recipient's best_hour onto the
//
//	audience's modal hour. Surfaces as a tight cluster
//	in the distribution histogram.
//
// per_recipient    — honour each recipient's individual best_hour
//
//	(the default).
var allowedStrategies = map[string]bool{
	"modal_hour":    true,
	"per_recipient": true,
}

// HourOfWeek converts an instant to its 0-167 hour-of-week index by
// projecting `t` into UTC first (Sunday 00:00 UTC = 0, Saturday 23:00
// UTC = 167). Week-start matches Go's time.Weekday() ordering.
//
// TZ CONVENTION (p0-sto-schedule-strategy): hour-of-week values stored
// in subscribers.best_send_hour are ALWAYS UTC-bucketed by this
// function. They are NOT local-to-the-recipient. The tz-aware sibling
// HourOfWeekIn (per_recipient_tz.go) is the right entry point when the
// caller wants the recipient's LOCAL hour-of-week — and it is opt-in
// per-call-site so the legacy UTC-bucketed path keeps working.
//
// Concretely: two recipients who open at 9am LA time and 9am Berlin
// time end up in DIFFERENT hour-of-week buckets here (UTC 16/17 vs UTC
// 7/8 depending on DST). The campaign scheduler then fires at the
// stored UTC hour, so each recipient receives at the same UTC instant
// but at different local clock times — that's the documented behaviour
// for the global STO path. Tenants who need "9am in their local tz"
// use ScheduleByBestTimeLocalized (per_recipient_tz.go) which routes
// through HourOfWeekIn instead.
//
// Two recipients at the same LOCAL hour but in different timezones
// MUST therefore receive at distinct UTC send times. The regression
// test TestHourOfWeek_DifferentTzSameLocalHour asserts this.
func HourOfWeek(t time.Time) int {
	t = t.UTC()
	return int(t.Weekday())*24 + t.Hour()
}

// Mode returns the most-frequent value in hours and its count. Ties break
// by smallest hour index so the result is deterministic.
func Mode(hours []int) (int, int) {
	if len(hours) == 0 {
		return 0, 0
	}
	counts := make(map[int]int, 24)
	for _, h := range hours {
		counts[h]++
	}
	bestHour, bestCount := -1, 0
	for h := 0; h < 168; h++ {
		c := counts[h]
		if c > bestCount {
			bestHour, bestCount = h, c
		}
	}
	if bestHour < 0 {
		bestHour = hours[0]
		bestCount = counts[bestHour]
	}
	return bestHour, bestCount
}

// BestHour holds the projected best-send-hour for a subscriber.
type BestHour struct {
	Email       string    `json:"email,omitempty"`
	BestHourUTC int       `json:"best_hour_utc"`
	ComputedAt  time.Time `json:"computed_at"`
	SampleSize  int       `json:"sample_size"`
}

// Schedule is one (recipient, send_at) assignment.
type Schedule struct {
	Email       string    `json:"email"`
	SendAt      time.Time `json:"send_at"`
	BestHourUTC int       `json:"best_hour_utc"`
}

// ScheduleCommitResponse contains only aggregate persistence confirmation.
// Recipient addresses remain in the durable tenant-scoped table and are never
// reflected from this mutation endpoint.
type ScheduleCommitResponse struct {
	CampaignID  string `json:"campaign_id"`
	Scheduled   int    `json:"scheduled"`
	WithinDays  int    `json:"within_days"`
	TenantMean  int    `json:"tenant_mean"`
	Truncated   bool   `json:"truncated"`
	HardCap     int    `json:"hard_cap"`
	Strategy    string `json:"strategy"`
	ReferenceAt string `json:"reference_at"`
	Persisted   bool   `json:"persisted"`
}

// Recipient is the per-recipient input to ScheduleByBestTime.
type Recipient struct {
	Email    string
	BestHour *int
}

// ScheduleByBestTime computes the next fire moment for each recipient
// within [now, now+withinDays). Recipients without a best_hour fall back
// to the tenant's global mean.
func ScheduleByBestTime(now time.Time, withinDays int, recipients []Recipient, tenantMean int) []Schedule {
	// A weekly hour-of-week model needs a complete seven-day search window.
	// Shorter windows silently pushed out-of-window recipients to "now" in the
	// legacy implementation, which turned an optimization miss into immediate
	// delivery.
	if withinDays < 7 {
		withinDays = 7
	}
	if withinDays > 30 {
		withinDays = 30
	}
	end := now.Add(time.Duration(withinDays) * 24 * time.Hour)
	out := make([]Schedule, 0, len(recipients))
	for _, r := range recipients {
		hour := tenantMean
		if r.BestHour != nil {
			hour = *r.BestHour
		}
		when := nextHourOfWeek(now, hour)
		if when.After(end) {
			when = end
		}
		out = append(out, Schedule{Email: r.Email, SendAt: when, BestHourUTC: hour})
	}
	return out
}

func nextHourOfWeek(now time.Time, target int) time.Time {
	if target < 0 || target > 167 {
		target = 0
	}
	curr := HourOfWeek(now.UTC())
	delta := target - curr
	if delta < 0 {
		delta += 168
	}
	if delta == 0 {
		// We are already inside the recommended UTC bucket. Preserve the
		// caller's exact reference instant rather than returning the start of
		// the hour in the past.
		return now.UTC()
	}
	base := time.Date(now.Year(), now.Month(), now.Day(), now.Hour(), 0, 0, 0, time.UTC)
	return base.Add(time.Duration(delta) * time.Hour)
}

// Repo wraps pgx for the best-send-hour endpoints + worker.
type Repo struct {
	Pool    *db.Pool
	Weights SignalWeightsReader
}

// ErrNotFound is returned when a subscriber lookup misses.
var ErrNotFound = errors.New("send_time_opt: not found")

// Compute reads up to 1000 qualifying events from the trailing 180 days,
// computes
// the modal hour-of-week, and writes it back. Returns the computed value
// (or nil if the subscriber is below MinOpens).
func (r *Repo) Compute(ctx context.Context, tenantID, email string) (*BestHour, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	weights := resolveWeights(ctx, r.Weights, tenantID)
	rows, err := tx.Query(ctx, `
SELECT at, event_type FROM subscriber_events
WHERE tenant_id = $1::uuid
  AND subscriber_email = $2
  AND event_type IN ('opened', 'clicked', 'replied')
  AND at >= now() - interval '180 days'
ORDER BY at DESC
LIMIT 1000`, tenantID, strings.ToLower(email))
	if err != nil {
		return nil, err
	}
	hours := []int{}
	for rows.Next() {
		var (
			at        time.Time
			eventType string
		)
		if err := rows.Scan(&at, &eventType); err != nil {
			rows.Close()
			return nil, err
		}
		for i := 0; i < weightFor(eventType, weights); i++ {
			hours = append(hours, HourOfWeek(at))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(hours) < MinOpens {
		return nil, nil
	}
	best, _ := Mode(hours)
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
SET best_send_hour = $3, best_send_hour_at = $4, updated_at = now()
WHERE tenant_id = $1::uuid AND email = $2`,
		tenantID, strings.ToLower(email), best, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &BestHour{Email: email, BestHourUTC: best, ComputedAt: now, SampleSize: len(hours)}, nil
}

// GetByID returns the cached best hour for a subscriber id.
func (r *Repo) GetByID(ctx context.Context, tenantID, id string) (*BestHour, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email string
	var hour *int
	var at *time.Time
	row := tx.QueryRow(ctx, `
SELECT email::text, best_send_hour, best_send_hour_at
FROM subscribers
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err := row.Scan(&email, &hour, &at); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out := &BestHour{Email: email, BestHourUTC: -1}
	if hour != nil {
		out.BestHourUTC = *hour
	}
	if at != nil {
		out.ComputedAt = *at
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// StaleRow names a (tenant, email) pair the worker should recompute.
type StaleRow struct {
	TenantID string
	Email    string
}

// StaleSubscribers returns subscribers whose best-hour value is older than
// `staleAfter` (or has never been computed). Cross-tenant — the worker
// iterates these under explicit tenant context.
func (r *Repo) StaleSubscribers(ctx context.Context, staleAfter time.Duration, limit int) ([]StaleRow, error) {
	cutoff := time.Now().UTC().Add(-staleAfter)
	rows, err := r.Pool.Query(ctx, `
SELECT tenant_id::text, email::text
FROM subscribers
WHERE best_send_hour_at IS NULL OR best_send_hour_at < $1
ORDER BY best_send_hour_at NULLS FIRST
LIMIT $2`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StaleRow{}
	for rows.Next() {
		var s StaleRow
		if err := rows.Scan(&s.TenantID, &s.Email); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// loadCampaignRecipients returns enabled recipients + the tenant mean +
// a `truncated` bool that's true when we hit CampaignRecipientLoadHardCap.
//
// sto-recipient-segment-filter (P0): when campaignID is non-empty, we
// first resolve the campaign's configured segment_id and JOIN through
// segment_subscribers so the schedule only covers the campaign's actual
// audience. Before this fix the function pulled EVERY enabled subscriber
// for the tenant — a campaign targeted at a 200-row segment would
// schedule against the whole tenant, then the campaign-side sender
// would later filter back down, but the schedule preview and legacy
// recipient sample silently lied about the audience.
//
// Segment resolution and AST evaluation fail closed. Cache misses compile the
// stored AST inline; an empty segment stays empty and can never broaden to the
// whole tenant. A campaign with no segment deliberately uses the canonical
// workspace-wide email activation population.
//
// truncated=true iff row CampaignRecipientLoadHardCap+1 exists.
func (r *Repo) loadCampaignRecipients(ctx context.Context, tenantID, campaignID string) ([]Recipient, int, bool, error) {
	segmentID := ""
	if campaignID != "" {
		var resolveErr error
		segmentID, resolveErr = r.resolveCampaignSegment(ctx, tenantID, campaignID)
		if resolveErr != nil {
			return nil, 0, false, resolveErr
		}
	}

	var membership *segmentMembership
	if segmentID != "" {
		var membershipErr error
		membership, membershipErr = r.resolveSegmentMembership(
			ctx, tenantID, segmentID, 1, 1,
			segments.ActivationPopulation(segments.ActivationChannelEmail),
		)
		if membershipErr != nil {
			return nil, 0, false, membershipErr
		}
		if membership.IsFallback {
			stoSegmentFallbackEngagedTotal.WithLabelValues(membership.Reason, "recipients").Inc()
		}
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := []Recipient{}
	warmHours := []int{}

	args := []any{tenantID}
	where := "tenant_id = $1::uuid"
	if membership != nil {
		args = append(args, membership.Args...)
		where += " AND id IN (" + membership.Subquery + ")"
	} else {
		predicate, compileErr := segments.CompilePopulation(
			ctx, nil, tenantID, segments.TransactionSegmentResolver{Queryer: tx},
			segments.ActivationPopulation(segments.ActivationChannelEmail),
		)
		if compileErr != nil {
			return nil, 0, false, compileErr
		}
		where += " AND (" + renumberPlaceholders(predicate.SQL, 1) + ")"
		args = append(args, predicate.Args...)
	}
	args = append(args, CampaignRecipientLoadHardCap+1)
	rows, err := tx.Query(ctx, `
SELECT email::text, best_send_hour
FROM subscribers
WHERE `+where+`
ORDER BY id
LIMIT $`+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, false, err
	}
	for rows.Next() {
		var email string
		var hour *int
		if err := rows.Scan(&email, &hour); err != nil {
			rows.Close()
			return nil, 0, false, err
		}
		out = append(out, Recipient{Email: email, BestHour: hour})
		if hour != nil {
			warmHours = append(warmHours, *hour)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, 0, false, err
	}
	rows.Close()

	mean := 9
	if len(warmHours) > 0 {
		// A modal bucket is circular-week safe. Arithmetic averaging made
		// Saturday 23:00 and Sunday 00:00 land near mid-week.
		mean, _ = Mode(warmHours)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, false, err
	}
	truncated := len(out) > CampaignRecipientLoadHardCap
	if truncated {
		out = out[:CampaignRecipientLoadHardCap]
	}
	return out, mean, truncated, nil
}

// CampaignRescheduler hands the computed Schedule back to the campaigns
// package. Implementations live alongside the campaigns code; this package
// keeps the contract narrow so it can be tested in isolation.
type CampaignRescheduler interface {
	RescheduleByBestTime(ctx context.Context, tenantID, campaignID string, schedule []Schedule) error
}

// Deps bundles HTTP dependencies.
type Deps struct {
	Repo      *Repo
	Campaigns CampaignRescheduler
	// LiveDispatch is the same operational interlock used by campaign queueing.
	// A missing gate is closed, including for schedule materialization.
	LiveDispatch dispatchcontrol.Gate
	// Warmup reads the tenant's current warmup-day cap so the schedule-
	// preview surface can flag a `warmup_cap_breach` ahead of the
	// commit. Nil disables the breach computation entirely (the
	// preview response then omits the signal) so existing wire-ups
	// that don't know about warmup gates continue to work.
	Warmup WarmupCapReader
	// Logger receives structured server-side context for 5xx error
	// responses emitted via httperror.WriteInternal. May be nil in
	// tests; nil-safe inside httperror.
	Logger *slog.Logger
}

// MountRoutes registers tenant-scoped endpoints.
//
// The schedule POST re-shapes live recipient dispatch timing, so it requires
// the conjunctive write:campaigns + send:transactional policy. The read GETs
// accept ScopeReadReports OR ScopeAdmin (admin is a wildcard).
func (d *Deps) MountRoutes(r chi.Router) {
	read := r.With(apikeys.RequireScope(
		apikeys.ScopeReadReports,
		apikeys.ScopeAdmin,
	))
	// p5-prom-send-time-opt: every STO handler gets a
	// pw_send_time_opt_<action>_total + pw_send_time_opt_duration_seconds
	// pair so Grafana can track read-vs-write throughput on the
	// best-send-time surface from a single row.
	read.Get("/api/v1/subscribers/{id}/best-send-time", observability.RecordSurfaceFunc("send_time_opt", "get_by_id", d.Get))
	read.Get("/api/v1/send-time-opt", observability.RecordSurfaceFunc("send_time_opt", "segment_best", d.GetSegmentBest))
	read.Get("/api/v1/send-time-opt/best-time-analysis", observability.RecordSurfaceFunc("send_time_opt", "best_time_analysis", d.BestTimeAnalysis))

	live := r.With(apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional))
	live.Post("/api/v1/campaigns/{id}/schedule-by-best-time", observability.RecordSurfaceFunc("send_time_opt", "schedule", d.Schedule))
}

// Get GET /api/v1/subscribers/{id}/best-send-time.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		writeJSON(
			w,
			http.StatusBadRequest,
			errEnv("invalid_subscriber_id", "subscriber id must be a UUID"),
		)
		return
	}
	bh, err := d.Repo.GetByID(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if bh.BestHourUTC < 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error":            "insufficient_data",
			"message":          "subscriber does not have enough qualifying engagement signal",
			"min_signal_units": MinOpens,
		})
		return
	}
	writeJSON(w, http.StatusOK, bh)
}

// SegmentBest is the response shape for the segment-aggregated best-send-time
// endpoint. best_hour_utc is rendered as `HH:00` (UTC, hour-of-day, NOT
// hour-of-week — segment aggregation collapses the week dimension because
// the desktop's "best time to send" surface is hour-of-day-level).
//
// confidence is the fraction of subscribers in the segment whose
// best_send_hour was computed from at least MinOpens samples; treat low
// values as a "we don't have enough data yet" hint.
type SegmentBest struct {
	SegmentID   string    `json:"segment_id"`
	BestHourUTC string    `json:"best_hour_utc"`
	Confidence  float64   `json:"confidence"`
	SampleSize  int       `json:"sample_size"`
	ComputedAt  time.Time `json:"computed_at"`
}

// MinSegmentSamples is the floor on subscribers-with-data required before
// we'll return an aggregated best hour. Below this we 404 with
// `insufficient_data` so the desktop falls back gracefully.
const MinSegmentSamples = 30

// loadSegmentBestHours pulls (best_send_hour, sample_size) for every
// subscriber in segmentID. sample_size proxy: we use whether
// best_send_hour is non-NULL — Compute() only writes when len(hours) >=
// MinOpens, so any non-NULL row already represents a confident sample.
//
// Cross-segment sharing of subscribers is fine: each subscriber's best
// hour is a property of the subscriber, not the segment. Aggregation
// runs over the segment's resolved subscriber set.
func (r *Repo) loadSegmentBestHours(ctx context.Context, tenantID, segmentID string) ([]int, int, error) {
	membership, err := r.resolveSegmentMembership(
		ctx, tenantID, segmentID, 1, 1, segments.DefinitionPopulation(false),
	)
	if err != nil {
		return nil, 0, err
	}
	if membership.IsFallback {
		stoSegmentFallbackEngagedTotal.WithLabelValues(membership.Reason, "best_hours").Inc()
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := append([]any{tenantID}, membership.Args...)
	rows, err := tx.Query(ctx, `
SELECT best_send_hour
FROM subscribers
WHERE tenant_id = $1::uuid
  AND status = 'enabled'
  AND id IN (`+membership.Subquery+`)`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	hours := []int{}
	total := 0
	for rows.Next() {
		var h *int
		if err := rows.Scan(&h); err != nil {
			return nil, 0, err
		}
		total++
		if h != nil {
			hours = append(hours, *h)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return hours, total, nil
}

// resolveCampaignSegment looks up the segment_id on a campaign so the
// /send-time-opt?campaign_id=... query form works without the caller
// having to know the segment up-front.
func (r *Repo) resolveCampaignSegment(ctx context.Context, tenantID, campaignID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var seg *string
	err = tx.QueryRow(ctx, `
SELECT segment_id::text FROM campaigns
WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, campaignID).Scan(&seg)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return "", cerr
	}
	if seg == nil {
		return "", nil
	}
	return *seg, nil
}

// medianHour returns the median value in hours. For an even-length
// slice we pick the lower middle for stability.
func medianHour(hours []int) int {
	n := len(hours)
	if n == 0 {
		return 0
	}
	// Sort in place via insertion sort — N is bounded by the segment
	// subscriber count, but the typical desktop call is segments of <
	// 50k. For n <= ~10k a sort.Ints is fine; we use that.
	cp := make([]int, n)
	copy(cp, hours)
	sortInts(cp)
	return cp[n/2]
}

// sortInts is a small wrapper so the file's import surface stays stable
// (we already import a handful of std packages and adding sort here is
// fine but kept explicit so the dep-graph is obvious to readers).
func sortInts(xs []int) {
	sort.Ints(xs)
}

// GetSegmentBest GET /api/v1/send-time-opt?segment_id=&campaign_id=.
//
// Returns the median best_hour_utc + a confidence score for a segment.
// Either segment_id OR campaign_id must be provided (campaign_id resolves
// to the campaign's configured segment).
//
// 404 with {"error":"insufficient_data", ...} when fewer than
// MinSegmentSamples subscribers in the segment have computed best
// hours — caller (the desktop) renders a "not enough data yet" hint.
func (d *Deps) GetSegmentBest(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	segmentID := strings.TrimSpace(r.URL.Query().Get("segment_id"))
	campaignID := strings.TrimSpace(r.URL.Query().Get("campaign_id"))
	if segmentID == "" && campaignID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"missing_params",
			"either segment_id or campaign_id is required"))
		return
	}
	if segmentID == "" {
		seg, err := d.Repo.resolveCampaignSegment(r.Context(), t.ID, campaignID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errEnv(
					"campaign_not_found",
					"campaign not found for tenant"))
				return
			}
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		segmentID = seg
	}
	hours, total, err := d.Repo.loadSegmentBestHours(r.Context(), t.ID, segmentID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	withData := len(hours)
	if withData < MinSegmentSamples {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error":   "insufficient_data",
			"message": "Need at least 30 subscribers with send history; have " + itoa(withData),
		})
		return
	}
	med := medianHour(hours)
	// medianHour returns hour-of-week 0..167; collapse to hour-of-day
	// 0..23 for the segment-level surface (the desktop renders an
	// hour-of-day clock, not a weekly heatmap).
	hod := med % 24
	confidence := 0.0
	if total > 0 {
		confidence = float64(withData) / float64(total)
	}
	bestHourStr := pad2(hod) + ":00"
	writeJSON(w, http.StatusOK, SegmentBest{
		SegmentID:   segmentID,
		BestHourUTC: bestHourStr,
		Confidence:  confidence,
		SampleSize:  withData,
		ComputedAt:  time.Now().UTC(),
	})
}

// pad2 zero-pads an int 0..99 to a 2-char string. Avoids importing
// strconv just for this leaf use.
func pad2(n int) string {
	if n < 0 {
		n = 0
	}
	if n > 99 {
		n = 99
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}

// itoa is a leaf helper to keep the imports minimal; for n<0 returns "0".
func itoa(n int) string {
	if n <= 0 {
		return "0"
	}
	// O(log n) digit extraction; max int we'd see here is the
	// subscriber count of a tenant, well below int64.
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// Schedule POST /api/v1/campaigns/{id}/schedule-by-best-time.
//
// Request body (all fields optional):
//
//	{
//	  "within_days":   7,                          // default 7
//	  "strategy":      "modal_hour"|"per_recipient", // default "per_recipient"
//	  "reference_at":  "2026-06-08T15:00:00Z"      // default time.Now().UTC()
//	}
//
// p0-sto-schedule-strategy (P0): the original handler accepted the body
// fields by name in the preview but DROPPED `strategy` and
// `reference_at` on the commit path — the preview would honour
// modal_hour and reference_at, then the operator would click
// "Schedule" and the commit endpoint would silently fall back to
// per-recipient bucketing anchored at server-now. The desktop's
// preview vs. commit diverged whenever strategy != per_recipient OR
// reference_at != now, leading to "the preview showed 9am, the
// schedule fired at 3am" support tickets. We now plumb both fields
// through into the schedule math so the commit matches the preview
// 1-to-1.
//
// strategy "modal_hour": collapse every warm recipient's best_hour
// onto the audience's modal hour (per-tenant cluster). Cold recipients
// (BestHour=nil) still inherit tenant_mean — same as preview.
//
// strategy "per_recipient" or unspecified: honour each recipient's
// individual best_hour (legacy default).
//
// reference_at: the campaign-start anchor. The schedule's "now" pointer
// is set to this value, so a campaign scheduled with reference_at=
// "Mon 12:00 UTC" gets its hour-of-week math measured from Mon 12:00,
// not from server-now. Required for "schedule from now + 24h"
// drafting flows. Missing values use time.Now().UTC(); malformed values
// are rejected.
func (d *Deps) Schedule(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if err := dispatchcontrol.Check(d.LiveDispatch, r.Context(), t.ID); err != nil {
		dispatchcontrol.WriteHTTPError(w, err)
		return
	}
	var body struct {
		WithinDays  int    `json:"within_days"`
		Strategy    string `json:"strategy"`
		ReferenceAt string `json:"reference_at"`
	}
	if err := httpbody.DecodeJSONWith(w, r, scheduleJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if body.WithinDays == 0 {
		body.WithinDays = 7
	}
	if body.WithinDays < 7 || body.WithinDays > 30 {
		httperror.Write(w, http.StatusBadRequest, "invalid_within_days", "within_days must be between 7 and 30")
		return
	}
	strategyLabel := strings.TrimSpace(body.Strategy)
	if strategyLabel == "" {
		strategyLabel = "per_recipient"
	}
	if !allowedStrategies[strategyLabel] {
		httperror.Write(w, http.StatusBadRequest, "invalid_strategy", "strategy must be per_recipient or modal_hour")
		return
	}
	now := time.Now().UTC()
	if strings.TrimSpace(body.ReferenceAt) != "" {
		parsed, perr := time.Parse(time.RFC3339, strings.TrimSpace(body.ReferenceAt))
		if perr != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_reference_at", "reference_at must be an RFC3339 timestamp")
			return
		}
		now = parsed.UTC()
	}
	campaignID := chi.URLParam(r, "id")
	if _, err := uuid.Parse(campaignID); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_campaign_id", "campaign id must be a UUID")
		return
	}
	// sto-recipient-segment-filter (P0): pass campaignID so the
	// segment-scoped query path fires when the campaign has a configured
	// segment. The `truncated` signal is surfaced in the response so the
	// desktop can warn the operator when we hit the hard cap.
	recipients, mean, truncated, err := d.Repo.loadCampaignRecipients(r.Context(), t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if truncated {
		httperror.Write(
			w,
			http.StatusUnprocessableEntity,
			"audience_too_large",
			"campaign audience exceeds the safe send-time scheduling limit",
		)
		return
	}
	if len(recipients) == 0 {
		httperror.Write(
			w,
			http.StatusUnprocessableEntity,
			"empty_audience",
			"campaign has no eligible recipients to schedule",
		)
		return
	}
	// modal_hour collapses each warm recipient onto the audience's
	// modal hour (the same logic the preview applies). Cold recipients
	// keep BestHour=nil so they continue to inherit tenant_mean inside
	// ScheduleByBestTime.
	if strategyLabel == "modal_hour" {
		hours := make([]int, 0, len(recipients))
		for _, r := range recipients {
			if r.BestHour != nil {
				hours = append(hours, *r.BestHour)
			}
		}
		modal, _ := Mode(hours)
		for i := range recipients {
			if recipients[i].BestHour != nil {
				h := modal
				recipients[i].BestHour = &h
			}
		}
	}
	schedule := ScheduleByBestTime(now, body.WithinDays, recipients, mean)
	if d.Campaigns == nil {
		httperror.Write(
			w,
			http.StatusServiceUnavailable,
			"scheduler_unavailable",
			"durable campaign scheduler is unavailable",
		)
		return
	}
	if err := d.Campaigns.RescheduleByBestTime(r.Context(), t.ID, campaignID, schedule); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, ScheduleCommitResponse{
		CampaignID:  campaignID,
		Scheduled:   len(schedule),
		WithinDays:  body.WithinDays,
		TenantMean:  mean,
		Truncated:   false,
		HardCap:     CampaignRecipientLoadHardCap,
		Strategy:    strategyLabel,
		ReferenceAt: now.Format(time.RFC3339),
		Persisted:   true,
	})
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
