// SPDX-License-Identifier: AGPL-3.0-only
//
// Package prioritization implements workspace-level Message
// Prioritization across overlapping campaigns. Modelled after Braze's
// Message Prioritization: when a subscriber is eligible for multiple
// sends inside the same frequency-cap window, the highest-priority
// campaign wins and the lower-priority sends get filtered out at
// queue-fill time.
//
// Surface:
//
//	prioritization.FilterAudience(ctx, pool, tenantID, campaignID, candidates)
//	    -> kept, skipped, breakdown
//
// Wiring lives in apps/api/internal/campaigns/handlers_queue.go via
// the existing FrequencyFilter slot (closure adapter in main.go).
// This package deliberately does NOT depend on the campaigns package
// so the import graph stays a DAG (campaigns → prioritization via the
// closure-adapter pattern, never the other direction).
//
// Algorithm:
//
//  1. Read the dispatching campaign's priority. Transactional-level
//     sends (priority >= PriorityTransactional) always pass through
//     — they bypass collision resolution entirely. This matches
//     Braze's "transactional always wins" semantics and the audit
//     sketch's default-of-10-for-system-mails.
//
//  2. For non-transactional sends, look up subscriber_send_log to
//     find, for each candidate email, the highest priority of any
//     send that has already gone out to them inside the active
//     frequency window (the longest window across all
//     frequency_cap_rules for the tenant, falling back to 24h when no
//     rules are configured).
//
//  3. Drop any candidate whose log shows an earlier higher-priority
//     send within the window — the cap is "deemed at risk of being
//     breached" and the lower-priority promo defers. Equal-priority
//     ties resolve in FAVOR of the new send (the frequency_cap_rules
//     filter is the next gate; if it doesn't trip, the send proceeds).
//
// The breakdown is a single-row counter at this layer (rule-id
// "priority", label "Message Prioritization") so the existing
// FrequencySkipBreakdown UI surfaces the skip count without a new
// shape.
package prioritization

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// PriorityTransactional duplicates campaigns.PriorityTransactional so
// this package doesn't import campaigns (which would create an import
// cycle once campaigns starts calling into here via the FrequencyFilter
// adapter). The two MUST move together — see campaigns/types.go.
const PriorityTransactional = 10

// DefaultWindowHours is the fallback collision window when the tenant
// has no frequency_cap_rules configured. 24h matches the "max sends
// per day" mental model of every product in this space.
const DefaultWindowHours = 24

// MaxWindowHours bounds the lookup window so a misconfigured rule
// (e.g. window_hours = 720 = 30 days) doesn't trigger a full table
// scan on subscriber_send_log for a 100k-recipient send. 7 days is
// a safe upper bound for collision-resolution semantics — anyone
// trying to deduplicate across longer windows should be using the
// frequency-cap filter, not prioritization.
const MaxWindowHours = 168

// SkipResult mirrors frequency.FilterResult so the campaigns package's
// existing FrequencyFilter signature can be reused without a second
// adapter type.
type SkipResult struct {
	Kept    []string
	Skipped int
	// HigherPrioritySends is the count of distinct emails that had a
	// higher-priority send earlier in the window. Equals Skipped in
	// the common path but exposed separately so observability can
	// distinguish "lost a collision" from "data unavailable".
	HigherPrioritySends int
}

// recipientsSkippedByPriorityTotal counts every email dropped by the
// prioritizer, labelled by the campaign's priority bucket. Cardinality
// is bounded (10 buckets); a separate "transactional_passthrough"
// counter records the bypass path so the no-op case is observable.
var recipientsSkippedByPriorityTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "postwave_recipients_skipped_by_priority_total",
	Help: "Total emails dropped at queue-fill by Message Prioritization, labelled by the dispatching campaign's priority bucket.",
}, []string{"priority"})

// transactionalPassthroughTotal increments once per FilterAudience
// call that short-circuits because the campaign is at the
// transactional priority floor. Lets ops verify high-priority sends
// are actually bypassing collision resolution.
var transactionalPassthroughTotal = promauto.NewCounter(prometheus.CounterOpts{
	Name: "postwave_prioritization_transactional_passthrough_total",
	Help: "Total prioritization FilterAudience calls that short-circuited because the campaign's priority is at or above the transactional floor.",
})

// FilterAudience drops candidates whose subscriber_send_log shows a
// higher-priority send in the active window. Best-effort: lookup
// failures return the candidate set untouched so a DB hiccup doesn't
// drop a campaign — the per-row frequency-cap filter is the next gate
// and will catch any actual breach.
func FilterAudience(
	ctx context.Context,
	pool *db.Pool,
	tenantID, campaignID string,
	candidates []string,
) (SkipResult, error) {
	if pool == nil || len(candidates) == 0 {
		return SkipResult{Kept: candidates}, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		// Bias toward delivering — see package doc, point 3.
		return SkipResult{Kept: candidates}, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()

	myPriority, err := lookupCampaignPriority(ctx, tx, tenantID, campaignID)
	if err != nil {
		return SkipResult{Kept: candidates}, nil
	}
	// Transactional bypass: priority >= 10 always wins, no collision
	// check needed. Counter ticks so operators can see this happened.
	if myPriority >= PriorityTransactional {
		transactionalPassthroughTotal.Inc()
		return SkipResult{Kept: candidates}, nil
	}

	windowHours := resolveCollisionWindow(ctx, tx, tenantID)
	since := time.Now().UTC().Add(-time.Duration(windowHours) * time.Hour)

	// One query lists every (email, max_other_priority) tuple inside
	// the window. We compare per email and drop the candidate when
	// max_other_priority > myPriority.
	rows, err := tx.Query(ctx, `
SELECT lower(ssl.subscriber_email)::text,
       COALESCE(MAX(c.priority), 0)::int
  FROM subscriber_send_log ssl
  JOIN campaigns c ON c.id = ssl.campaign_id
 WHERE ssl.tenant_id = $1::uuid
   AND ssl.sent_at >= $2
   AND ssl.campaign_id <> $3::uuid
   AND lower(ssl.subscriber_email) = ANY($4::text[])
 GROUP BY lower(ssl.subscriber_email)`,
		tenantID, since, campaignID, lowercaseAll(candidates))
	if err != nil {
		return SkipResult{Kept: candidates}, nil
	}
	loserSet := map[string]struct{}{}
	for rows.Next() {
		var email string
		var maxOther int
		if err := rows.Scan(&email, &maxOther); err != nil {
			rows.Close()
			return SkipResult{Kept: candidates}, nil
		}
		if maxOther > myPriority {
			loserSet[email] = struct{}{}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return SkipResult{Kept: candidates}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return SkipResult{Kept: candidates}, nil
	}

	if len(loserSet) == 0 {
		return SkipResult{Kept: candidates}, nil
	}
	kept := make([]string, 0, len(candidates)-len(loserSet))
	for _, e := range candidates {
		if _, hit := loserSet[strings.ToLower(e)]; hit {
			continue
		}
		kept = append(kept, e)
	}
	recipientsSkippedByPriorityTotal.WithLabelValues(itoaPriority(myPriority)).Add(float64(len(loserSet)))
	return SkipResult{
		Kept:                kept,
		Skipped:             len(loserSet),
		HigherPrioritySends: len(loserSet),
	}, nil
}

// lookupCampaignPriority reads campaigns.priority for the dispatching
// campaign. Returns the DEFAULT (5) on missing column / row so an old
// snapshot pre-0298 still functions (the column is non-null with a
// DEFAULT after the migration, but rows visible inside a transaction
// that started before the migration applied COULD theoretically see
// a NULL — defensive coding).
func lookupCampaignPriority(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) (int, error) {
	var p *int
	if err := tx.QueryRow(ctx, `
SELECT priority::int FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, campaignID).Scan(&p); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, errors.New("prioritization: campaign not found")
		}
		return 0, err
	}
	if p == nil {
		return 5, nil
	}
	return *p, nil
}

// resolveCollisionWindow picks the longest active frequency-cap
// window for the tenant, clamped to MaxWindowHours, falling back to
// DefaultWindowHours when no rules exist. The "longest active rule"
// is the right answer because that's the window any subsequent
// frequency-cap gate would evaluate against — prioritization wants
// to defer ANY send that would have collided with a higher-priority
// peer inside the cap's reach.
func resolveCollisionWindow(ctx context.Context, tx pgx.Tx, tenantID string) int {
	var w *int
	_ = tx.QueryRow(ctx, `
SELECT MAX(window_hours)::int FROM frequency_cap_rules
 WHERE tenant_id = $1::uuid AND active`, tenantID).Scan(&w)
	if w == nil || *w <= 0 {
		return DefaultWindowHours
	}
	if *w > MaxWindowHours {
		return MaxWindowHours
	}
	return *w
}

// lowercaseAll returns a new slice with every entry lower-cased so
// the ANY() match against the citext column lines up on case. Pure;
// caller's slice is not mutated.
func lowercaseAll(xs []string) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = strings.ToLower(x)
	}
	return out
}

// itoaPriority renders a priority int into a stable Prometheus label.
// We pad to two digits so the alphabetical sort that grafana applies
// to label values matches the numeric ordering ("01".."10"). Returns
// "unknown" for out-of-range inputs so the cardinality stays bounded.
func itoaPriority(p int) string {
	if p < 1 || p > 10 {
		return "unknown"
	}
	if p < 10 {
		return "0" + string(rune('0'+p))
	}
	return "10"
}
