// SPDX-License-Identifier: AGPL-3.0-only
//
// Package deliverability_hub is the account-level Deliverability Hub
// surface — the cross-tenant aggregate of bounce / complaint /
// engagement / DNS / blocklist signals that Klaviyo + Resend expose
// as a single 0-100 "deliverability score" with an action center.
//
// Where the per-list list_health package computes a tag-scoped grade
// for one slice of the audience, this package answers the higher-level
// question "is my account broadly healthy" and feeds the daily
// reputation-repair worker (GAP-LS-087) when the score drops.
//
// Surfaces (see handlers.go for the exact routes):
//
//	GET  /api/v1/deliverability/hub
//	GET  /api/v1/campaigns/{id}/health
//	GET  /api/v1/deliverability/webhook-errors
//	GET  /api/v1/deliverability/dns-health
//	GET  /api/v1/deliverability/blocklist-hits
//	GET  /api/v1/deliverability/bounce-class-breakdown
//	POST /api/v1/deliverability/repair/override (admin)
//
// Webhook contracts emitted from here (see events.go):
//   - list_health.degraded                (score crosses 60→<60 downward)
//   - account.compliance_suspend          (release-held: no account state owner)
//   - account.deactivate                  (release-held: no account state owner)
//   - account.reactivate                  (release-held: no account state owner)
//
// Reputation-repair worker:
//   When the hub score is <50 for >24h, the worker reduces the tenant's
//   max_sends_per_hour (tenant_sending_settings) by 50% and records an
//   audit row in deliverability_repair_overrides. Operators clear the
//   throttle via POST /api/v1/deliverability/repair/override.

package deliverability_hub

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/list_health"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// Event topic constants emitted by the hub worker. Mirror these in the
// outbound_webhooks AllowedEvents list before exposing externally —
// the dispatcher refuses to deliver unknown topics.
const (
	EventListHealthDegraded       = "list_health.degraded"
	EventAccountComplianceSuspend = "account.compliance_suspend"
	EventAccountDeactivate        = "account.deactivate"
	EventAccountReactivate        = "account.reactivate"
)

// AccountComplianceSuspensionAvailable remains closed until the product has an
// authoritative tenant/account suspension state and a mutation that writes the
// state, audit record, and event intent as one operation. Adjacent privacy and
// compliance workflows are not equivalent to suspending an account and must
// not synthesize this event.
const AccountComplianceSuspensionAvailable = false

// AccountBillingLifecycleAvailable remains closed for the same state-ownership
// reason. A subscription deletion downgrades the tenant to Studio rather than
// deactivating the account, while clearing a dunning flag is debt recovery, not
// reactivation. Those two independent billing transitions must never be
// presented as a paired account lifecycle.
const AccountBillingLifecycleAvailable = false

// DegradedScoreThreshold is the score below which the hub fires the
// list_health.degraded webhook. Crossings are directional — we emit on
// the down-crossing, not on every score recompute under the threshold.
const DegradedScoreThreshold = 60

// AutoThrottleScoreThreshold — score below which the reputation-repair
// worker considers an auto-throttle.
const AutoThrottleScoreThreshold = 50

// AutoThrottleSustainWindow — score has to stay below the threshold for
// at least this long before we cut send rate.
const AutoThrottleSustainWindow = 24 * time.Hour

// AutoThrottleReductionPct — how much we cut max_sends_per_hour by when
// the throttle fires. 0.5 = drop to half the current cap.
const AutoThrottleReductionPct = 0.5

// AutoThrottleRecoveryThreshold is the score a tenant must meet or exceed to be released
// from an automatic throttle.
//
// Deliberately above AutoThrottleScoreThreshold. If entry and exit shared a
// number, a tenant hovering at the boundary would be throttled and released on
// alternate ticks, and every flip halves or doubles their send rate underneath a
// running campaign. The gap is the hysteresis band: above the entry bar but
// below this one, the cap stays on.
const AutoThrottleRecoveryThreshold = 65

// AutoThrottleRecoveryWindow is how long the score must stay above
// AutoThrottleRecoveryThreshold before the cap lifts.
//
// Shorter than the 24h entry window on purpose: the cost of throttling too long
// is a tenant sending at half rate for no reason, while the cost of releasing
// too early is a reputation dip that the entry rule will catch again. The
// asymmetry favours the tenant, and the entry rule remains the backstop.
const AutoThrottleRecoveryWindow = 6 * time.Hour

const (
	// MinimumRateSampleSends is the smallest campaign-send cohort that can
	// resolve the 0.1% complaint redline to at least one event. Below this
	// floor, rate inputs remain visible but do not affect the score or any
	// automated sending-cap decision.
	MinimumRateSampleSends int64 = 1000

	// DeliverabilityScoreModelVersion prevents comparisons between snapshots
	// produced by materially different denominator/cohort semantics.
	DeliverabilityScoreModelVersion = "campaign-cohort-v2-2026-08-02"
)

// Deps wires the HTTP + worker surface.
type Deps struct {
	Pool   *db.Pool
	Bus    *events.Bus
	Logger *slog.Logger

	// HubInterval is the cadence at which the worker re-computes the
	// score, evaluates auto-throttle, and emits webhook events.
	// Defaults to 1h when zero.
	HubInterval time.Duration

	// HealthNotifier raises the operator alert when the account score
	// crosses downward or the reputation-repair worker throttles sending
	// (DELIVERABILITY#15). Optional — nil is a no-op, and the webhook /
	// throttle behaviour is unchanged without it. See health_notify.go.
	HealthNotifier HealthNotifier

	// CapCoordinator is the same shared authority used by the sending-settings
	// route and send admission path. Automatic throttle apply/release mutates
	// tenant_sending_settings too, so bypassing this fence would leave every
	// replica on an indefinitely stale Redis cap.
	CapCoordinator interface {
		BeginCapChangeLocked(context.Context, pgx.Tx, string, *int, *int) (sending.CapChangeLease, error)
		CommitCapChange(context.Context, sending.CapChangeLease, *int) error
		AbortCapChange(context.Context, sending.CapChangeLease) error
	}

	// Test seams for PostgreSQL's deliberately ambiguous COMMIT boundary. They
	// are nil in production, where tx.Commit and the shared exact-receipt reader
	// are used directly.
	commitCapMutationTx func(context.Context, pgx.Tx) error
	capMutationReceipt  func(context.Context, string, string) (bool, error)

	// Clock allows tests to drive deterministic time forward.
	Clock func() time.Time
}

func (d *Deps) now() time.Time {
	if d.Clock != nil {
		return d.Clock()
	}
	return time.Now().UTC()
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// HubScore is the response shape for GET /api/v1/deliverability/hub.
// JSON tags are the canonical contract — the desktop's
// DeliverabilityHubSummary TS type mirrors these names exactly. When
// renaming a field, update apps/desktop/src/lib/api-client.ts in the
// same change so the contract stays 1:1.
//
// `score`/`grade`/`status`/`auto_throttled`/`computed_at` are the
// summary triplet rendered in ScoreCard. `breaches` feeds ActionCenter.
// `history` (last 30 days of sampled snapshots, oldest→newest) and
// `trend`/`trend_delta` are derived from deliverability_hub_snapshots.
type HubScore struct {
	TenantID           string               `json:"tenant_id"`
	Score              int                  `json:"score"`
	Grade              string               `json:"grade"`
	Status             string               `json:"status"`
	Trend              string               `json:"trend"`       // "up" | "down" | "flat"
	TrendDelta         int                  `json:"trend_delta"` // score delta vs 7d ago
	TrendReferenceAt   *time.Time           `json:"trend_reference_at,omitempty"`
	History            []int                `json:"history"` // last 30 sampled scores, oldest→newest
	BounceRate         float64              `json:"bounce_rate"`
	ComplaintRate      float64              `json:"complaint_rate"`
	EngagementRate     float64              `json:"engagement_rate"`
	OpensMachinePct    float64              `json:"opens_machine_pct"`
	EventRateScope     string               `json:"event_rate_scope"`
	ModelVersion       string               `json:"model_version"`
	SampleQualified    bool                 `json:"sample_qualified"`
	MinimumSampleSends int64                `json:"minimum_sample_sends"`
	SampleReason       string               `json:"sample_reason,omitempty"`
	WindowDays         int                  `json:"window_days"`
	Breaches           []ThresholdBreach    `json:"breaches"`
	DNSHealth          map[string]DNSStatus `json:"dns_health"`
	BlocklistHits      []BlocklistHit       `json:"blocklist_hits"`
	AutoThrottled      bool                 `json:"auto_throttled"`
	AutoThrottleReason string               `json:"auto_throttle_reason,omitempty"`
	Totals             HubTotals            `json:"totals"`
	ComputedAt         time.Time            `json:"computed_at"`
}

// HubTotals is the small numeric bag the ScoreCard subtitle renders.
type HubTotals struct {
	Sends7d  int64 `json:"sends_7d"`
	Sends30d int64 `json:"sends_30d"`
}

// ThresholdBreach is one rule trip surfaced in the action center. JSON
// tags here are the canonical contract for DeliverabilityHubBreach in
// the desktop client. The legacy metric/threshold/observed/suggestion
// fields remain for callers that want the raw inputs.
type ThresholdBreach struct {
	Code       string  `json:"code"`
	Severity   string  `json:"severity"` // "info" | "warn" | "critical"
	Title      string  `json:"title"`
	Detail     string  `json:"detail,omitempty"`
	Since      string  `json:"since,omitempty"`
	FixCTA     *FixCTA `json:"fix_cta,omitempty"`
	Metric     string  `json:"metric,omitempty"`
	Threshold  float64 `json:"threshold,omitempty"`
	Observed   float64 `json:"observed,omitempty"`
	Suggestion string  `json:"suggestion,omitempty"`
}

// FixCTA is the action button on a breach row in ActionCenter.
type FixCTA struct {
	Label   string `json:"label"`
	Href    string `json:"href,omitempty"`
	Section string `json:"section,omitempty"`
}

// DNSStatus is one identity's verification state.
type DNSStatus struct {
	Domain      string `json:"domain"`
	SPF         bool   `json:"spf"`
	DKIM        bool   `json:"dkim"`
	DMARC       bool   `json:"dmarc"`
	VerifyState string `json:"verify_state"`
}

// BlocklistHit is a flattened "subject + zone" hit for the action
// center. Aggregated forms live in the blocklist package; this is the
// hub-facing projection.
type BlocklistHit struct {
	SubjectType string    `json:"subject_type"`
	Subject     string    `json:"subject"`
	Zone        string    `json:"zone"`
	Tier1       bool      `json:"tier1"`
	CheckedAt   time.Time `json:"checked_at"`
}

// CampaignHealth is the verdict for a single campaign (GAP-LS-086).
type CampaignHealth struct {
	CampaignID        string   `json:"campaign_id"`
	Status            string   `json:"status"` // "healthy" | "needs_attention" | "insufficient_data"
	Reasons           []string `json:"reasons,omitempty"`
	Score             int      `json:"score"`
	Grade             string   `json:"grade"`
	ModelVersion      string   `json:"model_version"`
	SampleQualified   bool     `json:"sample_qualified"`
	SampleSize        int64    `json:"sample_size"`
	MinimumSampleSize int64    `json:"minimum_sample_size"`
	BounceRate        float64  `json:"bounce_rate"`
	ComplaintRate     float64  `json:"complaint_rate"`
	EngagementRate    float64  `json:"engagement_rate"`
}

// computeHub does the full aggregate.
func (d *Deps) computeHub(ctx context.Context, tenantID string) (HubScore, error) {
	out := HubScore{
		TenantID:           tenantID,
		WindowDays:         30,
		ComputedAt:         d.now(),
		Breaches:           []ThresholdBreach{},
		BlocklistHits:      []BlocklistHit{},
		DNSHealth:          map[string]DNSStatus{},
		History:            []int{},
		Trend:              "flat",
		EventRateScope:     "campaigns",
		ModelVersion:       DeliverabilityScoreModelVersion,
		MinimumSampleSends: MinimumRateSampleSends,
	}

	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	since := d.now().Add(-30 * 24 * time.Hour)

	// Negative/engagement events come from the canonical event log; sends
	// come from campaign_recipients, the actual send ledger. subscriber_events
	// deliberately has no 'sent' event type. Engagement is unique human
	// recipients, not raw open+click events (which can exceed 100%).
	var bounces, complaints, opens, machineOpens, humanEngaged, sent int64
	err = tx.QueryRow(ctx, `
WITH sent_cohort AS (
  SELECT campaign_id, subscriber_email
    FROM campaign_recipients
   WHERE tenant_id = $1::uuid
     AND status = 'sent'
     AND sent_at >= $2
)
SELECT
  count(*) FILTER (WHERE event.event_type = 'bounced'),
  count(*) FILTER (WHERE event.event_type = 'complained'),
  count(*) FILTER (WHERE event.event_type = 'opened'),
  count(*) FILTER (
    WHERE event.event_type = 'opened'
      AND (
        lower(coalesce(event.user_agent,'')) LIKE '%applemail/mpp%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%apple-mail-mpp%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%mail-privacy-proxy%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%icloud-content%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%ggpht.com%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%googleimageproxy%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%outlook-safelinks%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%mimecast%'
        OR lower(coalesce(event.user_agent,'')) LIKE '%proofpoint%'
        OR event.ip <<= '17.57.144.0/24'::inet
        OR event.ip <<= '17.57.145.0/24'::inet
        OR event.ip <<= '17.121.0.0/16'::inet
        OR event.ip <<= '17.241.0.0/16'::inet
      )
  ),
  count(DISTINCT (event.campaign_id, lower(event.subscriber_email::text))) FILTER (
    WHERE event.event_type = 'clicked'
       OR (
         event.event_type = 'opened'
         AND (
           lower(coalesce(event.user_agent,'')) LIKE '%applemail/mpp%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%apple-mail-mpp%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%mail-privacy-proxy%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%icloud-content%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%ggpht.com%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%googleimageproxy%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%outlook-safelinks%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%mimecast%'
           OR lower(coalesce(event.user_agent,'')) LIKE '%proofpoint%'
           OR event.ip <<= '17.57.144.0/24'::inet
           OR event.ip <<= '17.57.145.0/24'::inet
           OR event.ip <<= '17.121.0.0/16'::inet
           OR event.ip <<= '17.241.0.0/16'::inet
         ) IS NOT TRUE
       )
  ),
  (SELECT count(*) FROM sent_cohort)
  FROM subscriber_events AS event
  JOIN sent_cohort AS sent
    ON sent.campaign_id = event.campaign_id
   AND sent.subscriber_email = event.subscriber_email
 WHERE event.tenant_id = $1::uuid
   AND event.at >= $2`, tenantID, since).Scan(
		&bounces, &complaints, &opens, &machineOpens, &humanEngaged, &sent,
	)
	if err != nil {
		return out, err
	}
	out.Totals.Sends30d = sent
	out.SampleQualified = sent >= MinimumRateSampleSends
	if !out.SampleQualified {
		out.SampleReason = "fewer than 1,000 successful campaign sends in the 30-day model window"
	}

	// Rates are per-SEND (30d), not per active-subscriber — they are
	// compared to per-send industry thresholds and drive the auto-throttle
	// that cuts the tenant's real send cap, so the denominator must be
	// sends (D10#1). Matches sender_reputation.go's bounces/sends.
	out.BounceRate = boundedRate(bounces, sent)
	out.ComplaintRate = boundedRate(complaints, sent)
	// Engagement is the share of real sends with at least one human open or
	// click. It is MPP-aware and mathematically bounded to 100%.
	out.EngagementRate = boundedRate(humanEngaged, sent)
	if opens > 0 {
		out.OpensMachinePct = float64(machineOpens) / float64(opens)
	}

	// DNS health snapshot.
	dnsRows, err := tx.Query(ctx, `
SELECT domain, verify_state,
       spf_verified_at IS NOT NULL,
       dkim_verified_at IS NOT NULL,
       dmarc_verified_at IS NOT NULL
 FROM sending_identities
 WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		return out, err
	}
	for dnsRows.Next() {
		var ds DNSStatus
		if scanErr := dnsRows.Scan(&ds.Domain, &ds.VerifyState, &ds.SPF, &ds.DKIM, &ds.DMARC); scanErr != nil {
			dnsRows.Close()
			return out, scanErr
		}
		out.DNSHealth[ds.Domain] = ds
	}
	if rowsErr := dnsRows.Err(); rowsErr != nil {
		dnsRows.Close()
		return out, rowsErr
	}
	dnsRows.Close()

	// Recent blocklist hits (30d, listed=true).
	hits, err := tx.Query(ctx, `
WITH latest AS (
  SELECT DISTINCT ON (subject_type, subject, zone)
         subject_type, subject, zone, listed, confidence, checked_at
    FROM blocklist_observations
   WHERE tenant_id = $1::uuid AND checked_at >= $2
   ORDER BY subject_type, subject, zone, checked_at DESC
)
SELECT subject_type, subject, zone, confidence, checked_at
  FROM latest WHERE listed = true
 ORDER BY checked_at DESC
 LIMIT 50`, tenantID, since)
	if err != nil {
		return out, err
	}
	for hits.Next() {
		var h BlocklistHit
		var confidence float64
		if scanErr := hits.Scan(&h.SubjectType, &h.Subject, &h.Zone, &confidence, &h.CheckedAt); scanErr != nil {
			hits.Close()
			return out, scanErr
		}
		h.Tier1 = confidence >= 0.95
		out.BlocklistHits = append(out.BlocklistHits, h)
	}
	if rowsErr := hits.Err(); rowsErr != nil {
		hits.Close()
		return out, rowsErr
	}
	hits.Close()

	// Score + grade.
	// Only evaluate the engagement floor with a meaningful 30-day send
	// sample. Active-list size alone incorrectly marks idle workspaces cold.
	score, grade, breaches := scoreHub(out, sent)
	out.Score = score
	out.Grade = grade
	out.Breaches = breaches
	if out.SampleQualified {
		out.Status = statusLabel(grade, len(breaches))
	} else {
		out.Status = "Insufficient data"
	}

	// 7d sends total — the ScoreCard subtitle reads this. The recipient
	// ledger is the canonical source of successful sends.
	sevenDaysAgo := d.now().Add(-7 * 24 * time.Hour)
	var sends7d int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM campaign_recipients
 WHERE tenant_id = $1::uuid AND status = 'sent' AND sent_at >= $2`,
		tenantID, sevenDaysAgo).Scan(&sends7d); err != nil {
		return out, err
	}
	out.Totals.Sends7d = sends7d

	// History sparkline uses only qualified snapshots from the current score
	// model. Legacy denominator semantics and unqualified samples never enter a
	// current trend.
	hRows, err := tx.Query(ctx, `
SELECT score FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
	AND model_version = $2
	AND sample_qualified = true
	ORDER BY sampled_at DESC LIMIT 30`, tenantID, DeliverabilityScoreModelVersion)
	if err != nil {
		return out, err
	}
	var rev []int
	for hRows.Next() {
		var s int
		if scanErr := hRows.Scan(&s); scanErr != nil {
			hRows.Close()
			return out, scanErr
		}
		rev = append(rev, s)
	}
	if rowsErr := hRows.Err(); rowsErr != nil {
		hRows.Close()
		return out, rowsErr
	}
	hRows.Close()
	// Reverse to oldest→newest so the desktop sparkline reads left→right.
	for i := len(rev) - 1; i >= 0; i-- {
		out.History = append(out.History, rev[i])
	}

	// Compare with a same-model, qualified snapshot within ±12h of seven days
	// ago. If worker history is too sparse, no trend is claimed.
	target := out.ComputedAt.Add(-7 * 24 * time.Hour)
	var trendScore int
	var trendAt time.Time
	err = tx.QueryRow(ctx, `
SELECT score, sampled_at
  FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
   AND model_version = $2
   AND sample_qualified = true
   AND sampled_at BETWEEN $3 AND $4
 ORDER BY abs(extract(epoch FROM (sampled_at - $5)))
 LIMIT 1`, tenantID, DeliverabilityScoreModelVersion,
		target.Add(-12*time.Hour), target.Add(12*time.Hour), target,
	).Scan(&trendScore, &trendAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if err == nil && out.SampleQualified {
		out.TrendReferenceAt = &trendAt
		out.TrendDelta = out.Score - trendScore
		switch {
		case out.TrendDelta > 1:
			out.Trend = "up"
		case out.TrendDelta < -1:
			out.Trend = "down"
		default:
			out.Trend = "flat"
		}
	}

	// Auto-throttle status — read the most recent active override row.
	throttleRow := tx.QueryRow(ctx, `
SELECT reason FROM deliverability_repair_overrides
 WHERE tenant_id = $1::uuid AND cleared_at IS NULL
 ORDER BY created_at DESC LIMIT 1`, tenantID)
	var reason string
	if err := throttleRow.Scan(&reason); err == nil {
		out.AutoThrottled = true
		out.AutoThrottleReason = reason
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}

	return out, nil
}

// statusLabel renders a one-line status string for the ScoreCard
// subtitle. The desktop renders it verbatim, so keep it terse.
func statusLabel(grade string, breachCount int) string {
	switch grade {
	case "A":
		return "Healthy"
	case "B":
		return "Good"
	case "C":
		if breachCount > 0 {
			return "Needs attention"
		}
		return "Watch"
	case "D":
		return "Degraded"
	case "F":
		return "Critical"
	}
	return "Unknown"
}

func boundedRate(numerator, denominator int64) float64 {
	if numerator <= 0 {
		return 0
	}
	if denominator <= 0 {
		return 1
	}
	rate := float64(numerator) / float64(denominator)
	if rate > 1 {
		return 1
	}
	return rate
}

// scoreHub mirrors the list_health scoring but applies the
// account-level thresholds Klaviyo/Resend use. Severity values use the
// canonical "info" | "warn" | "critical" taxonomy that the desktop
// ActionCenter reads. `Code` is a stable identifier the frontend keys
// on, and `FixCTA` routes the operator to the surface that resolves
// the breach.
func scoreHub(h HubScore, recentSends int64) (int, string, []ThresholdBreach) {
	score := 100.0
	breaches := []ThresholdBreach{}

	if recentSends < MinimumRateSampleSends {
		breaches = append(breaches, ThresholdBreach{
			Code: "campaign_sample_insufficient", Metric: "campaign_sends_30d",
			Threshold: float64(MinimumRateSampleSends), Observed: float64(recentSends),
			Severity: "info", Title: "More campaign sends are needed for a qualified rate score",
			Detail:     "Bounce, complaint, and engagement rates remain visible, but they do not affect the score or automated sending caps until the 30-day cohort reaches 1,000 successful campaign sends.",
			Suggestion: "collect a larger successful campaign-send sample",
		})
	} else if h.BounceRate > 0.02 {
		breaches = append(breaches, ThresholdBreach{
			Code: "bounce_rate_high", Metric: "bounce_rate",
			Threshold: 0.02, Observed: h.BounceRate,
			Severity: "critical", Title: "Bounce rate above 2%",
			Detail:     "Review hygiene and suppress hard bounces.",
			Suggestion: "review hygiene + suppress hard bounces",
			FixCTA:     &FixCTA{Label: "Open suppressions", Section: "suppressions"},
		})
		score -= (h.BounceRate - 0.02) * 100 * 4
	} else if h.BounceRate > 0.005 {
		breaches = append(breaches, ThresholdBreach{
			Code: "bounce_rate_warn", Metric: "bounce_rate",
			Threshold: 0.005, Observed: h.BounceRate,
			Severity: "warn", Title: "Bounce rate over ESP warning threshold",
			Detail:     "Monitor — over the 0.5% ESP-warning line.",
			Suggestion: "monitor — over ESP-warning threshold",
			FixCTA:     &FixCTA{Label: "Open suppressions", Section: "suppressions"},
		})
		score -= (h.BounceRate - 0.005) * 100 * 2
	}

	if recentSends >= MinimumRateSampleSends && h.ComplaintRate > 0.001 {
		breaches = append(breaches, ThresholdBreach{
			Code: "complaint_rate_high", Metric: "complaint_rate",
			Threshold: 0.001, Observed: h.ComplaintRate,
			Severity: "critical", Title: "Complaint rate above 0.1%",
			Detail:     "Audit recent campaigns for content/consent issues.",
			Suggestion: "audit recent campaigns for content/consent issues",
			FixCTA:     &FixCTA{Label: "Review campaigns", Section: "campaigns"},
		})
		score -= (h.ComplaintRate - 0.001) * 100 * 80
	} else if recentSends >= MinimumRateSampleSends && h.ComplaintRate > 0.0005 {
		breaches = append(breaches, ThresholdBreach{
			Code: "complaint_rate_warn", Metric: "complaint_rate",
			Threshold: 0.0005, Observed: h.ComplaintRate,
			Severity: "warn", Title: "Approaching FBL redline",
			Detail:     "Complaint rate is climbing — investigate before crossing 0.1%.",
			Suggestion: "approaching FBL redline",
			FixCTA:     &FixCTA{Label: "Review campaigns", Section: "campaigns"},
		})
		score -= (h.ComplaintRate - 0.0005) * 100 * 40
	}

	if h.EngagementRate < 0.10 && recentSends >= MinimumRateSampleSends {
		breaches = append(breaches, ThresholdBreach{
			Code: "engagement_cold", Metric: "engagement_rate",
			Threshold: 0.10, Observed: h.EngagementRate,
			Severity: "critical", Title: "List engagement below 10%",
			Detail:     "List looks cold — run a sunset / re-engagement flow.",
			Suggestion: "list looks cold — run sunset flow",
			FixCTA:     &FixCTA{Label: "Open sequences", Section: "sequences"},
		})
		score -= (0.10 - h.EngagementRate) * 100 * 1
	}

	dnsBroken := 0
	for _, ds := range h.DNSHealth {
		if ds.VerifyState != "verified" {
			dnsBroken++
		}
	}
	if dnsBroken > 0 {
		breaches = append(breaches, ThresholdBreach{
			Code: "dns_broken", Metric: "dns_health",
			Threshold: 0, Observed: float64(dnsBroken),
			Severity: "critical", Title: "DNS records missing on sending domain(s)",
			Detail:     "SPF / DKIM / DMARC not fully verified — fix in Custom domains.",
			Suggestion: "DNS records missing/partial on sending domains",
			FixCTA:     &FixCTA{Label: "Fix DNS", Section: "domains"},
		})
		score -= float64(dnsBroken) * 5
	}

	if len(h.BlocklistHits) > 0 {
		tier1 := 0
		for _, hit := range h.BlocklistHits {
			if hit.Tier1 {
				tier1++
			}
		}
		sev := "warn"
		if tier1 > 0 {
			sev = "critical"
		}
		breaches = append(breaches, ThresholdBreach{
			Code: "blocklist_hits", Metric: "blocklist_hits",
			Threshold: 0, Observed: float64(len(h.BlocklistHits)),
			Severity: sev, Title: "Subject(s) listed on a blocklist",
			Detail:     "Sending IP / domain detected on a DNSBL — request delisting after fixing the root cause.",
			Suggestion: "subject(s) listed on DNSBL — review and request delisting",
			// Must match the desktop Section union ("deliverabilityHub"); the
			// legacy "deliverability" fell through renderSection to Dashboard
			// so "Review hits" navigated to the wrong page (D10#9).
			FixCTA: &FixCTA{Label: "Review hits", Section: "deliverabilityHub"},
		})
		score -= float64(len(h.BlocklistHits)) * 2
		score -= float64(tier1) * 10
	}

	if score < 0 {
		score = 0
	}
	rounded := int(score + 0.5)
	grade := "F"
	switch {
	case rounded >= 90:
		grade = "A"
	case rounded >= 75:
		grade = "B"
	case rounded >= 60:
		grade = "C"
	case rounded >= 40:
		grade = "D"
	}
	return rounded, grade, breaches
}

// computeCampaignHealth answers GAP-LS-086: "healthy" or "needs
// attention" for one campaign, with the reasons surfaced inline so
// the operator can act on them.
func (d *Deps) computeCampaignHealth(ctx context.Context, tenantID, campaignID string) (CampaignHealth, error) {
	out := CampaignHealth{
		CampaignID:        campaignID,
		Status:            "insufficient_data",
		Grade:             "N/A",
		ModelVersion:      DeliverabilityScoreModelVersion,
		MinimumSampleSize: MinimumRateSampleSends,
	}

	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pull successful sends in the same 30-day window as the event numerator.
	// Pending/cancelled/skipped recipients are not a valid rate denominator.
	since := d.now().Add(-30 * 24 * time.Hour)
	var bounces, complaints, humanEngaged, total int64
	err = tx.QueryRow(ctx, `
WITH sent AS (
  SELECT subscriber_email
    FROM campaign_recipients
   WHERE tenant_id = $1::uuid
     AND campaign_id = $2::uuid
     AND status = 'sent'
     AND sent_at >= $3
)
SELECT
  (SELECT count(*) FROM sent) AS total,
  count(*) FILTER (WHERE event_type = 'bounced') AS bounces,
  count(*) FILTER (WHERE event_type = 'complained') AS complaints,
  count(DISTINCT subscriber_email) FILTER (
    WHERE event_type = 'clicked'
       OR (
         event_type = 'opened'
		 AND (
           lower(coalesce(user_agent,'')) LIKE '%applemail/mpp%'
           OR lower(coalesce(user_agent,'')) LIKE '%apple-mail-mpp%'
           OR lower(coalesce(user_agent,'')) LIKE '%mail-privacy-proxy%'
           OR lower(coalesce(user_agent,'')) LIKE '%icloud-content%'
           OR lower(coalesce(user_agent,'')) LIKE '%ggpht.com%'
           OR lower(coalesce(user_agent,'')) LIKE '%googleimageproxy%'
           OR lower(coalesce(user_agent,'')) LIKE '%outlook-safelinks%'
           OR lower(coalesce(user_agent,'')) LIKE '%mimecast%'
           OR lower(coalesce(user_agent,'')) LIKE '%proofpoint%'
           OR ip <<= '17.57.144.0/24'::inet
           OR ip <<= '17.57.145.0/24'::inet
           OR ip <<= '17.121.0.0/16'::inet
           OR ip <<= '17.241.0.0/16'::inet
		 ) IS NOT TRUE
       )
  ) AS human_engaged
 FROM subscriber_events
WHERE tenant_id = $1::uuid
  AND campaign_id = $2::uuid
	AND at >= $3
	AND EXISTS (
	  SELECT 1 FROM sent
	   WHERE sent.subscriber_email = subscriber_events.subscriber_email
	)`,
		tenantID, campaignID, since).Scan(&total, &bounces, &complaints, &humanEngaged)
	if err != nil {
		return out, err
	}

	bounceRate := boundedRate(bounces, total)
	complaintRate := boundedRate(complaints, total)
	engagement := boundedRate(humanEngaged, total)
	out.SampleSize = total
	out.SampleQualified = total >= MinimumRateSampleSends
	out.BounceRate = bounceRate
	out.ComplaintRate = complaintRate
	out.EngagementRate = engagement
	if !out.SampleQualified {
		out.Reasons = []string{"fewer than 1,000 successful campaign sends in the 30-day model window"}
		return out, nil
	}

	reasons := []string{}
	if bounceRate > 0.02 {
		reasons = append(reasons, "bounce_rate above 2%")
	}
	if complaintRate > 0.001 {
		reasons = append(reasons, "complaint_rate above 0.1%")
	}
	if engagement < 0.10 {
		reasons = append(reasons, "human engagement under 10%")
	}
	stub := HubScore{
		BounceRate: bounceRate, ComplaintRate: complaintRate, EngagementRate: engagement,
	}
	out.Score, out.Grade, _ = scoreHub(stub, total)
	out.Reasons = reasons
	out.Status = "healthy"
	if len(reasons) > 0 {
		out.Status = "needs_attention"
	}
	return out, nil
}

// --- background worker ----------------------------------------------

// Worker runs the periodic recompute + auto-throttle + webhook emission
// loop. One per replica; the SELECT FOR UPDATE on the throttle row
// keeps multi-replica deployments coherent.
type Worker struct {
	Deps *Deps
}

// Run blocks until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Deps == nil || w.Deps.Pool == nil {
		return nil
	}
	interval := w.Deps.HubInterval
	if interval <= 0 {
		interval = time.Hour
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && w.Deps.Logger != nil {
			w.Deps.Logger.Warn("deliverability_hub tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick walks every tenant with score-relevant evidence and evaluates the
// score → emits degraded webhook + applies auto-throttle as needed.
func (w *Worker) tick(ctx context.Context) error {
	tenants, err := w.listWorkerTenants(ctx)
	if err != nil {
		return err
	}

	var tenantErrs []error
	for _, tid := range tenants {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.processTenant(ctx, tid); err != nil {
			tenantErrs = append(tenantErrs, fmt.Errorf("tenant %s: %w", tid, err))
		}
	}
	if err := w.deliverPendingDegradationNotifications(ctx); err != nil {
		tenantErrs = append(tenantErrs, err)
	}
	return errors.Join(tenantErrs...)
}

func (w *Worker) processTenant(ctx context.Context, tenantID string) error {
	hub, err := w.Deps.computeHub(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("compute hub score: %w", err)
	}

	// The prior read, snapshot append, and down-crossing claim share one
	// tenant/model transaction. Only the durable claim winner may announce the
	// edge, so replicas cannot double-deliver the webhook/operator alert.
	transition, err := w.recordSnapshotAndClaimDegradation(ctx, tenantID, hub)
	if err != nil {
		return fmt.Errorf("record and claim degradation transition: %w", err)
	}
	if transition.Claimed {
		// Presentation echo only. The customer webhook intent committed in the
		// snapshot transaction, and operator delivery is drained from the leased
		// claim outbox below even after a replica crash.
		w.emitDegraded(tenantID, hub)
	}
	if err := transition.validateThrottleSnapshot(hub.ModelVersion); err != nil {
		return err
	}

	// Persist every canonical snapshot observation, including healthy scores: a
	// healthy sample or a missed cadence resets the durable low-score clock. A
	// second replica can compute different live values after the cadence owner
	// commits; using the values read back with ToSnapshotID keeps throttle policy
	// and its durable evidence inseparable. The apply path and cap mutation share
	// one serialized transaction.
	repair, err := w.observeAndMaybeAutoThrottle(
		ctx,
		tenantID,
		transition.ToSnapshotScore,
		transition.ToSnapshotSampleQualified,
		transition.ToSnapshotID,
		transition.ToSnapshotSampledAt,
	)
	if err != nil {
		return err
	}
	// The release half. A cap a machine applied must be liftable by a machine:
	// `clearOverride`'s only non-test caller was the admin route, so a tenant
	// whose reputation recovered stayed at half their sending rate until a human
	// noticed — and nothing prompts that, because recovery is exactly the event
	// that produces no alert.
	if repair.Released {
		w.Deps.log().Info("deliverability_hub: auto-throttle released",
			"tenant", tenantID,
			"score", transition.ToSnapshotScore,
			"cap_convergence_pending", repair.CapConvergencePending)
	}
	if repair.Applied {
		w.Deps.log().Warn("deliverability_hub: auto-throttle applied",
			"tenant", tenantID,
			"score", transition.ToSnapshotScore,
			"override_id", repair.OverrideID,
			"new_cap", repair.NextCap,
			"cap_convergence_pending", repair.CapConvergencePending)
		// Notify only after observeAndMaybeAutoThrottle commits both the exact
		// override row and the cap it installed. This notification remains an
		// in-process presentation effect, not a crash-durable outbox: a process
		// death between commit and this call is still a release qualification
		// hold until throttle notifications gain their own durable intent row.
		w.notifyAutoThrottled(
			ctx,
			tenantID,
			fmt.Sprintf("repair-override:%d", repair.OverrideID),
			transition.ToSnapshotScore,
			repair.PriorCap,
			repair.NextCap,
		)
	}
	return nil
}

// --- webhook emission -----------------------------------------------

// emitDegraded is the best-effort realtime presentation echo. Durable customer
// webhook rows are inserted transactionally with the degradation claim by
// recordSnapshotAndClaimDegradation; the Bus must never be their authority.
func (w *Worker) emitDegraded(tenantID string, hub HubScore) {
	if w.Deps.Bus == nil {
		return
	}
	w.Deps.Bus.Publish(events.Event{
		Topic:    EventListHealthDegraded,
		TenantID: tenantID,
		Payload:  degradationEventPayload(tenantID, hub, 0),
	})
}

func degradationEventPayload(tenantID string, hub HubScore, incidentSnapshotID int64) map[string]any {
	reasons := []map[string]any{}
	for _, b := range hub.Breaches {
		reasons = append(reasons, map[string]any{
			"metric": b.Metric, "observed": b.Observed, "threshold": b.Threshold,
			"severity": b.Severity,
		})
	}
	payload := map[string]any{
		"tenant_id":            tenantID,
		"account_score":        hub.Score,
		"grade":                hub.Grade,
		"model_version":        hub.ModelVersion,
		"sample_qualified":     hub.SampleQualified,
		"sample_size":          hub.Totals.Sends30d,
		"window_days":          hub.WindowDays,
		"breaches":             reasons,
		"opens_machine_pct":    hub.OpensMachinePct,
		"incident_snapshot_id": incidentSnapshotID,
	}
	return payload
}

// EmitAccountStatusChange is the fail-closed account lifecycle contract. Each
// topic stays withheld until a real account-state owner can supply a paired,
// durable transition. The event shape reserved for that future owner is:
//
//	{
//	  "event": {
//	    "type": "account.compliance_suspend" | "account.deactivate" | "account.reactivate",
//	    "occurred_at": <RFC3339>,
//	    "data": {
//	      "tenant_id": <uuid>,
//	      "reason":    <string>,
//	      "actor":     <string>,   // who / what flipped the state
//	      "effective_at": <RFC3339>
//	    }
//	  }
//	}
func (d *Deps) EmitAccountStatusChange(tenantID, topic, reason, actor string) {
	if d == nil || d.Bus == nil || tenantID == "" {
		return
	}
	if !isAccountStatusTopic(topic) {
		return
	}
	if topic == EventAccountComplianceSuspend && !AccountComplianceSuspensionAvailable {
		return
	}
	if (topic == EventAccountDeactivate || topic == EventAccountReactivate) && !AccountBillingLifecycleAvailable {
		return
	}
	d.Bus.Publish(events.Event{
		Topic:    topic,
		TenantID: tenantID,
		Payload: map[string]any{
			"tenant_id":    tenantID,
			"reason":       reason,
			"actor":        actor,
			"effective_at": d.now().Format(time.RFC3339),
		},
	})
}

func isAccountStatusTopic(topic string) bool {
	switch topic {
	case EventAccountComplianceSuspend, EventAccountDeactivate, EventAccountReactivate:
		return true
	}
	return false
}

// itoa is a small dependency-free int→string for the throttle reason
// label. Using strconv would pull in another import for one line.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// keep imports live for follow-up wiring.
var (
	_ = list_health.Score{}
	_ = listmonk_events.EventOpened
	_ = outbound_webhooks.EventListSubscriberAdded
)
