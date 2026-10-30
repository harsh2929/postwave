// SPDX-License-Identifier: AGPL-3.0-only
//
// Package analytics exposes per-campaign and per-tenant aggregate
// reporting on top of campaign_report_events.
//
// Endpoints:
//
//	GET /api/v1/campaigns/{id}/report   — opens, clicks, bounces,
//	                                       unsubs, top links, geo split
//	                                       for one campaign.
//
//	GET /api/v1/dashboard/stats          — last-30-day rollups + active
//	                                       subscriber count for the
//	                                       tenant.
//
// We compute aggregates at query time rather than maintaining a
// materialised view because (a) campaign_report_events has good indexes
// already (tenant + campaign + event_type) and (b) tenants reading these
// reports want fresh-as-of-now data, not "fresh as of the last cron".
// At higher scale, swap the queries here for reads off a maintained
// summary table without changing the API shape.
package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/singleflight"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// CampaignReport is the aggregate shape returned by GET
// /api/v1/campaigns/{id}/report.
type CampaignReport struct {
	CampaignID      string      `json:"campaign_id"`
	Sent            int         `json:"sent"`
	Delivered       int         `json:"delivered"`
	Opens           int         `json:"opens"`
	UniqueOpens     int         `json:"unique_opens"`
	Clicks          int         `json:"clicks"`
	UniqueClicks    int         `json:"unique_clicks"`
	Bounces         int         `json:"bounces"`
	Complaints      int         `json:"complaints"`
	Unsubscribes    int         `json:"unsubscribes"`
	OpenRate        float64     `json:"open_rate"`          // unique_opens / delivered
	ClickRate       float64     `json:"click_rate"`         // unique_clicks / delivered
	ClickToOpenRate float64     `json:"click_to_open_rate"` // unique_clicks / unique_opens
	BounceRate      float64     `json:"bounce_rate"`        // bounces / sent
	UnsubRate       float64     `json:"unsub_rate"`         // unsubscribes / delivered
	TopLinks        []LinkStats `json:"top_links"`

	// G2 (campaigns 2026 pack 1): bot-stripped engagement. Apple Mail
	// Privacy Protection inflates raw opens 25-40% on iOS devices;
	// Gmail Image Proxy + Safe Links scanners pad open + click counts
	// further. These fields apply the same regex classifier
	// bot_open_filter.combinedPattern uses for the dashboard panel,
	// extended to per-campaign reporting + a 2s open→click bot-dedup
	// window to strip scanner unfurls. Fields are zero when
	// Repo.HumanEngagementEnabled is false so the wire-shape stays
	// stable across the env-flag flip.
	HumanOpens           int         `json:"human_opens"`
	HumanUniqueOpens     int         `json:"human_unique_opens"`
	HumanClicks          int         `json:"human_clicks"`
	HumanUniqueClicks    int         `json:"human_unique_clicks"`
	HumanOpenRate        float64     `json:"human_open_rate"`
	HumanClickRate       float64     `json:"human_click_rate"`
	HumanClickToOpenRate float64     `json:"human_click_to_open_rate"`
	HumanTopLinks        []LinkStats `json:"human_top_links"`
	BotSignaturesApplied []string    `json:"bot_signatures_applied"`
}

// LinkStats is one row in the report's top-links section.
type LinkStats struct {
	URL    string `json:"url"`
	Clicks int    `json:"clicks"`
}

// FunnelStep is one row of a drip-funnel report.
type FunnelStep struct {
	Position int `json:"position"`
	// StepID is the producer-supplied stable step identifier (A22,
	// desktop audit 2026-06-10). Branch steps re-use position numbers
	// across condition branches, so position alone cannot key a funnel
	// row; step_id disambiguates (e.g. "p2" vs "p1:yes:p2"). Empty —
	// and omitted on the wire — for legacy rows written before
	// migration 0367, which keeps the payload backward compatible.
	StepID    string  `json:"step_id,omitempty"`
	Reached   int     `json:"reached"`
	Opened    int     `json:"opened"`
	Clicked   int     `json:"clicked"`
	OpenRate  float64 `json:"open_rate"`
	ClickRate float64 `json:"click_rate"`
	// DropoffPct: fraction of subscribers at the previous position
	// who did NOT reach this position. 0 for position=0. Useful for
	// "where am I losing people in this drip?" Rows sharing a position
	// (sibling branch steps) carry the same position-level dropoff.
	DropoffPct float64 `json:"dropoff_pct"`

	// Variants is the per-arm breakdown for a step that carries an A/B
	// split. Empty (and omitted on the wire) for steps without variants,
	// so the payload stays backward compatible. The per-arm counts sum
	// to the step's Reached/Opened/Clicked — every reached subscriber is
	// assigned exactly one arm (stamped sequence_funnel_events.variant_key
	// when the producer set it, else recomputed deterministically; see
	// SequenceFunnel). Ordered by the variant's stored order so "A"
	// always precedes "B".
	Variants []FunnelVariantBreakdown `json:"variants,omitempty"`
}

// FunnelVariantBreakdown is one A/B arm's slice of a step's funnel
// counts. variant_key matches the EmailVariant.Key configured on the
// step; the rates mirror FunnelStep's (open/click over this arm's
// reached cohort).
type FunnelVariantBreakdown struct {
	VariantKey string  `json:"variant_key"`
	Reached    int     `json:"reached"`
	Opened     int     `json:"opened"`
	Clicked    int     `json:"clicked"`
	OpenRate   float64 `json:"open_rate"`
	ClickRate  float64 `json:"click_rate"`
}

// SequenceFunnel is the aggregate report for one sequence.
type SequenceFunnel struct {
	SequenceID string       `json:"sequence_id"`
	Steps      []FunnelStep `json:"steps"`
}

// DashboardStats is what GET /api/v1/dashboard/stats returns. Tile-
// shaped so the web/mobile dashboard can render directly without
// further aggregation.
//
// Refined Dashboard (PR 1) added:
//   - Range, Previous (period-over-period comparison)
//   - Sparklines (daily buckets per metric)
//   - Anomalies (z-score flags per metric)
//
// The legacy fields (SubscribersAdded30d, etc.) keep their names for
// wire compat — when Range != "30d" they still represent the
// requested window. Callers reading these fields keep working
// regardless of range; the field names just become a slight misnomer.
type DashboardStats struct {
	SubscribersTotal       int          `json:"subscribers_total"`
	SubscribersAdded30d    int          `json:"subscribers_added_30d"`
	SubscribersUnsubbed30d int          `json:"subscribers_unsubbed_30d"`
	CampaignsSent30d       int          `json:"campaigns_sent_30d"`
	OpensTotal30d          int          `json:"opens_total_30d"`
	UniqueOpens30d         int          `json:"unique_opens_30d"`
	UniqueClicks30d        int          `json:"unique_clicks_30d"`
	UniqueBounces30d       int          `json:"unique_bounces_30d"`
	UniqueDelivered30d     int          `json:"unique_delivered_30d"`
	UniqueSent30d          int          `json:"unique_sent_30d"`
	ClicksTotal30d         int          `json:"clicks_total_30d"`
	BouncesTotal30d        int          `json:"bounces_total_30d"`
	ActiveSequencesCount   int          `json:"active_sequences_count"`
	InboxHealth            *InboxHealth `json:"inbox_health,omitempty"`
	// RecentAudit is retained only for wire compatibility with older clients.
	// Dashboard endpoints intentionally leave it empty: audit actor/action data
	// belongs behind the dedicated audit:read surface, not read:reports.
	RecentAudit []DashboardAuditEvent `json:"recent_audit,omitempty"`
	// EmailsSent30d is gross sent-event volume. Verified dashboard rates use
	// the distinct campaign-recipient fields above; this legacy field remains
	// available for wire compatibility and volume reporting.
	EmailsSent30d int `json:"emails_sent_30d"`

	// PR 1 additions — omitempty so legacy snapshots/tests stay clean.
	Range      string           `json:"range,omitempty"`
	Previous   *PreviousWindow  `json:"previous,omitempty"`
	Sparklines map[string][]int `json:"sparklines,omitempty"`
	Anomalies  map[string]bool  `json:"anomalies,omitempty"`
}

type InboxHealth struct {
	Score int    `json:"score"`
	State string `json:"state"`
}

const dashboardInboxHealthFreshInterval = "24 hours"

type DashboardAuditEvent struct {
	ID          string    `json:"id"`
	Action      string    `json:"action"`
	Actor       string    `json:"actor"`
	At          time.Time `json:"at"`
	Description string    `json:"description"`
}

// PreviousWindow holds the comparison-window counts (one window of the
// same duration, immediately preceding the current window). Field names
// match DashboardStats sans the "30d" suffix.
type PreviousWindow struct {
	SubscribersAdded    int `json:"subscribers_added"`
	SubscribersUnsubbed int `json:"subscribers_unsubbed"`
	CampaignsSent       int `json:"campaigns_sent"`
	OpensTotal          int `json:"opens_total"`
	ClicksTotal         int `json:"clicks_total"`
	BouncesTotal        int `json:"bounces_total"`
	UniqueOpens         int `json:"unique_opens"`
	UniqueClicks        int `json:"unique_clicks"`
	UniqueBounces       int `json:"unique_bounces"`
	UniqueDelivered     int `json:"unique_delivered"`
	UniqueSent          int `json:"unique_sent"`
	// EmailsSent mirrors DashboardStats.EmailsSent30d gross sent-event volume
	// for the previous window.
	EmailsSent int `json:"emails_sent"`
}

// DashboardStatsOptions configures DashboardStatsWithOptions. Zero
// values match the legacy behavior: 30-day window, no comparison, no
// sparklines.
type DashboardStatsOptions struct {
	Range      string // "7d" | "30d" | "90d"; "" → "30d"
	Compare    bool   // when true, populate Previous
	Sparklines bool   // when true, populate Sparklines + Anomalies
}

// Repo wraps the pgx pool with the read-only aggregate queries.
type Repo struct {
	Pool *db.Pool
	// HumanEngagementEnabled gates the G2 bot-stripped human_* fields
	// on CampaignReport. When false (default), CampaignReport skips the
	// classifier query and leaves the human_* fields zero so the wire
	// shape stays stable across the flag. Wired from
	// POSTWAVE_HUMAN_ENGAGEMENT in main.go; test suites toggle directly.
	HumanEngagementEnabled bool

	// Sparkline cache (p4c-dashboard-sparkline-sargable). The dashboard
	// SSE stream (dashboard_live.go) polls DashboardStats every 2s.
	// With ~5 tabs open per tenant that's 300 full sparkline scans/min.
	// A 2s TTL singleflight cache collapses concurrent polls and reuses
	// the last result while it's still fresh — net 1 query per tenant
	// per ~2s window instead of N-per-tab. Keyed by "tenantID|days"
	// so different range options stay isolated.
	sparkCacheMu sync.Mutex
	sparkCache   map[string]sparklineCacheEntry
	sparkGroup   singleflight.Group
}

// sparklineCacheEntry holds one window's worth of sparklines plus an
// expiry. TTL is intentionally tight (2s) so the SSE stream collapses
// concurrent polls without surfacing visibly stale numbers.
type sparklineCacheEntry struct {
	val    map[string][]int
	expiry time.Time
}

// sparklineCacheTTL is the per-(tenant,days) cache lifetime. Sized to
// match the 2s DashboardLive poll cadence — see sparkCache docs above.
const sparklineCacheTTL = 2 * time.Second

// CampaignReport runs five quick aggregate queries in one tenant tx.
// All counts come straight from campaign_report_events; we never join
// against subscribers (that table can be huge — keep this fast).
func (r *Repo) CampaignReport(ctx context.Context, tenantID, campaignID string) (*CampaignReport, error) {
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Aggregate queries always return an empty result set for an unknown UUID,
	// which previously made a missing (or other-tenant) campaign look like a
	// valid zero-event report. Pin existence through the same tenant-bound tx
	// first so callers receive the handler's nondisclosing 404 contract.
	var campaignExists int
	if err := tx.QueryRow(ctx, `
SELECT 1
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID).Scan(&campaignExists); err != nil {
		return nil, err
	}

	rep := &CampaignReport{CampaignID: campaignID}
	// Single GROUP BY pulls every event-type bucket in one query.
	rows, err := tx.Query(ctx, `
SELECT event_type, count(*)::int, count(DISTINCT subscriber_email)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 GROUP BY event_type`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var et string
		var n, uniq int
		if err := rows.Scan(&et, &n, &uniq); err != nil {
			rows.Close()
			return nil, err
		}
		switch et {
		case "sent":
			rep.Sent = n
		case "delivered":
			rep.Delivered = n
		case "opened":
			rep.Opens = n
			rep.UniqueOpens = uniq
		case "clicked":
			rep.Clicks = n
			rep.UniqueClicks = uniq
		case "bounced":
			rep.Bounces = n
		case "complained":
			rep.Complaints = n
		case "unsubscribed":
			rep.Unsubscribes = n
		}
	}
	rows.Close()

	// Top 5 links by click count. Cheap because of the campaign_report_events
	// index on (tenant, campaign, event_type, at).
	linkRows, err := tx.Query(ctx, `
SELECT link_url, count(*)::int AS clicks
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type = 'clicked' AND link_url IS NOT NULL
 GROUP BY link_url
 ORDER BY clicks DESC
 LIMIT 5`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	for linkRows.Next() {
		var ls LinkStats
		if err := linkRows.Scan(&ls.URL, &ls.Clicks); err != nil {
			linkRows.Close()
			return nil, err
		}
		rep.TopLinks = append(rep.TopLinks, ls)
	}
	linkRows.Close()

	// Compute rates. We guard division-by-zero — a freshly-launched
	// campaign with zero deliveries should report 0% rather than NaN.
	deliveredOrSent := rep.Delivered
	if deliveredOrSent == 0 {
		// Some legacy paths only emit 'sent' (no separate 'delivered').
		// Fall back so the percentages aren't always zero on those flows.
		deliveredOrSent = rep.Sent
	}
	if deliveredOrSent > 0 {
		rep.OpenRate = pct(rep.UniqueOpens, deliveredOrSent)
		rep.ClickRate = pct(rep.UniqueClicks, deliveredOrSent)
		rep.UnsubRate = pct(rep.Unsubscribes, deliveredOrSent)
	}
	if rep.Sent > 0 {
		rep.BounceRate = pct(rep.Bounces, rep.Sent)
	}
	if rep.UniqueOpens > 0 {
		rep.ClickToOpenRate = pct(rep.UniqueClicks, rep.UniqueOpens)
	}

	// G2: bot-stripped human counts. Skipped entirely when the env flag
	// is off so existing test fixtures + wire snapshots stay byte-equal.
	// Failures inside this block degrade silently — the legacy numbers
	// above already shipped, and surfacing a 500 for an additive
	// feature would be worse than leaving the human_* fields zero.
	if r.HumanEngagementEnabled {
		if err := r.populateHumanEngagement(ctx, tx, tenantID, campaignID, rep, deliveredOrSent); err != nil {
			// Best-effort. Don't propagate; reset partial fields so the
			// response is internally consistent.
			rep.HumanOpens = 0
			rep.HumanUniqueOpens = 0
			rep.HumanClicks = 0
			rep.HumanUniqueClicks = 0
			rep.HumanOpenRate = 0
			rep.HumanClickRate = 0
			rep.HumanClickToOpenRate = 0
			rep.HumanTopLinks = nil
			rep.BotSignaturesApplied = nil
		}
	}

	return rep, tx.Commit(ctx)
}

// populateHumanEngagement fills the human_* fields on rep by re-running
// the open/click aggregations with a bot-pattern exclusion + a 2s
// open→click scanner-unfurl dedup. Reads the same bot_open_signatures
// table the dashboard-level filter uses; tenant-scoped overrides flow
// through automatically.
func (r *Repo) populateHumanEngagement(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
	rep *CampaignReport,
	deliveredOrSent int,
) error {
	combined, labels, err := r.botPatternAndLabels(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if combined == "" {
		// No active signatures for this tenant. Human counts equal raw
		// counts; surface that honestly so the UI toggle stays hidden.
		rep.HumanOpens = rep.Opens
		rep.HumanUniqueOpens = rep.UniqueOpens
		rep.HumanClicks = rep.Clicks
		rep.HumanUniqueClicks = rep.UniqueClicks
		rep.HumanOpenRate = rep.OpenRate
		rep.HumanClickRate = rep.ClickRate
		rep.HumanClickToOpenRate = rep.ClickToOpenRate
		rep.HumanTopLinks = rep.TopLinks
		return nil
	}

	// Open + click totals with the bot-UA exclusion.
	rows, err := tx.Query(ctx, `
SELECT event_type,
       count(*)::int                                                          AS n,
       count(DISTINCT subscriber_email)::int                                   AS uniq
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type IN ('opened','clicked')
   AND COALESCE(user_agent,'') !~ $3
 GROUP BY event_type`, tenantID, campaignID, combined)
	if err != nil {
		return err
	}
	for rows.Next() {
		var et string
		var n, uniq int
		if err := rows.Scan(&et, &n, &uniq); err != nil {
			rows.Close()
			return err
		}
		switch et {
		case "opened":
			rep.HumanOpens = n
			rep.HumanUniqueOpens = uniq
		case "clicked":
			rep.HumanClicks = n
			rep.HumanUniqueClicks = uniq
		}
	}
	rows.Close()

	// Scanner-unfurl dedup: any clicked event firing within 2s of a
	// same-subscriber open is almost certainly a scanner pre-fetching
	// the URL, not a human. We subtract those from the human_clicks
	// totals (raw clicks stay unchanged). Bounded by a small window
	// so the partial-index plan stays fast.
	var unfurlClicks, unfurlUniqueClicks int
	if err := tx.QueryRow(ctx, `
WITH opens AS (
  SELECT subscriber_email, at
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
     AND event_type = 'opened'
     AND COALESCE(user_agent,'') !~ $3
)
SELECT count(c.*)::int,
       count(DISTINCT c.subscriber_email)::int
  FROM campaign_report_events c
  JOIN opens o
    ON o.subscriber_email = c.subscriber_email
   AND c.at >= o.at
   AND c.at <  o.at + interval '2 seconds'
 WHERE c.tenant_id = $1::uuid AND c.campaign_id = $2::uuid
   AND c.event_type = 'clicked'
   AND COALESCE(c.user_agent,'') !~ $3`,
		tenantID, campaignID, combined,
	).Scan(&unfurlClicks, &unfurlUniqueClicks); err == nil {
		if unfurlClicks > rep.HumanClicks {
			unfurlClicks = rep.HumanClicks
		}
		if unfurlUniqueClicks > rep.HumanUniqueClicks {
			unfurlUniqueClicks = rep.HumanUniqueClicks
		}
		rep.HumanClicks -= unfurlClicks
		rep.HumanUniqueClicks -= unfurlUniqueClicks
	}

	// Top links via the same bot-stripped filter.
	linkRows, err := tx.Query(ctx, `
SELECT link_url, count(*)::int AS clicks
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type = 'clicked' AND link_url IS NOT NULL
   AND COALESCE(user_agent,'') !~ $3
 GROUP BY link_url
 ORDER BY clicks DESC
 LIMIT 5`, tenantID, campaignID, combined)
	if err == nil {
		for linkRows.Next() {
			var ls LinkStats
			if err := linkRows.Scan(&ls.URL, &ls.Clicks); err == nil {
				rep.HumanTopLinks = append(rep.HumanTopLinks, ls)
			}
		}
		linkRows.Close()
	}

	// Rates from the bot-stripped uniques. Mirror the raw-rate denominators.
	if deliveredOrSent > 0 {
		rep.HumanOpenRate = pct(rep.HumanUniqueOpens, deliveredOrSent)
		rep.HumanClickRate = pct(rep.HumanUniqueClicks, deliveredOrSent)
	}
	if rep.HumanUniqueOpens > 0 {
		rep.HumanClickToOpenRate = pct(rep.HumanUniqueClicks, rep.HumanUniqueOpens)
	}

	// Only surface the labels of signatures that ACTUALLY matched at
	// least one row in this campaign — operators care about "what was
	// stripped", not "what could have been stripped".
	matched, err := tx.Query(ctx, `
SELECT DISTINCT s.label
  FROM bot_open_signatures s
 WHERE s.enabled
   AND (s.tenant_id IS NULL OR s.tenant_id = $1::uuid)
   AND EXISTS (
     SELECT 1 FROM campaign_report_events e
      WHERE e.tenant_id = $1::uuid AND e.campaign_id = $2::uuid
        AND COALESCE(e.user_agent,'') ~ s.pattern
   )
 ORDER BY s.label`, tenantID, campaignID)
	if err == nil {
		for matched.Next() {
			var lbl string
			if err := matched.Scan(&lbl); err == nil {
				rep.BotSignaturesApplied = append(rep.BotSignaturesApplied, lbl)
			}
		}
		matched.Close()
	}
	// `labels` would be the full enabled-signature catalog — we only
	// expose those that fired; keep `labels` available for future
	// uses (e.g. surfacing un-fired signatures as advisory).
	_ = labels
	return nil
}

// botPatternAndLabels reads enabled bot_open_signatures (platform +
// tenant) and returns the combined regex pattern (OR'd via
// (p1)|(p2)|…) plus the parallel label list. Mirrors
// bot_open_filter.combinedPattern; replicated here to avoid an import
// cycle (analytics imports nothing from bot_open_filter today).
func (r *Repo) botPatternAndLabels(ctx context.Context, tx pgx.Tx, tenantID string) (string, []string, error) {
	rows, err := tx.Query(ctx, `
SELECT pattern, label
  FROM bot_open_signatures
 WHERE enabled AND (tenant_id IS NULL OR tenant_id = $1::uuid)`, tenantID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	parts := []string{}
	labels := []string{}
	for rows.Next() {
		var p, l string
		if err := rows.Scan(&p, &l); err != nil {
			continue
		}
		parts = append(parts, "("+p+")")
		labels = append(labels, l)
	}
	return strings.Join(parts, "|"), labels, nil
}

// DashboardStats is the legacy entry point — preserved for the SSE
// fetcher (apps/api/internal/analytics/dashboard_live.go) and any
// other callers that want the simple 30-day window without comparison
// or sparklines. New code should call DashboardStatsWithOptions.
func (r *Repo) DashboardStats(ctx context.Context, tenantID string) (*DashboardStats, error) {
	return r.DashboardStatsWithOptions(ctx, tenantID, DashboardStatsOptions{})
}

// DashboardStatsWithOptions runs the tenant overview queries for the
// requested window, optionally including the previous window's counts
// for period-over-period comparison and daily-bucketed sparklines.
// All work happens in one tenant tx so the page can render off a
// single round trip.
//
// 30-day windows use `now() - interval '...'` rather than absolute
// dates so the (tenant_id, at DESC, event_type) index on
// campaign_report_events gets used. Same for subscribers (tenant_id,
// created_at).
//
// That index was asserted here (and in the sparkline comment) long before it
// existed: every index on campaign_report_events was campaign_id- or
// subscriber_email-prefixed, so this tenant+window aggregate degenerated to a
// tenant_id-prefix scan of every surviving partition. Migration 1991 adds it
// on the partitioned parent. Do not restate the claim without checking
// `infra/migrations` for the CREATE INDEX that backs it.
func (r *Repo) DashboardStatsWithOptions(
	ctx context.Context, tenantID string, opts DashboardStatsOptions,
) (*DashboardStats, error) {
	days := rangeDays(opts.Range)
	rangeLabel := rangeLabel(opts.Range)
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &DashboardStats{Range: rangeLabel}

	intervalArg := fmt.Sprintf("%d days", days)
	prevIntervalArg := fmt.Sprintf("%d days", 2*days) // 2N → N ago through 2N ago = previous window

	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*)::int FROM subscribers
     WHERE tenant_id = $1::uuid AND status = 'enabled'),
  (SELECT count(*)::int FROM subscribers
     WHERE tenant_id = $1::uuid AND created_at >= now() - $2::interval),
	(SELECT count(DISTINCT subscriber_id)::int FROM list_subscribers
	 WHERE tenant_id = $1::uuid
	   AND removed_at >= now() - $2::interval),
  (SELECT count(*)::int FROM voice_sequences
     WHERE tenant_id = $1::uuid AND status = 'active')
`, tenantID, intervalArg).Scan(
		&out.SubscribersTotal,
		&out.SubscribersAdded30d,
		&out.SubscribersUnsubbed30d,
		&out.ActiveSequencesCount,
	); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
SELECT
  count(DISTINCT campaign_id) FILTER (WHERE event_type = 'sent')::int,
  count(*) FILTER (WHERE event_type = 'opened')::int,
  count(*) FILTER (WHERE event_type = 'clicked')::int,
  count(*) FILTER (WHERE event_type = 'bounced')::int,
  count(*) FILTER (WHERE event_type = 'sent')::int,
  count(DISTINCT (campaign_id, subscriber_email))
    FILTER (WHERE event_type = 'opened' AND subscriber_email IS NOT NULL)::int,
  count(DISTINCT (campaign_id, subscriber_email))
    FILTER (WHERE event_type = 'clicked' AND subscriber_email IS NOT NULL)::int,
  count(DISTINCT (campaign_id, subscriber_email))
    FILTER (WHERE event_type = 'bounced' AND subscriber_email IS NOT NULL)::int,
  count(DISTINCT (campaign_id, subscriber_email))
    FILTER (WHERE event_type = 'delivered' AND subscriber_email IS NOT NULL)::int,
  count(DISTINCT (campaign_id, subscriber_email))
    FILTER (WHERE event_type = 'sent' AND subscriber_email IS NOT NULL)::int
FROM campaign_report_events
WHERE tenant_id = $1::uuid
  AND at >= now() - $2::interval
  AND event_type IN ('sent', 'opened', 'clicked', 'bounced', 'delivered')
`, tenantID, intervalArg).Scan(
		&out.CampaignsSent30d,
		&out.OpensTotal30d,
		&out.ClicksTotal30d,
		&out.BouncesTotal30d,
		&out.EmailsSent30d,
		&out.UniqueOpens30d,
		&out.UniqueClicks30d,
		&out.UniqueBounces30d,
		&out.UniqueDelivered30d,
		&out.UniqueSent30d,
	); err != nil {
		return nil, err
	}

	var inboxScore int
	if err := tx.QueryRow(ctx, `
SELECT score FROM deliverability_hub_snapshots
 WHERE tenant_id = $1::uuid
   AND sampled_at >= now() - $2::interval
 ORDER BY sampled_at DESC
 LIMIT 1`, tenantID, dashboardInboxHealthFreshInterval).Scan(&inboxScore); err == nil {
		out.InboxHealth = &InboxHealth{
			Score: inboxScore,
			State: dashboardInboxHealthState(inboxScore),
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	if opts.Compare {
		prev := &PreviousWindow{}
		// Window: between now-2N and now-N. Same shape as the current
		// queries but with a closed lower + upper bound.
		if err := tx.QueryRow(ctx, `
WITH report AS (
  SELECT
    count(DISTINCT campaign_id) FILTER (WHERE event_type = 'sent')::int AS campaigns_sent,
    count(*) FILTER (WHERE event_type = 'opened')::int AS opens_total,
    count(*) FILTER (WHERE event_type = 'clicked')::int AS clicks_total,
    count(*) FILTER (WHERE event_type = 'bounced')::int AS bounces_total,
    count(*) FILTER (WHERE event_type = 'sent')::int AS emails_sent,
    count(DISTINCT (campaign_id, subscriber_email))
      FILTER (WHERE event_type = 'opened' AND subscriber_email IS NOT NULL)::int AS unique_opens,
    count(DISTINCT (campaign_id, subscriber_email))
      FILTER (WHERE event_type = 'clicked' AND subscriber_email IS NOT NULL)::int AS unique_clicks,
    count(DISTINCT (campaign_id, subscriber_email))
      FILTER (WHERE event_type = 'bounced' AND subscriber_email IS NOT NULL)::int AS unique_bounces,
    count(DISTINCT (campaign_id, subscriber_email))
      FILTER (WHERE event_type = 'delivered' AND subscriber_email IS NOT NULL)::int AS unique_delivered,
    count(DISTINCT (campaign_id, subscriber_email))
      FILTER (WHERE event_type = 'sent' AND subscriber_email IS NOT NULL)::int AS unique_sent
  FROM campaign_report_events
  WHERE tenant_id = $1::uuid
    AND at >= now() - $3::interval
    AND at < now() - $2::interval
    AND event_type IN ('sent', 'opened', 'clicked', 'bounced', 'delivered')
)
SELECT
  (SELECT count(*)::int FROM subscribers
     WHERE tenant_id = $1::uuid
       AND created_at >= now() - $3::interval
       AND created_at <  now() - $2::interval),
  (SELECT count(DISTINCT subscriber_id)::int FROM list_subscribers
     WHERE tenant_id = $1::uuid
       AND removed_at >= now() - $3::interval
       AND removed_at <  now() - $2::interval),
  report.campaigns_sent,
  report.opens_total,
  report.clicks_total,
  report.bounces_total,
  report.emails_sent,
  report.unique_opens,
  report.unique_clicks,
  report.unique_bounces,
  report.unique_delivered,
  report.unique_sent
FROM report
`, tenantID, intervalArg, prevIntervalArg).Scan(
			&prev.SubscribersAdded,
			&prev.SubscribersUnsubbed,
			&prev.CampaignsSent,
			&prev.OpensTotal,
			&prev.ClicksTotal,
			&prev.BouncesTotal,
			&prev.EmailsSent,
			&prev.UniqueOpens,
			&prev.UniqueClicks,
			&prev.UniqueBounces,
			&prev.UniqueDelivered,
			&prev.UniqueSent,
		); err != nil {
			return nil, err
		}
		out.Previous = prev
	}

	if opts.Sparklines {
		// p4c-dashboard-sparkline-sargable: collapse concurrent SSE
		// polls (DashboardLive ticks every 2s; multiple tabs per tenant
		// would otherwise stack identical queries) through a per-tenant
		// 2s TTL singleflight cache. The cache loader reuses the
		// current tenant tx so the per-row RLS GUC stays bound to this
		// caller's tenant_id — see Repo.sparklinesCached.
		spark, err := r.sparklinesCached(ctx, tenantID, days, func(loaderCtx context.Context) (map[string][]int, error) {
			return dashboardSparklinesTx(loaderCtx, tx, tenantID, days)
		})
		if err != nil {
			return nil, err
		}
		out.Sparklines = spark
		bouncesAnom := detectAnomalySimple(spark["bounces"], 2.5)
		out.Anomalies = map[string]bool{"bounces": bouncesAnom}

		// Refined Dashboard PR 3: persist the spike so the
		// AnomalyHistoryCard + desktop notifications can read it.
		// Best-effort — failure does NOT break the stats response.
		if bouncesAnom {
			bouncesSeries := spark["bounces"]
			today := time.Now().UTC().Truncate(24 * time.Hour)
			tail := bouncesSeries[len(bouncesSeries)-1]
			prior := bouncesSeries[:len(bouncesSeries)-1]
			var sum, sumSq float64
			for _, v := range prior {
				sum += float64(v)
				sumSq += float64(v) * float64(v)
			}
			n := float64(len(prior))
			mean := sum / n
			variance := (sumSq / n) - (mean * mean)
			var z float64
			if variance > 0 {
				z = (float64(tail) - mean) / math.Sqrt(variance)
			}
			// Use a separate non-tx insert so the read tx stays read-only.
			// We swallow the error: the chip still renders even if the
			// persistence write fails (cache will retry next refresh).
			_ = r.RecordAnomaly(ctx, tenantID, "bounces", rangeLabel, today, tail, mean, z)
		}
	}

	return out, tx.Commit(ctx)
}

func dashboardInboxHealthState(score int) string {
	switch {
	case score >= 90:
		return "Healthy"
	case score >= 75:
		return "Good"
	case score >= 60:
		return "Watch"
	case score >= 40:
		return "Degraded"
	default:
		return "Critical"
	}
}

// dashboardSubscriberSparklineSQL and dashboardEventSparklineSQL are named so
// their shape can be asserted without a database: the property that matters —
// the window predicate sits in a WHERE on the partitioned/indexed source table,
// not in a LEFT JOIN condition against a generated series — is a property of
// the SQL text, and it is exactly the property that silently regressed before.
const dashboardSubscriberSparklineSQL = `
WITH bucket AS (
    SELECT date_trunc('day', created_at) AS day, count(*)::int AS n
      FROM subscribers
     WHERE tenant_id = $1::uuid
       AND created_at >= date_trunc('day', now() - $2::interval)
       AND created_at <  date_trunc('day', now()) + interval '1 day'
     GROUP BY 1
)
SELECT COALESCE(bucket.n, 0)::int AS n
FROM generate_series(date_trunc('day', now() - $2::interval),
                     date_trunc('day', now()),
                     '1 day') AS series(day) -- a bare AS day is ambiguous with bucket.day
LEFT JOIN bucket ON bucket.day = series.day
ORDER BY series.day ASC`

const dashboardEventSparklineSQL = `
WITH bucket AS (
    SELECT date_trunc('day', at) AS day,
           count(*) FILTER (WHERE event_type = 'opened')::int  AS opens,
           count(*) FILTER (WHERE event_type = 'clicked')::int AS clicks,
           count(*) FILTER (WHERE event_type = 'bounced')::int AS bounces
      FROM campaign_report_events
     WHERE tenant_id = $1::uuid
       AND at >= date_trunc('day', now() - $2::interval)
       AND at <  date_trunc('day', now()) + interval '1 day'
       AND event_type IN ('opened', 'clicked', 'bounced')
     GROUP BY 1
)
SELECT COALESCE(bucket.opens, 0)::int,
       COALESCE(bucket.clicks, 0)::int,
       COALESCE(bucket.bounces, 0)::int
FROM generate_series(date_trunc('day', now() - $2::interval),
                     date_trunc('day', now()),
                     '1 day') AS series(day) -- a bare AS day is ambiguous with bucket.day
LEFT JOIN bucket ON bucket.day = series.day
ORDER BY series.day ASC`

// dashboardSparklinesTx returns daily-bucketed counts (length =
// `days`) for the four PR-1 metrics: subscribers (new opt-ins),
// opens, clicks, bounces. Zero-event days are filled via
// generate_series + LEFT JOIN so the result is exactly `days` entries.
//
// The window predicate lives in a WHERE on the source table, inside a bounded
// CTE, and the generate_series is LEFT JOINed to that pre-aggregate.
//
// The previous shape put the only `at` bound inside the LEFT JOIN condition
// against a runtime-generated series and had no WHERE on `e` at all.
// campaign_report_events is PARTITION BY RANGE (at) (migration 0339) with
// monthly partitions plus a `-infinity` legacy partition, and a join condition
// gives the planner no plan-time or scan-level range to prune on — so every
// partition, i.e. all history, was fed into the join, three times over (opens,
// clicks, bounces), on every dashboard load and every SSE tick. The comment
// there claimed the half-open form made this "index-friendly" and cited a
// (tenant_id, at) index that did not exist; the index is added by migration
// 1991 and the claim is not repeated here.
//
// The three event series are also collapsed into ONE query with count FILTER
// per event type — the same idiom the headline aggregate uses. They read the
// same table over the same window and differed only in the bound event_type,
// so running them serially cost three scans and three network round-trips for
// one scan's worth of data.
func dashboardSparklinesTx(ctx context.Context, tx pgx.Tx, tenantID string, days int) (map[string][]int, error) {
	out := map[string][]int{}
	intervalArg := fmt.Sprintf("%d days", days-1) // generate_series is inclusive on both ends → days entries

	// Subscribers (new opt-ins per day). Same rewrite: the range predicate is
	// a WHERE on subscribers, not a join condition, so the
	// (tenant_id, created_at) index can serve it.
	subs, err := bucketCounts(ctx, tx, dashboardSubscriberSparklineSQL, tenantID, intervalArg)
	if err != nil {
		return nil, err
	}
	out["subscribers"] = subs

	rows, err := tx.Query(ctx, dashboardEventSparklineSQL, tenantID, intervalArg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	opens, clicks, bounces := []int{}, []int{}, []int{}
	for rows.Next() {
		var o, c, b int
		if err := rows.Scan(&o, &c, &b); err != nil {
			return nil, err
		}
		opens = append(opens, o)
		clicks = append(clicks, c)
		bounces = append(bounces, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out["opens"] = opens
	out["clicks"] = clicks
	out["bounces"] = bounces
	return out, nil
}

// sparklinesCached returns the sparkline payload for (tenantID, days)
// from the per-Repo cache when a fresh entry exists, otherwise hits
// `loader` (which actually runs the queries) under a singleflight so
// concurrent SSE polls collapse to one DB round-trip.
//
// p4c-dashboard-sparkline-sargable: DashboardLive polls
// DashboardStats every 2s; with the SSE stream open in ~5 tabs per
// tenant that's 300 sparkline-scan bursts/min. Without coalescing
// the rewritten queries are still cheap, but stacking 5 of them at
// the same tick is gratuitous. 2s TTL is intentionally aligned with
// the poll cadence so the worst-case staleness equals one tick.
//
// Cache hits return the (immutable) map directly — callers MUST NOT
// mutate the returned slices. detectAnomalySimple + the downstream
// JSON encoder are both read-only over the result so this contract
// holds today; tighten it (return a deep copy) if a future caller
// starts editing.
func (r *Repo) sparklinesCached(
	ctx context.Context,
	tenantID string,
	days int,
	loader func(context.Context) (map[string][]int, error),
) (map[string][]int, error) {
	key := fmt.Sprintf("%s|%d", tenantID, days)

	// Fast path: serve from cache if still fresh.
	r.sparkCacheMu.Lock()
	if r.sparkCache != nil {
		if entry, ok := r.sparkCache[key]; ok && time.Now().Before(entry.expiry) {
			r.sparkCacheMu.Unlock()
			return entry.val, nil
		}
	}
	r.sparkCacheMu.Unlock()

	// Slow path: collapse concurrent rebuilds through singleflight so
	// 5 SSE tabs all polling within the same 2s window result in one
	// DB query.
	v, err, _ := r.sparkGroup.Do(key, func() (any, error) {
		// Re-check cache inside the singleflight winner — a prior
		// caller may have populated it while we were queued.
		r.sparkCacheMu.Lock()
		if r.sparkCache != nil {
			if entry, ok := r.sparkCache[key]; ok && time.Now().Before(entry.expiry) {
				r.sparkCacheMu.Unlock()
				return entry.val, nil
			}
		}
		r.sparkCacheMu.Unlock()

		got, err := loader(ctx)
		if err != nil {
			return nil, err
		}
		r.sparkCacheMu.Lock()
		if r.sparkCache == nil {
			r.sparkCache = make(map[string]sparklineCacheEntry, 4)
		}
		r.sparkCache[key] = sparklineCacheEntry{
			val:    got,
			expiry: time.Now().Add(sparklineCacheTTL),
		}
		r.sparkCacheMu.Unlock()
		return got, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(map[string][]int), nil
}

func bucketCounts(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]int, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int{}
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// detectAnomalySimple returns true when the last value in `values` is
// more than `threshold` standard deviations above the mean of the
// preceding values. Returns false on slices shorter than 4 (need a
// trailing window of at least 3 for the mean to be meaningful) and
// when variance is 0 (a flat series can't be "anomalous").
//
// Calibrated for production-shaped event data: threshold of 2.5
// flags genuine spikes without firing on normal-day-to-day jitter.
func detectAnomalySimple(values []int, threshold float64) bool {
	if len(values) < 4 {
		return false
	}
	prior := values[:len(values)-1]
	var sum, sumSq float64
	for _, v := range prior {
		f := float64(v)
		sum += f
		sumSq += f * f
	}
	n := float64(len(prior))
	mean := sum / n
	variance := (sumSq / n) - (mean * mean)
	if variance <= 0 {
		return false
	}
	std := math.Sqrt(variance)
	z := (float64(values[len(values)-1]) - mean) / std
	return z > threshold
}

// rangeDays maps a range label to its day count. Unknown labels
// default to 30 (the historical behavior).
func rangeDays(label string) int {
	switch label {
	case "7d":
		return 7
	case "90d":
		return 90
	default:
		return 30
	}
}

// rangeLabel normalises the raw query-param value into one of
// "7d"|"30d"|"90d". Anything unknown becomes "30d".
func rangeLabel(label string) string {
	switch label {
	case "7d", "30d", "90d":
		return label
	default:
		return "30d"
	}
}

// SequenceFunnel aggregates sequence_funnel_events into the per-step
// funnel report. Single GROUP-BY query keeps it cheap; the table's
// (tenant, sequence, position) index serves the filter.
//
// A22 (desktop audit 2026-06-10): rows are keyed by (position,
// step_id) rather than position alone so branch steps — which share a
// position number across condition branches — come back as distinct
// funnel rows. Legacy rows (NULL step_id, written before migration
// 0367) collapse into one row per position exactly as before, and
// their step_id is omitted from the JSON, so the response is fully
// backward compatible.
//
// PRODUCER STATUS (A22 follow-up, verified 2026-06-10): NO code in
// this repository writes sequence_funnel_events — not apps/api, not
// services/voice (read-only: the participants projection in
// services/voice/internal/storage/participants.go), and not
// services/automation (its runtime has no sequence/funnel concept at
// all). The producers named in migration 0052 (automation runtime /
// voice sequence dispatcher V2) live outside this repo on the engine
// side; until they ship step_id, every row arrives with NULL step_id
// and this endpoint serves the legacy one-row-per-position shape. The
// step_id contract producers must follow is documented in migration
// 0367 and apps/desktop/src/components/sequence/funnel-metrics.ts
// ("pN" for top-level steps, "pN:yes:pM" / "pN:no:pM" for branch
// steps, deeper nesting prepends segments).
func (r *Repo) SequenceFunnel(ctx context.Context, tenantID, sequenceID string) (*SequenceFunnel, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT position,
       COALESCE(step_id, '') AS step_id,
       count(*)::int AS reached,
       count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
       count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
  FROM sequence_funnel_events
 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid
 GROUP BY position, step_id
 ORDER BY position ASC, step_id ASC`, tenantID, sequenceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	raw := []FunnelStep{}
	for rows.Next() {
		var s FunnelStep
		if err := rows.Scan(&s.Position, &s.StepID, &s.Reached, &s.Opened, &s.Clicked); err != nil {
			return nil, err
		}
		raw = append(raw, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	steps := assembleFunnelSteps(raw)

	// Per-variant breakdown. Read the sequence's step definitions to find
	// which positions carry an A/B split; only those positions trigger
	// the (more expensive) per-row variant pass. A sequence with no
	// variants on any step does ZERO extra work here — the legacy shape
	// is returned untouched.
	stepVariants, err := readStepVariants(ctx, tx, tenantID, sequenceID)
	if err != nil {
		return nil, err
	}
	if len(stepVariants) > 0 {
		if err := r.attachVariantBreakdowns(ctx, tx, tenantID, sequenceID, steps, stepVariants); err != nil {
			return nil, err
		}
	}

	out := &SequenceFunnel{SequenceID: sequenceID, Steps: steps}
	return out, tx.Commit(ctx)
}

// readStepVariants reads voice_sequences.steps (jsonb) for the sequence
// and returns the A/B variant lists keyed by the funnel step_id of the
// TOP-LEVEL email step they belong to ("p<position>", matching the
// desktop's funnel-metrics.ts encoding and the variant-resolution
// endpoint in services/voice/internal/handlers/variant_assignment.go).
//
// Only top-level email steps are considered: branch-step variants have
// no flat position identity on the wire (the variant endpoint refuses
// them too), so the funnel cannot attribute their arms. Steps with fewer
// than 2 variants, or whose weights don't sum to 10000, are skipped —
// they can't form a valid split, so we don't fabricate a breakdown.
//
// Returns an empty (nil) map when the sequence has no steps column, no
// email steps with variants, or the row is absent — every such case
// means "no per-variant breakdown", handled by the caller as a no-op.
func readStepVariants(ctx context.Context, tx pgx.Tx, tenantID, sequenceID string) (map[string][]FunnelVariant, error) {
	var stepsRaw []byte
	err := tx.QueryRow(ctx, `
SELECT steps
  FROM voice_sequences
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, sequenceID).Scan(&stepsRaw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return parseStepVariants(stepsRaw), nil
}

// stepVariantWire mirrors the minimal subset of the voice service's
// generation.Step / EmailConfig / EmailVariant JSON we need to recover an
// A/B split. We deliberately decode only (type, position, email.variants)
// so this stays decoupled from the full step schema.
type stepVariantWire struct {
	Type     string `json:"type"`
	Position int    `json:"position"`
	Email    *struct {
		Variants []struct {
			Key      string `json:"key"`
			WeightBP int    `json:"weight_bp"`
		} `json:"variants"`
	} `json:"email"`
}

// parseStepVariants decodes the steps jsonb into a map of funnel step_id
// ("p<position>") -> variant list for every top-level email step that
// carries a valid (2..4, weights summing to 10000) split. Pure so it is
// unit-testable without a DB.
func parseStepVariants(stepsRaw []byte) map[string][]FunnelVariant {
	stepsRaw = bytesTrimSpace(stepsRaw)
	if len(stepsRaw) == 0 {
		return nil
	}
	var steps []stepVariantWire
	if err := json.Unmarshal(stepsRaw, &steps); err != nil {
		return nil
	}
	out := map[string][]FunnelVariant{}
	for _, s := range steps {
		if s.Type != "email" || s.Email == nil || len(s.Email.Variants) < 2 {
			continue
		}
		vs := make([]FunnelVariant, 0, len(s.Email.Variants))
		sum := 0
		valid := true
		for _, v := range s.Email.Variants {
			if v.WeightBP < 1 || strings.TrimSpace(v.Key) == "" {
				valid = false
				break
			}
			vs = append(vs, FunnelVariant{Key: v.Key, WeightBP: v.WeightBP})
			sum += v.WeightBP
		}
		if !valid || sum != variantWeightTotalBP {
			continue
		}
		out[fmt.Sprintf("p%d", s.Position)] = vs
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// attachVariantBreakdowns runs one per-row scan over the variant-carrying
// positions and fills FunnelStep.Variants. It scans only the rows whose
// (position, step_id) maps to a known variant list, so a sequence with a
// single A/B step doesn't pay for a full per-subscriber scan of the rest.
//
// For each row the arm is resolved by PREFERRING a stamped
// sequence_funnel_events.variant_key (the producer is authoritative —
// e.g. after a mid-flight weight change), and FALLING BACK to recomputing
// assignVariantKey when the column is NULL/blank. Recompute uses the flat
// 1-based position: derived from the row's step_id ("pN" -> N) when
// present, else position+1 (funnel positions are 0-indexed per migration
// 0052; the variant hash + the variant endpoint use the 1-based flat
// position).
func (r *Repo) attachVariantBreakdowns(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, sequenceID string,
	steps []FunnelStep,
	stepVariants map[string][]FunnelVariant,
) error {
	// Bail before any DB work when no funnel step matches a variant-
	// carrying position — a sequence whose A/B steps have no funnel rows
	// yet pays nothing here.
	if !anyStepHasVariants(steps, stepVariants) {
		return nil
	}

	rows, err := tx.Query(ctx, `
SELECT position,
       COALESCE(step_id, '')        AS step_id,
       subscriber_email::text       AS email,
       COALESCE(variant_key, '')    AS variant_key,
       (opened_at  IS NOT NULL)     AS opened,
       (clicked_at IS NOT NULL)     AS clicked
  FROM sequence_funnel_events
 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid`, tenantID, sequenceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	events := []funnelVariantRow{}
	for rows.Next() {
		var row funnelVariantRow
		if err := rows.Scan(&row.position, &row.stepID, &row.email, &row.stampedKey, &row.opened, &row.clicked); err != nil {
			return err
		}
		events = append(events, row)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	computeVariantBreakdowns(sequenceID, steps, stepVariants, events)
	return nil
}

// funnelVariantRow is one raw sequence_funnel_events row projected for the
// per-variant pass. Decoupled from pgx so computeVariantBreakdowns is
// unit-testable with literal rows.
type funnelVariantRow struct {
	position   int
	stepID     string
	email      string
	stampedKey string
	opened     bool
	clicked    bool
}

// anyStepHasVariants reports whether at least one funnel step maps to a
// variant-carrying position. Cheap pre-check that skips the per-row scan
// entirely for the common no-A/B-test funnel.
func anyStepHasVariants(steps []FunnelStep, stepVariants map[string][]FunnelVariant) bool {
	for i := range steps {
		if _, ok := stepVariants[funnelStepID(steps[i].Position, steps[i].StepID)]; ok {
			return true
		}
	}
	return false
}

// computeVariantBreakdowns is the pure per-variant aggregation: it groups
// the raw funnel rows by (position, step_id), resolves each row's arm
// (stamped variant_key preferred, else recomputed deterministically), and
// fills FunnelStep.Variants in the variant's stored order. Rows whose
// (position, step_id) has no configured split are ignored; rows whose arm
// can't be resolved (malformed split) are dropped from the breakdown.
//
// The per-arm Reached/Opened/Clicked sum to the step's totals whenever
// every reached subscriber resolves to an arm — which holds for a valid
// split, since assignVariantKey always lands a bucket in [0,10000) inside
// the cumulative weights.
func computeVariantBreakdowns(
	sequenceID string,
	steps []FunnelStep,
	stepVariants map[string][]FunnelVariant,
	events []funnelVariantRow,
) {
	type stepKey struct {
		position int
		stepID   string
	}
	// counts[stepKey][variantKey] = [reached, opened, clicked]
	counts := map[stepKey]map[string]*[3]int{}
	variantsFor := map[stepKey][]FunnelVariant{}
	for i := range steps {
		vs, ok := stepVariants[funnelStepID(steps[i].Position, steps[i].StepID)]
		if !ok {
			continue
		}
		sk := stepKey{position: steps[i].Position, stepID: steps[i].StepID}
		variantsFor[sk] = vs
		counts[sk] = map[string]*[3]int{}
	}
	if len(variantsFor) == 0 {
		return
	}

	for _, row := range events {
		sk := stepKey{position: row.position, stepID: row.stepID}
		vs, ok := variantsFor[sk]
		if !ok {
			continue // position has no A/B split — not part of the breakdown
		}
		arm := strings.TrimSpace(row.stampedKey)
		if arm == "" {
			arm = assignVariantKey(sequenceID, recomputePosition(row.position, row.stepID), row.email, vs)
		}
		if arm == "" {
			continue // malformed split / unresolvable — leave it out
		}
		acc := counts[sk][arm]
		if acc == nil {
			acc = &[3]int{}
			counts[sk][arm] = acc
		}
		acc[0]++
		if row.opened {
			acc[1]++
		}
		if row.clicked {
			acc[2]++
		}
	}

	// Emit per-arm rows in the variant's stored order so "A" precedes "B"
	// deterministically, regardless of which arm got more subscribers.
	for i := range steps {
		sk := stepKey{position: steps[i].Position, stepID: steps[i].StepID}
		vs, ok := variantsFor[sk]
		if !ok {
			continue
		}
		armCounts := counts[sk]
		breakdown := make([]FunnelVariantBreakdown, 0, len(vs))
		for _, v := range vs {
			b := FunnelVariantBreakdown{VariantKey: v.Key}
			if c := armCounts[v.Key]; c != nil {
				b.Reached = c[0]
				b.Opened = c[1]
				b.Clicked = c[2]
				if b.Reached > 0 {
					b.OpenRate = pct(b.Opened, b.Reached)
					b.ClickRate = pct(b.Clicked, b.Reached)
				}
			}
			breakdown = append(breakdown, b)
		}
		steps[i].Variants = breakdown
	}
}

// funnelStepID returns the step_id used to look up a step's variant list:
// the stamped step_id when present, else the legacy "p<position>" form a
// top-level step would carry. Mirrors the desktop's
// topLevelFunnelStepId so a producer that omits step_id (NULL rows) still
// matches a top-level step's variants.
func funnelStepID(position int, stepID string) string {
	if s := strings.TrimSpace(stepID); s != "" {
		return s
	}
	// Legacy NULL-step rows carry a 0-indexed `position` (migration 0052),
	// but variant lists are keyed by the 1-based flat position — so the
	// legacy "pN" lookup key must add 1, mirroring recomputePosition, or
	// every legacy variant lookup misses by one step (D07#5).
	return fmt.Sprintf("p%d", position+1)
}

// recomputePosition derives the flat 1-based position to feed
// assignVariantKey for a funnel row. When the row carries a step_id of
// the top-level form "pN", N is authoritative (it is exactly what the
// dispatcher resolves the arm against). Otherwise the row is a legacy
// NULL-step_id row whose `position` is 0-indexed (migration 0052), so we
// add 1 to recover the 1-based position the variant hash expects.
func recomputePosition(position int, stepID string) int {
	if n, ok := topLevelStepPosition(stepID); ok {
		return n
	}
	return position + 1
}

// topLevelStepPosition parses a top-level funnel step_id ("p3" -> 3,
// true). Branch step_ids (containing ':') and malformed values return
// (0, false) — variants are only resolvable for top-level steps.
func topLevelStepPosition(stepID string) (int, bool) {
	s := strings.TrimSpace(stepID)
	if len(s) < 2 || s[0] != 'p' || strings.Contains(s, ":") {
		return 0, false
	}
	n, err := strconv.Atoi(s[1:])
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// bytesTrimSpace trims leading/trailing ASCII whitespace from a byte
// slice without allocating (used to cheaply detect an empty/blank jsonb).
func bytesTrimSpace(b []byte) []byte {
	start, end := 0, len(b)
	for start < end {
		switch b[start] {
		case ' ', '\t', '\n', '\r':
			start++
			continue
		}
		break
	}
	for end > start {
		switch b[end-1] {
		case ' ', '\t', '\n', '\r':
			end--
			continue
		}
		break
	}
	return b[start:end]
}

// assembleFunnelSteps fills the derived fields (open/click rates +
// dropoff) on the raw (position, step_id, counts) rows. Pure function
// so the branch-aware dropoff math is unit-testable without a DB.
//
// Dropoff is position-level: subscribers reaching position P are the
// SUM over all branch rows at P, compared with the sum at the previous
// distinct position. Every row at P carries the same dropoff value;
// for the legacy one-row-per-position shape this reduces exactly to
// the old per-row behavior.
func assembleFunnelSteps(raw []FunnelStep) []FunnelStep {
	steps := make([]FunnelStep, 0, len(raw))
	// Per-position reach totals, in first-seen (ascending) order.
	totals := map[int]int{}
	order := []int{}
	for _, s := range raw {
		if _, seen := totals[s.Position]; !seen {
			order = append(order, s.Position)
		}
		totals[s.Position] += s.Reached
	}
	dropoff := map[int]float64{}
	prevTotal := 0
	for _, p := range order {
		cur := totals[p]
		if prevTotal > 0 && cur < prevTotal {
			dropoff[p] = pct(prevTotal-cur, prevTotal)
		}
		prevTotal = cur
	}
	for _, s := range raw {
		if s.Reached > 0 {
			s.OpenRate = pct(s.Opened, s.Reached)
			s.ClickRate = pct(s.Clicked, s.Reached)
		}
		s.DropoffPct = dropoff[s.Position]
		steps = append(steps, s)
	}
	return steps
}

func pct(num, denom int) float64 {
	if denom <= 0 {
		return 0
	}
	return float64(num) / float64(denom) * 100.0
}

// ----------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------

// Deps bundles dependencies for handler wiring.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// CampaignReport GET /api/v1/campaigns/{id}/report
func (d *Deps) CampaignReport(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "campaign id required"))
		return
	}
	rep, err := d.Repo.CampaignReport(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no events for this campaign"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// SequenceFunnel GET /api/v1/voice/sequences/{id}/funnel
//
// Per-position cohort breakdown: who reached email N, who opened,
// who clicked, drop-off vs the previous step. Reads sequence_funnel_events.
func (d *Deps) SequenceFunnel(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "sequence id required"))
		return
	}
	out, err := d.Repo.SequenceFunnel(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DashboardStats GET /api/v1/dashboard/stats
//
// Query params (all optional, Refined Dashboard PR 1):
//
//	?range=7d|30d|90d   (default 30d)
//	?compare=true|false (default true)
//	?sparklines=true|false (default true)
//
// Defaults to "rich" mode (compare + sparklines on) so the new
// dashboard renders fully on the first request without coordination.
// Callers wanting the legacy lean payload can pass ?compare=false&sparklines=false.
func (d *Deps) DashboardStats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "analytics repository is not configured"))
		return
	}
	q := r.URL.Query()
	opts := DashboardStatsOptions{
		Range:      rangeLabel(q.Get("range")),
		Compare:    q.Get("compare") != "false",
		Sparklines: q.Get("sparklines") != "false",
	}
	stats, err := d.Repo.DashboardStatsWithOptions(r.Context(), t.ID, opts)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// LinkRow is one row of the per-link click report.
type LinkRow struct {
	URL            string  `json:"url"`
	Clicks         int     `json:"clicks"`
	UniqueClickers int     `json:"unique_clickers"`
	CTR            float64 `json:"ctr"`
}

// CompareRow is one campaign in the side-by-side comparison.
type CompareRow struct {
	CampaignID      string  `json:"campaign_id"`
	TotalRecipients int     `json:"total_recipients"`
	OpenRate        float64 `json:"open_rate"`
	ClickRate       float64 `json:"click_rate"`
	BounceRate      float64 `json:"bounce_rate"`
	ComplaintRate   float64 `json:"complaint_rate"`
	UnsubRate       float64 `json:"unsub_rate"`
}

// GeographyRow is one country's open/click totals for a campaign.
type GeographyRow struct {
	Country string `json:"country"`
	Opens   int    `json:"opens"`
	Clicks  int    `json:"clicks"`
}

// DeviceRow is one mail-client family's open/click totals.
type DeviceRow struct {
	Client string `json:"client"`
	Opens  int    `json:"opens"`
	Clicks int    `json:"clicks"`
}

// BounceCounts is the categorized bounce summary for a campaign.
type BounceCounts struct {
	Hard     int `json:"hard"`
	Soft     int `json:"soft"`
	SpamTrap int `json:"spam_trap"`
	Total    int `json:"total"`
}

// CohortRow is one cohort (signup month) in the cohort matrix.
type CohortRow struct {
	CohortLabel string    `json:"cohort_label"`
	CohortSize  int       `json:"cohort_size"`
	Weeks       []float64 `json:"weeks"`
}

// CohortFunnelRow is one cohort (signup-month bucket) in the subscriber
// cohort funnel (SUB-128): signup → first-purchase → repeat-purchase. The
// *_rate fields are conversion percentages (0..100) relative to the prior
// stage, computed via pct() so they degrade to 0 for empty cohorts.
type CohortFunnelRow struct {
	CohortLabel         string  `json:"cohort_label"`
	SignupCount         int     `json:"signup_count"`
	FirstPurchaseCount  int     `json:"first_purchase_count"`
	RepeatPurchaseCount int     `json:"repeat_purchase_count"`
	FirstPurchaseRate   float64 `json:"first_purchase_rate"`
	RepeatPurchaseRate  float64 `json:"repeat_purchase_rate"`
}

// SubscriberFunnelStep is one labeled stage in the aggregate (all-cohort)
// subscriber funnel: a stable display label plus the total count of
// subscribers that reached the stage and the conversion rate (0..100) from
// the previous stage.
type SubscriberFunnelStep struct {
	Stage          string  `json:"stage"`
	Label          string  `json:"label"`
	Count          int     `json:"count"`
	ConversionRate float64 `json:"conversion_rate"`
}

// SubscriberFunnel is the full subscriber cohort-funnel payload (SUB-128):
// the aggregate stage roll-up plus the per-cohort breakdown.
type SubscriberFunnel struct {
	Bucket   string                 `json:"bucket"`
	CohortBy string                 `json:"cohort_by"`
	Steps    []SubscriberFunnelStep `json:"steps"`
	Cohorts  []CohortFunnelRow      `json:"cohorts"`
}

// RevenueReport is the per-campaign revenue attribution result.
type RevenueReport struct {
	AttributedRevenueCents int64  `json:"attributed_revenue_cents"`
	Currency               string `json:"currency"`
	Conversions            int    `json:"conversions"`
	AttributionWindowDays  int    `json:"attribution_window_days"`
	Note                   string `json:"note,omitempty"`
}

// CSVReportRow is one subscriber's lifecycle row in the CSV export.
type CSVReportRow struct {
	SubscriberEmail string
	SentAt          time.Time
	DeliveredAt     time.Time
	OpenedAt        time.Time
	FirstClickAt    time.Time
	ClickCount      int
	BouncedAt       time.Time
	ComplainedAt    time.Time
	UnsubscribedAt  time.Time
}
