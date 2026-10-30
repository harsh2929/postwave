// SPDX-License-Identifier: AGPL-3.0-only
//
// schedule_preview.go — dry-run preview of POST /campaigns/{id}/
// schedule-by-best-time. Audited gap `sto-recipient-distribution-preview`
// (P1): before this endpoint the operator clicked "Schedule by best time"
// without ever seeing the per-hour distribution of where the schedule
// would land; the `first_5` sample only surfaced AFTER the POST
// succeeded so they were committing blind. Braze ships the same idea as
// the Canvas-step preview, Iterable as STO Insights with predicted-vs-
// realized, MoEngage as the Best Time Analysis dashboard.
//
// This handler computes the SAME schedule the real POST would commit
// (calls `ScheduleByBestTime` against the same recipient set + tenant
// mean), then aggregates it into:
//
//   - distribution: 24 buckets keyed by hour-of-day UTC with recipient
//     counts (the histogram the desktop renders inline before "Schedule"
//     is enabled).
//   - max_per_minute: the largest count of recipients landing in any
//     single minute of the schedule. Surfaces over-burst risk (e.g.
//     "20k recipients land at 9:00:00") which the operator would
//     otherwise only discover post-send when the smtp pool throttles.
//   - warmup_cap_breach: true when the schedule's deliverable count
//     exceeds the tenant's warmup-day cap. The campaign would still be
//     rate-limited at send-time, but seeing it pre-commit lets the
//     operator either split the campaign or wait a day.
//
// IMPORTANT: this endpoint is READ-ONLY. It never writes the schedule
// into campaign_recipient_send_at. The corresponding POST (no
// /preview suffix) is the persistence path. Previewing a campaign
// schedule reveals campaign-level operational information and is part
// of the write workflow. The route therefore requires
// `write:campaigns`, matching the route-auth manifest and preventing
// viewer keys from probing campaign audiences.
package send_time_opt

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// WarmupCapReader is the narrow interface the preview uses to fetch
// the tenant's current daily warmup cap. We intentionally do NOT
// import `campaigns.WarmupGate` here — that would invert the dep graph
// (campaigns already imports send_time_opt indirectly via the
// rescheduler). The adapter wiring lives in main.go.
//
// Returns -1 when no cap applies (Pro tier / warmup-complete). The
// handler treats -1 as "no breach possible". A nil WarmupCapReader on
// `Deps` disables the breach computation entirely — the response then
// omits the breach signal (warmup_cap_breach=false, max_per_day=0).
type WarmupCapReader interface {
	CapForToday(ctx context.Context, tenantID string) (int, error)
}

// DistributionBucket is one (hour, count) pair in the histogram. Hour
// is 0..23 UTC. count is recipients landing in that hour across the
// entire scheduling window.
type DistributionBucket struct {
	Hour  int `json:"hour"`
	Count int `json:"count"`
}

// SchedulePreviewResponse is the dry-run envelope. Mirrors the shape
// the real Schedule POST returns for the fields they share
// (campaign_id, scheduled, tenant_mean, within_days, truncated) plus
// the preview-only signals.
type SchedulePreviewResponse struct {
	CampaignID  string `json:"campaign_id"`
	Scheduled   int    `json:"scheduled"`
	WithinDays  int    `json:"within_days"`
	TenantMean  int    `json:"tenant_mean"`
	Truncated   bool   `json:"truncated"`
	HardCap     int    `json:"hard_cap"`
	Strategy    string `json:"strategy"`
	ReferenceAt string `json:"reference_at"`

	// Distribution histogram, exactly 24 buckets (one per UTC hour).
	// Empty hours are returned with Count=0 so the desktop can render a
	// stable 24-column chart without conditional spacing logic.
	Distribution []DistributionBucket `json:"distribution"`

	// MaxPerMinute is the largest count of recipients landing in any
	// single minute of the entire schedule. Surfaces over-burst risk
	// for tenants whose SMTP pool throttles aggressively.
	MaxPerMinute int `json:"max_per_minute"`

	// MaxPerDay is the largest count of recipients landing on any
	// single calendar day of the schedule. Used for the warmup-cap
	// comparison. Returned alongside the breach flag so the desktop
	// can render "X recipients land on Day Y vs cap Z".
	MaxPerDay int `json:"max_per_day"`

	// PeakDayUTC is the UTC date (YYYY-MM-DD) the peak day falls on.
	// Empty string when the schedule is empty.
	PeakDayUTC string `json:"peak_day_utc"`

	// TierCapToday is the tenant's current warmup-day cap. -1 when no
	// cap applies; 0 when the reader was unwired (the desktop renders
	// "—"). Matches the convention used by /send-preview.
	TierCapToday int `json:"tier_cap_today"`

	// WarmupCapBreach is true iff MaxPerDay > TierCapToday AND
	// TierCapToday > 0. Surfaced as a red banner above the Schedule
	// button so the operator can split the campaign or wait a day.
	WarmupCapBreach bool `json:"warmup_cap_breach"`

	// CountedAt is the instant we computed the preview. Lets the
	// desktop show "Computed 12s ago" so a stale preview is obvious
	// after the operator dawdles.
	CountedAt time.Time `json:"counted_at"`
}

type schedulePreviewRequest struct {
	WithinDays  int    `json:"within_days"`
	Strategy    string `json:"strategy"`
	ReferenceAt string `json:"reference_at"`
}

type schedulePreviewOptions struct {
	withinDays  int
	strategy    string
	referenceAt time.Time
}

type schedulePreviewInputError struct {
	code    string
	message string
}

func (e *schedulePreviewInputError) Error() string {
	return e.code
}

func normalizeSchedulePreviewOptions(body schedulePreviewRequest, fallback time.Time) (schedulePreviewOptions, error) {
	if body.WithinDays == 0 {
		body.WithinDays = 7
	}
	if body.WithinDays < 7 || body.WithinDays > 30 {
		return schedulePreviewOptions{}, &schedulePreviewInputError{
			code:    "invalid_within_days",
			message: "within_days must be between 7 and 30",
		}
	}
	strategy := strings.TrimSpace(body.Strategy)
	if strategy == "" {
		strategy = "per_recipient"
	}
	if !allowedStrategies[strategy] {
		return schedulePreviewOptions{}, &schedulePreviewInputError{
			code:    "invalid_strategy",
			message: "strategy must be per_recipient or modal_hour",
		}
	}
	referenceAt := fallback.UTC()
	if strings.TrimSpace(body.ReferenceAt) != "" {
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(body.ReferenceAt))
		if err != nil {
			return schedulePreviewOptions{}, &schedulePreviewInputError{
				code:    "invalid_reference_at",
				message: "reference_at must be an RFC3339 timestamp",
			}
		}
		referenceAt = parsed.UTC()
	}
	return schedulePreviewOptions{
		withinDays:  body.WithinDays,
		strategy:    strategy,
		referenceAt: referenceAt,
	}, nil
}

// SchedulePreview POST /api/v1/campaigns/{id}/schedule-by-best-time/preview.
//
// Same request body shape as the commit endpoint (within_days, strategy,
// reference_at) so the desktop can ship the SAME form state to both
// endpoints with no transformation. The body is optional — POST with an
// empty body returns the default-7-day preview.
//
// Why POST and not GET: the body carries strategy/reference_at and
// `within_days`. GET with query-params would work today but the
// commit endpoint is a POST and keeping verbs aligned simplifies the
// desktop's submit wiring.
func (d *Deps) SchedulePreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var body schedulePreviewRequest
	if err := httpbody.DecodeJSONWith(w, r, scheduleJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	options, inputErr := normalizeSchedulePreviewOptions(body, time.Now())
	if inputErr != nil {
		var invalid *schedulePreviewInputError
		if errors.As(inputErr, &invalid) {
			httperror.Write(w, http.StatusBadRequest, invalid.code, invalid.message)
			return
		}
		httperror.WriteInternal(w, d.Logger, inputErr, r.Context())
		return
	}
	strategyLabel := options.strategy
	now := options.referenceAt
	campaignID := chi.URLParam(r, "id")
	if _, err := uuid.Parse(campaignID); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_campaign_id", "campaign id must be a UUID")
		return
	}
	recipients, mean, truncated, err := d.Repo.loadCampaignRecipients(r.Context(), t.ID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("campaign_not_found", "campaign not found for tenant"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// modal_hour strategy: replace each recipient's best_hour with the
	// audience's modal hour so preview and commit produce the same
	// schedule for `strategy=modal_hour`.
	if strategyLabel == "modal_hour" {
		hours := make([]int, 0, len(recipients))
		for _, r := range recipients {
			if r.BestHour != nil {
				hours = append(hours, *r.BestHour)
			}
		}
		modal, _ := Mode(hours)
		// Override: every recipient gets the same modal hour. Cold
		// recipients (BestHour=nil) still fall back to tenantMean via
		// ScheduleByBestTime — we leave them nil here.
		for i := range recipients {
			if recipients[i].BestHour != nil {
				h := modal
				recipients[i].BestHour = &h
			}
		}
	}

	schedule := ScheduleByBestTime(now, options.withinDays, recipients, mean)

	resp := SchedulePreviewResponse{
		CampaignID:   campaignID,
		Scheduled:    len(schedule),
		WithinDays:   options.withinDays,
		TenantMean:   mean,
		Truncated:    truncated,
		HardCap:      CampaignRecipientLoadHardCap,
		Strategy:     strategyLabel,
		ReferenceAt:  now.Format(time.RFC3339),
		Distribution: buildDistribution(schedule),
		CountedAt:    now,
		TierCapToday: 0,
	}
	resp.MaxPerMinute, resp.MaxPerDay, resp.PeakDayUTC = computeBurstWindows(schedule)

	if d.Warmup != nil {
		if cap, werr := d.Warmup.CapForToday(r.Context(), t.ID); werr == nil {
			resp.TierCapToday = cap
			// breach only meaningful when the tenant actually has a
			// cap (cap > 0). -1 (no cap) and 0 (no warmup state) both
			// mean "no breach possible".
			if cap > 0 && resp.MaxPerDay > cap {
				resp.WarmupCapBreach = true
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// buildDistribution returns a 24-element histogram of recipients by
// UTC hour-of-day. Always returns exactly 24 entries; empty hours have
// Count=0 so the desktop can render a stable column chart.
func buildDistribution(schedule []Schedule) []DistributionBucket {
	counts := [24]int{}
	for _, s := range schedule {
		h := s.SendAt.UTC().Hour()
		if h < 0 || h > 23 {
			continue
		}
		counts[h]++
	}
	out := make([]DistributionBucket, 24)
	for i := 0; i < 24; i++ {
		out[i] = DistributionBucket{Hour: i, Count: counts[i]}
	}
	return out
}

// computeBurstWindows returns (maxPerMinute, maxPerDay, peakDayUTC).
//
// maxPerMinute is the largest recipient count landing in any single
// "YYYY-MM-DDTHH:MM" UTC bucket — this is the "burst" metric the
// desktop displays as an over-burst warning. The scheduler currently
// rounds each send to the top of the hour, so in practice
// maxPerMinute == maxPerHour, but we count by minute so a future
// change to per-minute jitter (Iterable-style smoothing) doesn't
// silently miss bursts.
//
// maxPerDay is the largest count on any UTC calendar day, used for
// the warmup-cap comparison.
//
// peakDayUTC is the YYYY-MM-DD of the peak day; empty when the
// schedule is empty.
//
// O(n) in the size of the schedule; uses two maps so we don't need a
// pre-allocated time range.
func computeBurstWindows(schedule []Schedule) (maxPerMinute, maxPerDay int, peakDayUTC string) {
	if len(schedule) == 0 {
		return 0, 0, ""
	}
	byMinute := make(map[int64]int, 64)
	byDay := make(map[string]int, 16)
	for _, s := range schedule {
		t := s.SendAt.UTC()
		// truncate to minute — Unix seconds / 60.
		minuteKey := t.Unix() / 60
		byMinute[minuteKey]++
		dayKey := t.Format("2006-01-02")
		byDay[dayKey]++
	}
	for _, c := range byMinute {
		if c > maxPerMinute {
			maxPerMinute = c
		}
	}
	for day, c := range byDay {
		if c > maxPerDay {
			maxPerDay = c
			peakDayUTC = day
		}
	}
	return maxPerMinute, maxPerDay, peakDayUTC
}

// MountSchedulePreviewRoute wires the preview endpoint. Kept separate
// from MountRoutes so callers that only want the preview surface (or
// the existing routes) can opt in independently. Production composition
// invokes it through server.MountSendTimeOptimizationRoutes.
//
// ScopeWriteCampaigns keeps the endpoint aligned with the route-auth
// manifest and with the campaign scheduling workflow it informs.
func (d *Deps) MountSchedulePreviewRoute(r chi.Router) {
	preview := r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns))
	preview.Post(
		"/api/v1/campaigns/{id}/schedule-by-best-time/preview",
		observability.RecordSurfaceFunc("send_time_opt", "schedule_preview", d.SchedulePreview),
	)
}

// Compile-time guard that the package keeps `context` imported when
// the only consumer becomes future-removal of the warmup path. The
// real WarmupCapReader usage above is the live consumer.
var _ context.Context = context.TODO()
