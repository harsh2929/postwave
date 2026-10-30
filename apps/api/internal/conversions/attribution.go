// SPDX-License-Identifier: AGPL-3.0-only
//
// Revenue attribution: per-campaign revenue + ROI built on the
// conversions fact table (see conversions.go + migration 0049).
//
// Two read-only surfaces (both read:reports scope):
//
//	GET /api/v1/conversions/attribution/campaigns?days=90
//	GET /api/v1/conversions/attribution/timeseries?days=90&campaign_id=…
//
// Attribution model: a conversion row carries an optional campaign_id
// (last-touch, stamped at ingestion via ?c= / pw_campaign cookie /
// JSON body). Rows without campaign_id are "unattributed" — reported
// explicitly via unattributed_cents + unattributed_conversions, never
// silently dropped.
//
// Sequence attribution is not part of this API contract: conversions carry
// campaign_id only, with no sequence stamp or sequence linkage. The router
// intentionally exposes no sequence-attribution operation so clients cannot
// mistake fabricated empty data for a supported report.
//
// Currency: amount_cents is paired with an ISO-4217 currency per row
// and tenants may mix currencies. We NEVER sum across currencies.
// Every monetary figure in a response is denominated in a single
// "dominant" currency (most revenue in the window; ties broken by
// conversion count, then alphabetically) and the full per-currency
// breakdown is disclosed via the `currencies` field.
//
// emails_sent reuses this branch's semantics (analytics.DashboardStats
// .EmailsSent30d): count(*) of event_type='sent' rows per campaign in
// campaign_report_events — true per-recipient sends, not distinct
// campaigns. The count is all-time for the campaign (a campaign's send
// happens once; conversions may trail it by weeks), which makes it the
// honest revenue-per-send denominator.
package conversions

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	attributionDefaultDays = 90
	attributionMaxDays     = 365
	// attributionTopCampaigns caps the per-campaign item list; the
	// remainder rolls up into a single "(other campaigns)" item so
	// totals stay exact.
	attributionTopCampaigns = 50

	// lastTouchAttributionWindow is the documented look-back for
	// AUTOMATIC last-touch attribution: when a conversion arrives with
	// no explicit campaign_id, we join it to the subscriber's most
	// recent email *click* (campaign_report_events.event_type='clicked')
	// recorded within this window before the conversion's occurred_at.
	// Clicks older than this NEVER attribute — the conversion stays
	// unattributed and is stamped attributed_via='none'. 7 days is the
	// industry-standard email last-touch window (Klaviyo/Mailchimp
	// default to 5–7d click attribution) and is the single source of
	// truth referenced by migration 0397's schema comment.
	lastTouchAttributionWindow = 7 * 24 * time.Hour

	// backfillBatchSize bounds one backfill pass so a single request
	// never holds a long transaction or scans the whole table. The
	// endpoint is idempotent (it only touches attributed_via IS NULL
	// rows) so operators can call it repeatedly until done==true.
	backfillBatchSize = 500
)

// attributed_via provenance values. Mirror migration 0397's CHECK
// constraint exactly — adding a value requires editing both.
const (
	// AttributedViaExplicit: the caller supplied campaign_id (JSON
	// body / ?c= / pw_campaign cookie). Highest priority — last-touch
	// never overrides it.
	AttributedViaExplicit = "explicit"
	// AttributedViaLastTouch: campaign_id was auto-joined from a recent
	// click. A heuristic — clients must label it honestly, never as
	// certain attribution.
	AttributedViaLastTouch = "last_touch"
	// AttributedViaNone: no explicit campaign_id and no in-window click
	// found. The conversion is genuinely unattributed.
	AttributedViaNone = "none"
)

// AttributionItem is one campaign's revenue line.
type AttributionItem struct {
	CampaignID   string `json:"campaign_id"`
	CampaignName string `json:"campaign_name"`
	// Conversions counts ALL attributed conversions for the campaign
	// in the window — monetary in any currency plus non-monetary.
	Conversions int64 `json:"conversions"`
	// RevenueCents sums amount_cents for rows in the response's
	// dominant currency only (see Currency on the envelope).
	RevenueCents int64 `json:"revenue_cents"`
	// EmailsSent is the all-time per-recipient send count for the
	// campaign (count of event_type='sent' campaign_report_events).
	EmailsSent int64 `json:"emails_sent"`
	// RevenuePerSendCents = RevenueCents / EmailsSent; omitted when
	// EmailsSent is 0 (no honest denominator).
	RevenuePerSendCents *float64 `json:"revenue_per_send_cents,omitempty"`
}

// CurrencyTotal is the per-currency disclosure: how much revenue (and
// how many monetary conversions) the window holds in each currency.
type CurrencyTotal struct {
	Currency     string `json:"currency"`
	Conversions  int64  `json:"conversions"`
	RevenueCents int64  `json:"revenue_cents"`
}

// AttributionProvenance is the honest "how were these conversions
// attributed?" breakdown over the window. It lets the desktop render
// "X% explicitly tagged, Y% last-touch attributed" without ever
// presenting the last-touch heuristic as certain.
//
// Counts are over ALL conversions in the window (monetary + non-
// monetary, every currency) so the percentages a client derives are
// honest. Legacy pre-0397 rows whose attributed_via is still NULL are
// reported separately under Unclassified — folding them into 'none' or
// 'explicit' would overstate confidence either way. CodeRedemption and
// CampaignVanityPath are separate outcome-linkage evidence classes; neither is
// reader identity or causal proof.
type AttributionProvenance struct {
	// Explicit: caller passed campaign_id.
	Explicit int64 `json:"explicit"`
	// LastTouch: auto-joined from a recent click (a heuristic).
	LastTouch int64 `json:"last_touch"`
	// None: no campaign_id and no in-window click — truly unattributed.
	None int64 `json:"none"`
	// CodeRedemption: a reported outcome linked through one code assignment.
	CodeRedemption int64 `json:"code_redemption"`
	// CampaignVanityPath: a reported outcome linked through one shared campaign
	// path visit. It has campaign scope only.
	CampaignVanityPath int64 `json:"campaign_vanity_path"`
	// Unclassified: pre-0397 rows the backfill hasn't stamped yet
	// (attributed_via IS NULL). Surfaced so clients don't silently
	// mislabel them; run the backfill endpoint to drain this to 0.
	Unclassified int64 `json:"unclassified"`
}

// CampaignAttributionResponse is the GET …/attribution/campaigns body.
type CampaignAttributionResponse struct {
	Items []AttributionItem `json:"items"`
	// Provenance is the complete explicit/last_touch/none/code-redemption/
	// vanity-path/unclassified split over the window. Never present last-touch as
	// certain or either outcome-link class as reader identity.
	Provenance AttributionProvenance `json:"provenance"`
	// TotalRevenueCents is ALL revenue in the dominant currency in
	// the window — attributed + unattributed.
	TotalRevenueCents int64 `json:"total_revenue_cents"`
	// UnattributedCents / UnattributedConversions report conversions
	// with no campaign attribution. Never folded into items.
	UnattributedCents       int64 `json:"unattributed_cents"`
	UnattributedConversions int64 `json:"unattributed_conversions"`
	// Currency is the dominant currency every *_cents figure is
	// denominated in. Empty when the window has no monetary
	// conversions at all.
	Currency string `json:"currency,omitempty"`
	// Currencies is the full per-currency breakdown — non-empty
	// whenever monetary conversions exist, so mixed-currency tenants
	// can see exactly what was excluded from the dominant-currency sums.
	Currencies []CurrencyTotal `json:"currencies"`
	// TotalCampaigns is the count of DISTINCT campaigns with attributed
	// revenue in the window, before the top-N rollup. When it exceeds the
	// individually-listed rows, the UI can honestly say "top N of M"
	// rather than implying the list is the whole picture.
	TotalCampaigns int `json:"total_campaigns"`
	Days           int `json:"days"`
}

// TimeseriesPoint is one zero-filled day.
type TimeseriesPoint struct {
	Date         string `json:"date"` // YYYY-MM-DD, UTC
	RevenueCents int64  `json:"revenue_cents"`
	Conversions  int64  `json:"conversions"`
}

// TimeseriesResponse is the GET …/attribution/timeseries body.
type TimeseriesResponse struct {
	Points     []TimeseriesPoint `json:"points"`
	Currency   string            `json:"currency,omitempty"`
	Currencies []CurrencyTotal   `json:"currencies"`
	Days       int               `json:"days"`
	CampaignID string            `json:"campaign_id,omitempty"`
}

// ----------------------------------------------------------------------
// Pure helpers (unit-tested without a database)
// ----------------------------------------------------------------------

// parseDays parses the ?days= query param. Empty → default 90.
// Non-integer or outside [1, 365] → error (handler maps to 400).
func parseDays(raw string) (int, bool) {
	if raw == "" {
		return attributionDefaultDays, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > attributionMaxDays {
		return 0, false
	}
	return n, true
}

// windowStartUTC floors `now` to its UTC date and steps back days-1,
// so a days=N window covers exactly N calendar days (UTC) including
// today. Using a date floor (not a rolling now()-interval) keeps the
// SQL window aligned with the zero-filled timeseries dates.
func windowStartUTC(now time.Time, days int) time.Time {
	d := now.UTC()
	floor := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
	return floor.AddDate(0, 0, -(days - 1))
}

// dominantCurrency picks the currency all *_cents figures are
// denominated in: most revenue first, then most monetary conversions,
// then alphabetical for determinism. Empty slice → "" (no monetary
// conversions in the window).
func dominantCurrency(totals []CurrencyTotal) string {
	best := ""
	var bestRev, bestConv int64
	for _, t := range totals {
		switch {
		case best == "",
			t.RevenueCents > bestRev,
			t.RevenueCents == bestRev && t.Conversions > bestConv,
			t.RevenueCents == bestRev && t.Conversions == bestConv && t.Currency < best:
			best, bestRev, bestConv = t.Currency, t.RevenueCents, t.Conversions
		}
	}
	return best
}

// rollupTopCampaigns keeps the first max items (callers pass them
// sorted by revenue desc) and folds the remainder into one
// "(other campaigns)" item so envelope totals stay exact.
func rollupTopCampaigns(items []AttributionItem, max int) []AttributionItem {
	if len(items) <= max {
		return items
	}
	kept := make([]AttributionItem, max, max+1)
	copy(kept, items[:max])
	other := AttributionItem{CampaignID: "", CampaignName: "(other campaigns)"}
	for _, it := range items[max:] {
		other.Conversions += it.Conversions
		other.RevenueCents += it.RevenueCents
		other.EmailsSent += it.EmailsSent
	}
	return append(kept, other)
}

// revenuePerSendCents returns revenue/sends, or nil when sends == 0
// (an honest "no denominator" rather than a fake 0 or +Inf).
func revenuePerSendCents(revenueCents, emailsSent int64) *float64 {
	if emailsSent <= 0 {
		return nil
	}
	v := float64(revenueCents) / float64(emailsSent)
	return &v
}

// zeroFillTimeseries expands sparse per-day aggregates into exactly
// `days` consecutive points ending at start+days-1, zero-filling
// missing dates. byDate keys are YYYY-MM-DD (UTC).
func zeroFillTimeseries(start time.Time, days int, byDate map[string]TimeseriesPoint) []TimeseriesPoint {
	out := make([]TimeseriesPoint, 0, days)
	for i := 0; i < days; i++ {
		date := start.AddDate(0, 0, i).Format("2006-01-02")
		if p, ok := byDate[date]; ok {
			p.Date = date
			out = append(out, p)
			continue
		}
		out = append(out, TimeseriesPoint{Date: date})
	}
	return out
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isUUID(s string) bool { return uuidRe.MatchString(s) }

// ----------------------------------------------------------------------
// Repo queries
// ----------------------------------------------------------------------

// currencyTotals returns the per-currency revenue breakdown for the
// window (optionally filtered to one campaign), ordered so the
// dominant currency comes first. Runs inside the caller's tenant tx.
func currencyTotals(ctx context.Context, tx pgx.Tx, tenantID string, start time.Time, campaignID string) ([]CurrencyTotal, error) {
	q := `
SELECT COALESCE(currency, ''), count(*)::bigint, COALESCE(sum(amount_cents), 0)::bigint
  FROM conversions
 WHERE tenant_id = $1::uuid AND occurred_at >= $2 AND amount_cents IS NOT NULL`
	args := []any{tenantID, start}
	if campaignID != "" {
		q += ` AND campaign_id = $3::uuid`
		args = append(args, campaignID)
	}
	q += `
 GROUP BY 1
 ORDER BY 3 DESC, 2 DESC, 1`
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CurrencyTotal{}
	for rows.Next() {
		var t CurrencyTotal
		if err := rows.Scan(&t.Currency, &t.Conversions, &t.RevenueCents); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// lookupLastTouchCampaign finds the subscriber's most recent in-window
// email click and returns its campaign_id, or "" when there is none.
//
// It runs INSIDE the caller's tenant-scoped tx (RLS on
// campaign_report_events keys on app.tenant_id, which the caller has
// already bound) and additionally filters tenant_id = $1 explicitly so
// the join is tenant-correct even under the public-ingest GUC path.
//
// "Most recent" = highest `at` strictly before the conversion's
// occurred_at and no older than lastTouchAttributionWindow before it.
// Using occurred_at (not now()) as the anchor keeps backfill and live
// ingest identical and order-independent. The query is served by
// campaign_report_events_last_touch_idx (partial on event_type=
// 'clicked', migration 0397).
//
// email must be lowercased by the caller (subscriber_email is citext,
// but we normalise upstream for consistency with Insert).
func lookupLastTouchCampaign(ctx context.Context, tx pgx.Tx, tenantID, email string, occurredAt time.Time) (string, error) {
	if email == "" {
		return "", nil
	}
	windowStart := occurredAt.Add(-lastTouchAttributionWindow)
	var campaignID string
	err := tx.QueryRow(ctx, `
SELECT campaign_id::text
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND event_type = 'clicked'
   AND at < $3
   AND at >= $4
 ORDER BY at DESC
 LIMIT 1`, tenantID, email, occurredAt, windowStart).Scan(&campaignID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return campaignID, nil
}

// BackfillResult is the outcome of one bounded backfill pass.
type BackfillResult struct {
	// Scanned is how many previously-unclassified rows this pass
	// touched (≤ backfillBatchSize).
	Scanned int64 `json:"scanned"`
	// Explicit/LastTouch/None count how each scanned row was classified.
	Explicit  int64 `json:"explicit"`
	LastTouch int64 `json:"last_touch"`
	None      int64 `json:"none"`
	// BatchSize is the cap this pass used.
	BatchSize int `json:"batch_size"`
	// Done is true when this pass found fewer than BatchSize
	// unclassified rows, i.e. the tenant's backfill is complete. Callers
	// loop on POST until done==true.
	Done bool `json:"done"`
}

// BackfillLastTouch classifies one bounded batch of the tenant's
// not-yet-classified conversions (attributed_via IS NULL) — the
// historical rows that predate the 0397 provenance column.
//
// Per row:
//   - campaign_id already set → it was caller-supplied historically →
//     stamp 'explicit' (never overridden).
//   - campaign_id NULL → last-touch lookup anchored at THAT row's
//     occurred_at. A hit fills campaign_id + stamps 'last_touch' (and
//     mirrors a 'conversion' event for the analytics pipeline, matching
//     live ingest). A miss stamps 'none'.
//
// Idempotent: the WHERE attributed_via IS NULL predicate means a row is
// classified at most once, so repeated calls drain the backlog and then
// no-op (Scanned==0, Done==true). Bounded by backfillBatchSize so one
// request never holds a long transaction.
//
// Each row anchors its last-touch window on its OWN occurred_at (not
// now()), so the backfill reproduces exactly what live ingest would
// have stamped at the time the conversion arrived.
func (r *Repo) BackfillLastTouch(ctx context.Context, tenantID string) (*BackfillResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// FOR UPDATE SKIP LOCKED so concurrent backfill calls for the same
	// tenant don't fight over the same rows. Order by id for stable,
	// resumable progress.
	rows, err := tx.Query(ctx, `
SELECT id, COALESCE(subscriber_email::text, ''),
       COALESCE(campaign_id::text, ''), occurred_at
  FROM conversions
 WHERE tenant_id = $1::uuid AND attributed_via IS NULL
 ORDER BY id
 LIMIT $2
 FOR UPDATE SKIP LOCKED`, tenantID, backfillBatchSize)
	if err != nil {
		return nil, err
	}
	type pending struct {
		id         int64
		email      string
		campaignID string
		occurredAt time.Time
	}
	batch := []pending{}
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.email, &p.campaignID, &p.occurredAt); err != nil {
			rows.Close()
			return nil, err
		}
		batch = append(batch, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	res := &BackfillResult{BatchSize: backfillBatchSize}
	for _, p := range batch {
		via := AttributedViaExplicit
		campaign := p.campaignID
		if campaign == "" {
			lastTouch, lookupErr := lookupLastTouchCampaign(ctx, tx, tenantID, p.email, p.occurredAt)
			if lookupErr != nil {
				return nil, lookupErr
			}
			if lastTouch != "" {
				campaign, via = lastTouch, AttributedViaLastTouch
			} else {
				via = AttributedViaNone
			}
		}
		if _, err := tx.Exec(ctx, `
UPDATE conversions
   SET campaign_id = COALESCE(campaign_id, NULLIF($3, '')::uuid),
       attributed_via = $2
 WHERE tenant_id = $1::uuid AND id = $4 AND attributed_via IS NULL`,
			tenantID, via, campaign, p.id); err != nil {
			return nil, err
		}
		// Mirror newly last-touch-attributed rows into the analytics
		// pipeline, matching live ingest. Explicit historical rows were
		// already mirrored at their original ingest; 'none' has nothing
		// to mirror.
		if via == AttributedViaLastTouch {
			if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events
    (tenant_id, campaign_id, subscriber_email, event_type, link_url, at)
VALUES ($1::uuid, $2::uuid, NULLIF($3, ''), 'conversion', NULL, $4)`,
				tenantID, campaign, p.email, p.occurredAt); err != nil {
				return nil, err
			}
		}
		res.Scanned++
		switch via {
		case AttributedViaExplicit:
			res.Explicit++
		case AttributedViaLastTouch:
			res.LastTouch++
		case AttributedViaNone:
			res.None++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	res.Done = res.Scanned < int64(backfillBatchSize)
	return res, nil
}

// CampaignAttribution aggregates the tenant's conversions over the
// last `days` UTC calendar days into per-campaign revenue lines plus
// an explicit unattributed bucket. now is injectable for tests.
func (r *Repo) CampaignAttribution(ctx context.Context, tenantID string, days int, now time.Time) (*CampaignAttributionResponse, error) {
	start := windowStartUTC(now, days)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	totals, err := currencyTotals(ctx, tx, tenantID, start, "")
	if err != nil {
		return nil, err
	}
	dominant := dominantCurrency(totals)

	// Per-campaign aggregates. Uses conversions_campaign_idx
	// (tenant_id, campaign_id, occurred_at DESC) WHERE campaign_id
	// IS NOT NULL. Revenue is FILTERed to the dominant currency so
	// mixed currencies are never summed together; the conversion
	// count deliberately includes every attributed conversion
	// (other-currency + non-monetary) — counts are currency-free.
	rows, err := tx.Query(ctx, `
SELECT c.campaign_id::text,
       COALESCE(cam.name, '(deleted campaign)'),
       count(*)::bigint,
       COALESCE(sum(c.amount_cents) FILTER (WHERE c.currency = $3), 0)::bigint
  FROM conversions c
  LEFT JOIN campaigns cam
         ON cam.id = c.campaign_id AND cam.tenant_id = c.tenant_id
 WHERE c.tenant_id = $1::uuid
   AND c.occurred_at >= $2
   AND c.campaign_id IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 4 DESC, 3 DESC, 1`, tenantID, start, dominant)
	if err != nil {
		return nil, err
	}
	items := []AttributionItem{}
	campaignIDs := []string{}
	for rows.Next() {
		var it AttributionItem
		if err := rows.Scan(&it.CampaignID, &it.CampaignName, &it.Conversions, &it.RevenueCents); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, it)
		campaignIDs = append(campaignIDs, it.CampaignID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Unattributed bucket — reported explicitly, never dropped.
	var unattribConv, unattribCents int64
	if err := tx.QueryRow(ctx, `
SELECT count(*)::bigint,
       COALESCE(sum(amount_cents) FILTER (WHERE currency = $3), 0)::bigint
  FROM conversions
 WHERE tenant_id = $1::uuid AND occurred_at >= $2 AND campaign_id IS NULL`,
		tenantID, start, dominant).Scan(&unattribConv, &unattribCents); err != nil {
		return nil, err
	}

	// Honest provenance split over ALL conversions in the window —
	// explicit / last_touch / none / code_redemption / campaign_vanity_path,
	// plus NULL (pre-0397, not yet
	// backfilled). Lets the desktop show "X% tagged, Y% last-touch"
	// without ever presenting the heuristic as certain.
	var prov AttributionProvenance
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE attributed_via = 'explicit')::bigint,
       count(*) FILTER (WHERE attributed_via = 'last_touch')::bigint,
       count(*) FILTER (WHERE attributed_via = 'none')::bigint,
       count(*) FILTER (WHERE attributed_via = 'code_redemption')::bigint,
       count(*) FILTER (WHERE attributed_via = 'campaign_vanity_path')::bigint,
       count(*) FILTER (WHERE attributed_via IS NULL)::bigint
  FROM conversions
 WHERE tenant_id = $1::uuid AND occurred_at >= $2`,
		tenantID, start).Scan(
		&prov.Explicit, &prov.LastTouch, &prov.None, &prov.CodeRedemption,
		&prov.CampaignVanityPath, &prov.Unclassified,
	); err != nil {
		return nil, err
	}

	// Per-recipient send counts (all-time per campaign — the ROI
	// denominator; see package doc). Uses
	// campaign_report_events_campaign_idx (tenant_id, campaign_id,
	// event_type, at DESC).
	sentByCampaign := map[string]int64{}
	if len(campaignIDs) > 0 {
		srows, err := tx.Query(ctx, `
SELECT campaign_id::text, count(*)::bigint
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = ANY($2::uuid[]) AND event_type = 'sent'
 GROUP BY 1`, tenantID, campaignIDs)
		if err != nil {
			return nil, err
		}
		for srows.Next() {
			var id string
			var n int64
			if err := srows.Scan(&id, &n); err != nil {
				srows.Close()
				return nil, err
			}
			sentByCampaign[id] = n
		}
		srows.Close()
		if err := srows.Err(); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	for i := range items {
		items[i].EmailsSent = sentByCampaign[items[i].CampaignID]
	}
	// Distinct campaigns with attributed revenue in the window, captured
	// BEFORE the top-N rollup collapses the tail into "(other campaigns)".
	// Lets the UI honestly say "top N of M" instead of guessing M.
	totalCampaigns := len(items)
	items = rollupTopCampaigns(items, attributionTopCampaigns)
	for i := range items {
		items[i].RevenuePerSendCents = revenuePerSendCents(items[i].RevenueCents, items[i].EmailsSent)
	}

	var totalDominant int64
	for _, t := range totals {
		if t.Currency == dominant {
			totalDominant = t.RevenueCents
			break
		}
	}
	return &CampaignAttributionResponse{
		Items:                   items,
		Provenance:              prov,
		TotalRevenueCents:       totalDominant,
		UnattributedCents:       unattribCents,
		UnattributedConversions: unattribConv,
		Currency:                dominant,
		Currencies:              totals,
		TotalCampaigns:          totalCampaigns,
		Days:                    days,
	}, nil
}

// AttributionTimeseries returns zero-filled per-day revenue +
// conversion counts, optionally filtered to one campaign.
func (r *Repo) AttributionTimeseries(ctx context.Context, tenantID string, days int, campaignID string, now time.Time) (*TimeseriesResponse, error) {
	start := windowStartUTC(now, days)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	totals, err := currencyTotals(ctx, tx, tenantID, start, campaignID)
	if err != nil {
		return nil, err
	}
	dominant := dominantCurrency(totals)

	q := `
SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'),
       count(*)::bigint,
       COALESCE(sum(amount_cents) FILTER (WHERE currency = $3), 0)::bigint
  FROM conversions
 WHERE tenant_id = $1::uuid AND occurred_at >= $2`
	args := []any{tenantID, start, dominant}
	if campaignID != "" {
		q += ` AND campaign_id = $4::uuid`
		args = append(args, campaignID)
	}
	q += ` GROUP BY 1`
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	byDate := map[string]TimeseriesPoint{}
	for rows.Next() {
		var p TimeseriesPoint
		if err := rows.Scan(&p.Date, &p.Conversions, &p.RevenueCents); err != nil {
			rows.Close()
			return nil, err
		}
		byDate[p.Date] = p
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TimeseriesResponse{
		Points:     zeroFillTimeseries(start, days, byDate),
		Currency:   dominant,
		Currencies: totals,
		Days:       days,
		CampaignID: campaignID,
	}, nil
}

// ----------------------------------------------------------------------
// HTTP handlers + Mount
// ----------------------------------------------------------------------

// Mount registers the attribution read surface. Called from main.go
// next to the existing hand-wired conversions admin routes.
func Mount(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/conversions/attribution/campaigns", d.AdminAttributionCampaigns)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/conversions/attribution/timeseries", d.AdminAttributionTimeseries)
	// Backfill is a WRITE (it stamps attributed_via + may fill
	// campaign_id on historical rows) → admin scope, not read:reports.
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/api/v1/conversions/attribution/backfill", d.AdminAttributionBackfill)
}

// AdminAttributionCampaigns GET /api/v1/conversions/attribution/campaigns
func (d *Deps) AdminAttributionCampaigns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	days, ok := parseDays(r.URL.Query().Get("days"))
	if !ok {
		httperror.Write(w, http.StatusBadRequest, "invalid_days", "days must be an integer between 1 and 365")
		return
	}
	out, err := d.Repo.CampaignAttribution(r.Context(), t.ID, days, time.Now())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminAttributionTimeseries GET /api/v1/conversions/attribution/timeseries
func (d *Deps) AdminAttributionTimeseries(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	days, ok := parseDays(r.URL.Query().Get("days"))
	if !ok {
		httperror.Write(w, http.StatusBadRequest, "invalid_days", "days must be an integer between 1 and 365")
		return
	}
	campaignID := r.URL.Query().Get("campaign_id")
	if campaignID != "" && !isUUID(campaignID) {
		httperror.Write(w, http.StatusBadRequest, "invalid_campaign_id", "campaign_id must be a UUID")
		return
	}
	out, err := d.Repo.AttributionTimeseries(r.Context(), t.ID, days, campaignID, time.Now())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminAttributionBackfill POST /api/v1/conversions/attribution/backfill
//
// One bounded, idempotent last-touch pass over the tenant's historical
// NULL-attributed_via conversions. Each call processes up to
// backfillBatchSize rows; callers POST repeatedly until the response's
// done==true. Admin-scoped (it's a write). See Repo.BackfillLastTouch.
func (d *Deps) AdminAttributionBackfill(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	out, err := d.Repo.BackfillLastTouch(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
