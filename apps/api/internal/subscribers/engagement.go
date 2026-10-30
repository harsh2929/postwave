// Per-subscriber engagement score, computed over a trailing window from the
// recipient-send, subscriber-event, and conversion ledgers and cached on
// subscribers.engagement_score.
//
// Score formula: (opens*1 + clicks*3 + replies*5) / (sends * (1+3+5))
// scaled to 0..100 and clamped. Sends come from campaign_recipients,
// the durable per-recipient send ledger; engagement signals come from
// subscriber_events.
//
// Window: 90 days. Tweak via the engagementWindow constant if needed.

package subscribers

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/currency"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const engagementWindow = 90 * 24 * time.Hour

// CurrencyRevenue is one safely-denominated revenue total. Monetary values
// with different currencies are never added together.
type CurrencyRevenue struct {
	Currency              string `json:"currency"`
	Conversions           int64  `json:"conversions"`
	RevenueCents          int64  `json:"revenue_cents"`
	RevenueCentsSaturated bool   `json:"revenue_cents_saturated"`
}

// EventCounts is the per-subscriber rollup over the engagement window.
type EventCounts struct {
	Sends   int `json:"sends"`
	Opens   int `json:"opens"`
	Clicks  int `json:"clicks"`
	Replies int `json:"replies"`
	// RevenueCents is denominated exclusively in RevenueCurrency. When a
	// subscriber has multiple currencies it is the deterministic dominant
	// currency total (highest revenue, then conversion count, then ISO code),
	// never a cross-currency sum. RevenueByCurrency discloses every valid
	// currency total so clients do not have to infer what was excluded.
	RevenueCents int64 `json:"revenue_cents"`
	// RevenueCentsSaturated is true when the exact dominant-currency SUM is
	// outside JSON's int64 contract and RevenueCents has been clamped to the
	// nearest bound. This prevents hostile/extreme conversion rows from taking
	// down the entire subscriber detail while making the loss of precision
	// explicit.
	RevenueCentsSaturated bool `json:"revenue_cents_saturated"`
	// RevenueCurrency is empty when the window has no valid monetary rows.
	RevenueCurrency string `json:"revenue_currency,omitempty"`
	// RevenueByCurrency is ordered dominant-first and is always non-nil for
	// repo-produced responses.
	RevenueByCurrency []CurrencyRevenue `json:"revenue_by_currency"`
	// MixedCurrency is true when RevenueByCurrency contains multiple ISO
	// currencies. It makes the dominant-currency semantics explicit to thin
	// clients that do not inspect the entire breakdown.
	MixedCurrency bool `json:"mixed_currency"`
	// UnclassifiedMonetaryConversions counts amount-bearing rows whose
	// currency is missing or is not recognized by the CLDR/ISO-4217 registry.
	// Their amounts are deliberately excluded because they cannot be safely
	// denominated.
	UnclassifiedMonetaryConversions int64 `json:"unclassified_monetary_conversions"`
}

// engagementISOCurrencyCodes is the bounded set accepted by the revenue
// rollup. x/text's generated CLDR registry recognizes current and historical
// ISO-4217 units; keeping historical codes lets old, correctly-denominated
// conversions remain reportable. XXX means "no currency" and is intentionally
// treated as unclassified rather than as a summable denomination.
var engagementISOCurrencyCodes = func() []string {
	seen := make(map[string]struct{})
	it := currency.Query(currency.Historical, currency.NonTender)
	for it.Next() {
		code := it.Unit().String()
		if code != "XXX" {
			seen[code] = struct{}{}
		}
	}
	codes := make([]string, 0, len(seen))
	for code := range seen {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return codes
}()

// EngagementResult is the response body for GET /subscribers/{id}/engagement.
type EngagementResult struct {
	SubscriberID string      `json:"subscriber_id"`
	Email        string      `json:"email"`
	Score        int         `json:"score"`
	Counts       EventCounts `json:"counts"`
	WindowDays   int         `json:"window_days"`
	ComputedAt   time.Time   `json:"computed_at"`
	// Extra fields surfaced for the agent-coverage-gaps SDK shape.
	Opens30d    int        `json:"opens_30d"`
	Clicks30d   int        `json:"clicks_30d"`
	LastOpenAt  *time.Time `json:"last_open_at,omitempty"`
	LastClickAt *time.Time `json:"last_click_at,omitempty"`
}

// MountEngagementRoutes registers engagement + activity endpoints.
func MountEngagementRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/engagement", d.Engagement)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/engagement", d.EngagementBatch)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/activity", d.Activity)
}

// ComputeScore returns a 0-100 engagement score from raw event counts.
func ComputeScore(c EventCounts) int {
	weighted := c.Opens*1 + c.Clicks*3 + c.Replies*5
	if weighted <= 0 {
		return 0
	}
	denom := c.Sends
	if denom <= 0 {
		denom = 1
	}
	const perfect = 1 + 3 + 5
	score := (weighted * 100) / (denom * perfect)
	if score > 100 {
		score = 100
	}
	if score < 0 {
		score = 0
	}
	return score
}

// Engagement reads/computes the engagement score for one subscriber and
// caches the result on subscribers.engagement_score.
func (r *Repo) Engagement(ctx context.Context, tenantID, subscriberID string) (*EngagementResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email string
	if err := tx.QueryRow(ctx, `
SELECT email::text FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subscriberID).Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// ErrNotFound, not a fresh error with the same words. The package
			// sentinel is literally errors.New("subscriber not found"), so a
			// freshly built twin reads identically in logs and in a debugger
			// while errors.Is against it returns false -- which is why an absent
			// subscriber could only be treated as an internal failure.
			return nil, ErrNotFound
		}
		return nil, err
	}
	now := time.Now().UTC()
	since := now.Add(-engagementWindow)
	counts, err := loadCounts(ctx, tx, tenantID, email, since)
	if err != nil {
		return nil, err
	}
	score := ComputeScore(counts)

	// Pull the smaller 30-day rollup + last-event timestamps for the
	// SDK shape. Done as a separate query rather than folded into
	// loadCounts so loadCounts stays a stable testable helper.
	since30 := now.Add(-30 * 24 * time.Hour)
	var opens30, clicks30 int
	var lastOpen, lastClick *time.Time
	if err := tx.QueryRow(ctx, `
SELECT
  COALESCE(SUM(CASE WHEN event_type='opened'  AND at >= $3 THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN event_type='clicked' AND at >= $3 THEN 1 ELSE 0 END), 0),
  MAX(at) FILTER (WHERE event_type='opened'),
  MAX(at) FILTER (WHERE event_type='clicked')
FROM subscriber_events
WHERE tenant_id = $1::uuid AND subscriber_email = $2`,
		tenantID, email, since30).Scan(&opens30, &clicks30, &lastOpen, &lastClick); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET engagement_score = $1, engagement_score_at = $2
 WHERE tenant_id = $3::uuid AND id = $4::uuid`, score, now, tenantID, subscriberID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &EngagementResult{
		SubscriberID: subscriberID,
		Email:        email,
		Score:        score,
		Counts:       counts,
		WindowDays:   90,
		ComputedAt:   now,
		Opens30d:     opens30,
		Clicks30d:    clicks30,
		LastOpenAt:   lastOpen,
		LastClickAt:  lastClick,
	}, nil
}

// EngagementSnapshot is the lightweight (id + email + counters) projection
// emitted on the subscriber.engagement_updated SSE event (SUB-096). It is a
// strict subset of EngagementResult — just the fields the live slideover
// counter needs — and is computed WITHOUT the cache-write side effect of
// Engagement() so it stays cheap on the hot ingest path.
type EngagementSnapshot struct {
	SubscriberID string
	Email        string
	Counts       EventCounts
}

// EngagementByEmail loads the 90-day engagement counters for a subscriber
// identified by email (the key engagement webhooks carry). Returns
// pgx.ErrNoRows-wrapped errors.New when the email has no subscriber row in
// the tenant. Read-only: unlike Engagement() it does not write the
// engagement_score cache, so it is safe to call from the SSE emit path after
// every inbound open/click without adding a write per webhook.
//
// SUB-096: this backs the subscriber.engagement_updated event payload so the
// detail slideover can update its Contact Performance counters live.
func (r *Repo) EngagementByEmail(ctx context.Context, tenantID, email string) (*EngagementSnapshot, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return nil, errors.New("empty email")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID string
	if err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = $2`,
		tenantID, email).Scan(&subscriberID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// ErrNotFound, not a fresh error with the same words. The package
			// sentinel is literally errors.New("subscriber not found"), so a
			// freshly built twin reads identically in logs and in a debugger
			// while errors.Is against it returns false -- which is why an absent
			// subscriber could only be treated as an internal failure.
			return nil, ErrNotFound
		}
		return nil, err
	}
	since := time.Now().UTC().Add(-engagementWindow)
	counts, err := loadCounts(ctx, tx, tenantID, email, since)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &EngagementSnapshot{
		SubscriberID: subscriberID,
		Email:        email,
		Counts:       counts,
	}, nil
}

func loadCounts(ctx context.Context, tx pgx.Tx, tenantID, email string, since time.Time) (EventCounts, error) {
	c := EventCounts{RevenueByCurrency: []CurrencyRevenue{}}
	// campaign_recipients is the canonical send ledger. subscriber_events'
	// final CHECK vocabulary does not contain a "sent" event, so treating an
	// open/click/bounce/etc. as a send fabricated the denominator and could
	// make one delivery count several times. The scalar function is a narrowly
	// privileged, tenant-authenticated SECURITY DEFINER boundary: it avoids the
	// campaign-recipient worker RLS policy's security-barrier plan without ever
	// exposing recipient rows. Keep the sources independently aggregated so
	// their cardinalities can never multiply each other.
	row := tx.QueryRow(ctx, `
SELECT
  public.subscriber_contact_sent_count($1::uuid, $2, $3) AS sends,
  COUNT(*) FILTER (WHERE event_type = 'opened')   AS opens,
  COUNT(*) FILTER (WHERE event_type = 'clicked')  AS clicks,
  COUNT(*) FILTER (WHERE event_type = 'replied')  AS replies
FROM subscriber_events
WHERE tenant_id = $1::uuid AND subscriber_email = $2 AND at >= $3`, tenantID, email, since)
	var sends, opens, clicks, replies int64
	if err := row.Scan(&sends, &opens, &clicks, &replies); err != nil {
		return c, err
	}
	c.Sends = int(sends)
	c.Opens = int(opens)
	c.Clicks = int(clicks)
	c.Replies = int(replies)

	breakdown, unclassified, err := loadCurrencyRevenue(ctx, tx, tenantID, email, since)
	if err != nil {
		return c, err
	}
	c.RevenueByCurrency = breakdown
	c.UnclassifiedMonetaryConversions = unclassified
	c.MixedCurrency = len(breakdown) > 1
	if len(breakdown) > 0 {
		c.RevenueCurrency = breakdown[0].Currency
		c.RevenueCents = breakdown[0].RevenueCents
		c.RevenueCentsSaturated = breakdown[0].RevenueCentsSaturated
	}
	return c, nil
}

// loadCurrencyRevenue returns an exact, deterministic per-currency breakdown
// for amount-bearing conversions in the same tenant/subscriber/window as the
// engagement report. The finite ISO allowlist bounds GROUP BY cardinality and
// invalid/missing currencies collapse into one count-only bucket; their cents
// are never combined or mislabeled.
func loadCurrencyRevenue(ctx context.Context, tx pgx.Tx, tenantID, email string, since time.Time) ([]CurrencyRevenue, int64, error) {
	rows, err := tx.Query(ctx, `
WITH classified AS (
  SELECT amount_cents,
         CASE
           WHEN upper(btrim(currency)) = ANY($4::text[])
           THEN upper(btrim(currency))
         END AS currency
    FROM conversions
   WHERE tenant_id = $1::uuid
     AND subscriber_email = $2::citext
     AND amount_cents IS NOT NULL
     AND occurred_at >= $3
), totals_raw AS (
  SELECT currency,
         COUNT(*)::bigint AS conversions,
         SUM(amount_cents)::numeric AS raw_revenue_cents
    FROM classified
   WHERE currency IS NOT NULL
   GROUP BY currency
), totals AS (
  SELECT currency,
         conversions,
         GREATEST(-9223372036854775808::numeric,
           LEAST(9223372036854775807::numeric, raw_revenue_cents))::bigint AS revenue_cents,
         raw_revenue_cents NOT BETWEEN -9223372036854775808::numeric
                                   AND 9223372036854775807::numeric AS saturated,
         raw_revenue_cents
    FROM totals_raw
), invalid AS (
  SELECT COUNT(*) FILTER (WHERE currency IS NULL)::bigint AS unclassified
    FROM classified
)
SELECT t.currency, t.conversions, t.revenue_cents, t.saturated, i.unclassified
  FROM invalid i
  LEFT JOIN totals t ON true
 ORDER BY t.raw_revenue_cents DESC NULLS LAST,
          t.conversions DESC NULLS LAST,
          t.currency ASC NULLS LAST`, tenantID, email, since, engagementISOCurrencyCodes)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := []CurrencyRevenue{}
	var unclassified int64
	for rows.Next() {
		var code sql.NullString
		var conversions, revenue sql.NullInt64
		var saturated sql.NullBool
		if err := rows.Scan(&code, &conversions, &revenue, &saturated, &unclassified); err != nil {
			return nil, 0, err
		}
		// The LEFT JOIN emits one all-NULL total when there are no valid
		// monetary currencies, ensuring the unclassified count is still read.
		if !code.Valid {
			continue
		}
		out = append(out, CurrencyRevenue{
			Currency:              code.String,
			Conversions:           conversions.Int64,
			RevenueCents:          revenue.Int64,
			RevenueCentsSaturated: saturated.Bool,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, unclassified, nil
}

// Engagement GET /api/v1/subscribers/{id}/engagement
func (d *Deps) Engagement(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	res, err := d.Repo.Engagement(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// EngagementBatch GET /api/v1/subscribers/engagement?ids=a,b,c
func (d *Deps) EngagementBatch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	raw := r.URL.Query().Get("ids")
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_ids", "?ids=a,b,c required"))
		return
	}
	ids := []string{}
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			ids = append(ids, p)
		}
	}
	if len(ids) > 200 {
		writeJSON(w, http.StatusBadRequest, errEnv("too_many", "max 200 ids per request"))
		return
	}
	out := []EngagementResult{}
	for _, id := range ids {
		res, err := d.Repo.Engagement(r.Context(), t.ID, id)
		if err != nil {
			continue
		}
		out = append(out, *res)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}
