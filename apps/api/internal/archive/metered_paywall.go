// SPDX-License-Identifier: AGPL-3.0-only
//
// metered_paywall.go — implements the metered paywall surface for the
// public archive (gap feature `archive-metered-paywall`, P1).
//
// What this gives operators
// -------------------------
//
//   * Tenant-level config: a quota (N free issues per visitor) plus a
//     reset cadence (daily / weekly / monthly / yearly / never). When
//     quota=0 the meter is OFF and the read path is the legacy
//     unmetered path. Quota=3 + monthly is the classic NYT model
//     beehiiv ships as their 2026 default.
//
//   * Customizable paywall payload: title, body, CTA label, CTA href.
//     The renderer returns these in the JSON response alongside a
//     `meteredLocked=true` flag so the frontend can render a card on
//     top of the teaser body.
//
//   * Older posts gated WITHOUT being hidden from search. By default
//     common search-engine bots bypass the meter (First Click Free
//     pattern) so SEO indexing keeps working. The operator can flip
//     `block_search_bots=true` to opt out of this carve-out.
//
//   * Composes with the existing per-campaign paywall (0054): if the
//     visitor is a paid_members.status='active' caller for the
//     configured `paywall_tier` the meter is bypassed entirely.
//
// Hot path (Allow check) is bounded
// ---------------------------------
//
//   1. Read tenant_metered_paywall row (single PK lookup; cached by
//      caller layer if needed). quota=0 → fast return "allowed".
//   2. UPSERT into anon_visitor_meter_reads ON CONFLICT DO NOTHING.
//      pgx returns RowsAffected=1 for the first read of this issue in
//      this period, 0 for repeat-reads. Repeats DON'T burn quota.
//   3. SELECT read_count from anon_visitor_meter; if first read in
//      period, increment + recompute via cheap COUNT on
//      anon_visitor_meter_reads.
//   4. Compare read_count vs quota and return decision.
//
// Reset semantics
// ---------------
//
// We do NOT need a periodic worker for correctness: each Allow() call
// derives the *current* period bucket from the cadence + now(), so a
// stale bucket transparently rolls over the next time the visitor
// reads. The worker package (services/scheduled/metered_paywall_reset.go,
// future) handles the housekeeping side — GC'ing rows whose
// period_started_at falls outside the current window so the table
// stays compact. The Allow path is correct independent of whether the
// worker has run.

package archive

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MeteredCadence is the reset cadence enum stored in
// tenant_metered_paywall.reset_cadence. Mirrors the CHECK constraint
// in 0297_archive_metered_paywall.sql.
type MeteredCadence string

const (
	MeteredCadenceDaily   MeteredCadence = "daily"
	MeteredCadenceWeekly  MeteredCadence = "weekly"
	MeteredCadenceMonthly MeteredCadence = "monthly"
	MeteredCadenceYearly  MeteredCadence = "yearly"
	MeteredCadenceNever   MeteredCadence = "never"
)

// MeteredPaywallConfig is the per-tenant row. A zero-value config has
// Quota=0, which is the "off" sentinel — the read path skips the meter
// entirely. Title/Body/CTA fields are surfaced in the public archive
// response when the gate fires; empty strings let the frontend pick a
// localised default.
type MeteredPaywallConfig struct {
	Quota           int            `json:"quota"`
	ResetCadence    MeteredCadence `json:"reset_cadence"`
	PaywallTitle    string         `json:"paywall_title"`
	PaywallBody     string         `json:"paywall_body"`
	PaywallCTALabel string         `json:"paywall_cta_label"`
	PaywallCTAHref  string         `json:"paywall_cta_href"`
	PaywallTier     string         `json:"paywall_tier"`
	BlockSearchBots bool           `json:"block_search_bots"`
}

// MeteredDecision is the result of an Allow() call. Used by the public
// archive handler to either return the full body or substitute a
// teaser + paywall payload.
type MeteredDecision struct {
	// Allowed is the headline bool: true → render full body, false →
	// gate engaged.
	Allowed bool
	// MeteredActive is true when the tenant has a metered paywall
	// configured (quota > 0). Always set so the response can carry a
	// `meteredActive` field for the frontend, regardless of whether
	// this particular visitor was gated.
	MeteredActive bool
	// ReadCount is the visitor's count of distinct issues read in the
	// current period AFTER applying the current read. Useful for the
	// "you have X of Y free articles left this month" banner.
	ReadCount int
	// Quota is the configured allowance; surfaced so the frontend
	// doesn't need a second round-trip to compute "remaining".
	Quota int
	// PeriodEndsAt is the end of the visitor's current reset window,
	// suitable for a "resets on …" line in the gate card. Zero when
	// cadence='never'.
	PeriodEndsAt time.Time
	// BypassReason explains why a non-Allowed condition was overridden
	// (e.g. "paid_member", "search_bot", "no_visitor_id"). Empty when
	// the meter ran normally.
	BypassReason string
}

// ErrMeteredNotConfigured is returned by GetMeteredPaywallConfig when
// the tenant has never written a config row. Callers should treat this
// as the zero-value config (meter off).
var ErrMeteredNotConfigured = errors.New("archive: metered paywall not configured")

// validMeteredCadence reports whether c is one of the five allowed
// reset cadence values. Mirrors the SQL CHECK constraint so the Go
// layer rejects garbage before the DB does.
func validMeteredCadence(c MeteredCadence) bool {
	switch c {
	case MeteredCadenceDaily, MeteredCadenceWeekly, MeteredCadenceMonthly,
		MeteredCadenceYearly, MeteredCadenceNever:
		return true
	}
	return false
}

// PeriodStart computes the start of the current reset window for the
// supplied cadence + `now`. Pure (no DB, no globals) so the test suite
// can pin a frozen clock.
//
// Boundaries:
//
//	daily   → UTC midnight of now's date.
//	weekly  → UTC Monday 00:00 of now's ISO week.
//	monthly → UTC first-of-month 00:00.
//	yearly  → UTC Jan 1 00:00.
//	never   → a fixed epoch sentinel (1970-01-01) so the bucket key
//	          stays stable for the lifetime of the visitor.
func PeriodStart(cadence MeteredCadence, now time.Time) time.Time {
	now = now.UTC()
	switch cadence {
	case MeteredCadenceDaily:
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	case MeteredCadenceWeekly:
		// Move back to Monday 00:00 UTC. time.Weekday(): Sunday=0, Mon=1, …
		// We treat Monday as the start (ISO 8601), so Sunday wraps back 6 days.
		offset := int(now.Weekday()) - 1
		if offset < 0 {
			offset = 6
		}
		d := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		return d.AddDate(0, 0, -offset)
	case MeteredCadenceMonthly:
		return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	case MeteredCadenceYearly:
		return time.Date(now.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	case MeteredCadenceNever:
		return time.Unix(0, 0).UTC()
	}
	// Unknown cadence → degrade to monthly (the SOTA default). Better
	// than panic-on-typo on the hot read path.
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// PeriodEnd returns the boundary at which a bucket opened at
// `periodStart` rolls over. Returned as a time the frontend can render
// in the "resets on …" line of the gate card.
//
// Cadence='never' → returns the zero time (caller should suppress the
// "resets on" line entirely).
func PeriodEnd(cadence MeteredCadence, periodStart time.Time) time.Time {
	switch cadence {
	case MeteredCadenceDaily:
		return periodStart.AddDate(0, 0, 1)
	case MeteredCadenceWeekly:
		return periodStart.AddDate(0, 0, 7)
	case MeteredCadenceMonthly:
		return periodStart.AddDate(0, 1, 0)
	case MeteredCadenceYearly:
		return periodStart.AddDate(1, 0, 0)
	case MeteredCadenceNever:
		return time.Time{}
	}
	return periodStart.AddDate(0, 1, 0)
}

// IsSearchBotUserAgent reports whether the supplied User-Agent header
// looks like one of the major search-engine crawlers. The list is
// deliberately conservative — false-positives bypass the gate (good
// for SEO; bad for paywall enforcement on a misconfigured curl). We
// look for canonical substrings each crawler vendor publishes in their
// webmaster docs.
//
// Public so the admin UI / docs can mirror the same list when telling
// operators which bots will be exempted by default.
func IsSearchBotUserAgent(ua string) bool {
	if ua == "" {
		return false
	}
	ua = strings.ToLower(ua)
	for _, needle := range searchBotUserAgentNeedles {
		if strings.Contains(ua, needle) {
			return true
		}
	}
	return false
}

// searchBotUserAgentNeedles is the canonical lowercase substring set
// for the major crawlers we exempt by default. Kept package-private so
// callers go through IsSearchBotUserAgent (which lowercases the input
// once).
var searchBotUserAgentNeedles = []string{
	"googlebot",
	"bingbot",
	"duckduckbot",
	"yandexbot",
	"baiduspider",
	"applebot",
	"slurp", // Yahoo! Slurp
	"facebookexternalhit",
	"twitterbot",
	"linkedinbot",
}

// MeteredAllowInput bundles the per-request inputs for the Allow
// check. Struct rather than positional args because we have a lot of
// optional context (paid-member email, user-agent) and a positional
// signature gets unwieldy.
type MeteredAllowInput struct {
	TenantID       string
	CampaignID     string
	VisitorID      string
	PaidMemberTier string // tier the requester currently holds (or "" if not paid)
	UserAgent      string
	Now            time.Time
}

// Allow is the public read-path gate check. Returns a MeteredDecision
// describing whether the visitor can read this issue + the metadata
// the response should carry. Never returns an error — on DB failure
// we fail-OPEN (return Allowed=true) because a paywall blocking the
// reader on a transient DB hiccup is materially worse for the
// operator than a single "leaked" view.
//
// This decision (fail-open vs fail-closed) is deliberate and matches
// the convention paywall-integration's `Allowed()` uses for the hard
// gate: a transient outage must not turn the whole archive into 503s.
func (r *Repo) MeteredAllow(ctx context.Context, in MeteredAllowInput) MeteredDecision {
	if in.Now.IsZero() {
		in.Now = time.Now().UTC()
	}
	dec := MeteredDecision{Allowed: true}

	// Load tenant config. Missing row → meter off.
	cfg, err := r.GetMeteredPaywallConfig(ctx, in.TenantID)
	if err != nil {
		// Fail-open: log via the caller if needed, but never block.
		return dec
	}
	if cfg.Quota <= 0 {
		// Meter explicitly off.
		return dec
	}
	dec.MeteredActive = true
	dec.Quota = cfg.Quota

	periodStart := PeriodStart(cfg.ResetCadence, in.Now)
	dec.PeriodEndsAt = PeriodEnd(cfg.ResetCadence, periodStart)

	// Bypass paths — checked in priority order. Each sets BypassReason
	// so the frontend can render a debug attribute on its own gate card.
	if in.VisitorID == "" {
		// No anon_visitor_id cookie yet → first-request render path.
		// Allow + tag so the client knows to set a cookie and the
		// next request hits the metered logic normally.
		dec.BypassReason = "no_visitor_id"
		return dec
	}
	if isPaidMemberBypass(cfg, in.PaidMemberTier) {
		dec.BypassReason = "paid_member"
		return dec
	}
	if !cfg.BlockSearchBots && IsSearchBotUserAgent(in.UserAgent) {
		dec.BypassReason = "search_bot"
		return dec
	}

	// Record the read and compute the visitor's bucket count for this
	// period. Idempotent on (tenant, visitor, campaign, period_started_at).
	count, err := r.recordMeteredRead(ctx, in.TenantID, in.CampaignID, in.VisitorID, periodStart, in.Now)
	if err != nil {
		// Fail-open on DB error — see method comment.
		return dec
	}
	dec.ReadCount = count
	// The "(quota+1)-th read" gates: visitor sees `quota` issues free,
	// then the next issue (count == quota+1) returns the paywall. Use
	// strict-greater so a visitor whose count equals quota still sees
	// the body on their final allowed issue.
	if count > cfg.Quota {
		dec.Allowed = false
	}
	return dec
}

// isPaidMemberBypass reports whether the supplied paid-member tier is
// good enough to bypass the meter for the configured tenant. The
// rules mirror the `podcast_required_tier` semantics from 0288:
//
//   - cfg.PaywallTier == ""  → ANY active paid tier bypasses.
//   - cfg.PaywallTier != ""  → the visitor's tier must match.
//   - holderTier == ""       → not a paid member, no bypass.
func isPaidMemberBypass(cfg MeteredPaywallConfig, holderTier string) bool {
	if holderTier == "" {
		return false
	}
	if cfg.PaywallTier == "" {
		return true
	}
	return strings.EqualFold(cfg.PaywallTier, holderTier)
}

// recordMeteredRead writes the (visitor, campaign, period) row + the
// denormalized per-visitor counter inside a tenant-scoped tx. Returns
// the visitor's POST-write count for the current period. Idempotent
// across repeat reads of the same issue in the same period.
//
// The write strategy is:
//
//  1. INSERT INTO anon_visitor_meter_reads ... ON CONFLICT DO NOTHING
//     — RowsAffected==1 means this is a NEW read for the visitor in
//     this period; 0 means a repeat that must NOT burn quota.
//  2. UPSERT anon_visitor_meter, bumping read_count by 1 only when the
//     reads insert was new. last_seen_at always updates.
//  3. SELECT read_count from the upserted row.
//
// All three statements share the same tenant tx so the visitor's
// bucket can't be partially written on a connection drop.
func (r *Repo) recordMeteredRead(ctx context.Context, tenantID, campaignID, visitorID string, periodStart, now time.Time) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
INSERT INTO anon_visitor_meter_reads
       (tenant_id, anon_visitor_id, campaign_id, period_started_at, first_read_at)
VALUES ($1::uuid, $2, $3::uuid, $4, $5)
ON CONFLICT (tenant_id, anon_visitor_id, campaign_id, period_started_at)
DO NOTHING`, tenantID, visitorID, campaignID, periodStart, now)
	if err != nil {
		return 0, err
	}
	newRead := tag.RowsAffected() == 1

	// Upsert the per-visitor bucket. We re-anchor period_started_at on
	// transition (read_count is reset to 1) so a stale bucket from a
	// previous period rolls over the first time the visitor reads in
	// the new period.
	//
	// Conditional bump: `read_count = CASE … END` only increments when
	// (period_started_at hasn't changed AND newRead). On period
	// rollover the count restarts at 1.
	delta := 0
	if newRead {
		delta = 1
	}
	_, err = tx.Exec(ctx, `
INSERT INTO anon_visitor_meter (tenant_id, anon_visitor_id, period_started_at, read_count, last_seen_at)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (tenant_id, anon_visitor_id) DO UPDATE SET
    period_started_at = CASE
        WHEN anon_visitor_meter.period_started_at = EXCLUDED.period_started_at
            THEN anon_visitor_meter.period_started_at
        ELSE EXCLUDED.period_started_at
    END,
    read_count = CASE
        WHEN anon_visitor_meter.period_started_at = EXCLUDED.period_started_at
            THEN anon_visitor_meter.read_count + $6
        ELSE $4
    END,
    last_seen_at = EXCLUDED.last_seen_at`,
		tenantID, visitorID, periodStart, delta, now, delta)
	if err != nil {
		return 0, err
	}

	var count int
	err = tx.QueryRow(ctx, `
SELECT read_count FROM anon_visitor_meter
 WHERE tenant_id = $1::uuid AND anon_visitor_id = $2`,
		tenantID, visitorID).Scan(&count)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return count, nil
}

// GetMeteredPaywallConfig reads the per-tenant config. Returns the
// zero-value MeteredPaywallConfig + nil error when no row exists
// (rather than ErrMeteredNotConfigured) so the hot Allow() path can
// treat "no config" identically to "quota=0 off".
func (r *Repo) GetMeteredPaywallConfig(ctx context.Context, tenantID string) (MeteredPaywallConfig, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return MeteredPaywallConfig{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		quota                                         int
		cadence, title, body, ctaLabel, ctaHref, tier string
		blockBots                                     bool
	)
	err = tx.QueryRow(ctx, `
SELECT quota, reset_cadence, paywall_title, paywall_body,
       paywall_cta_label, paywall_cta_href, paywall_tier,
       block_search_bots
  FROM tenant_metered_paywall
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(
		&quota, &cadence, &title, &body, &ctaLabel, &ctaHref, &tier, &blockBots,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// Treat "no row" as the zero-value (meter off) — see method comment.
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return MeteredPaywallConfig{}, commitErr
		}
		return MeteredPaywallConfig{ResetCadence: MeteredCadenceMonthly}, nil
	}
	if err != nil {
		return MeteredPaywallConfig{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MeteredPaywallConfig{}, err
	}
	return MeteredPaywallConfig{
		Quota:           quota,
		ResetCadence:    MeteredCadence(cadence),
		PaywallTitle:    title,
		PaywallBody:     body,
		PaywallCTALabel: ctaLabel,
		PaywallCTAHref:  ctaHref,
		PaywallTier:     tier,
		BlockSearchBots: blockBots,
	}, nil
}

// MeteredPaywallInput is the admin PUT body. All fields are optional —
// pointer fields distinguish "leave the column untouched" from "clear
// it" (empty string / zero). Mirrors the PATCH-style convention used
// by tenant_settings.go.
type MeteredPaywallInput struct {
	Quota           *int            `json:"quota,omitempty"`
	ResetCadence    *MeteredCadence `json:"reset_cadence,omitempty"`
	PaywallTitle    *string         `json:"paywall_title,omitempty"`
	PaywallBody     *string         `json:"paywall_body,omitempty"`
	PaywallCTALabel *string         `json:"paywall_cta_label,omitempty"`
	PaywallCTAHref  *string         `json:"paywall_cta_href,omitempty"`
	PaywallTier     *string         `json:"paywall_tier,omitempty"`
	BlockSearchBots *bool           `json:"block_search_bots,omitempty"`
}

// ErrInvalidMeteredCadence is returned when an admin PUT supplies a
// reset_cadence outside the allowed enum. Surfaced as 400 with a
// stable error code.
var ErrInvalidMeteredCadence = errors.New("archive: reset_cadence must be one of daily|weekly|monthly|yearly|never")

// ErrInvalidMeteredQuota is returned when an admin PUT supplies a
// quota outside [0, 1000]. Mirrors the DB CHECK constraint so the API
// rejects garbage before the DB does.
var ErrInvalidMeteredQuota = errors.New("archive: quota must be between 0 and 1000")

// UpsertMeteredPaywallConfig writes the per-tenant config row,
// creating it on first call. Pointer-field semantics from
// MeteredPaywallInput let callers PATCH a single column without
// stomping the rest.
func (r *Repo) UpsertMeteredPaywallConfig(ctx context.Context, tenantID string, in MeteredPaywallInput) error {
	if in.Quota != nil {
		if *in.Quota < 0 || *in.Quota > 1000 {
			return ErrInvalidMeteredQuota
		}
	}
	if in.ResetCadence != nil && !validMeteredCadence(*in.ResetCadence) {
		return ErrInvalidMeteredCadence
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Read existing row so PATCH semantics can preserve unspecified
	// columns. We INSERT ON CONFLICT DO UPDATE so first-write and
	// edit share one code path.
	cur, _, err := readMeteredConfigInTx(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	// Merge input on top of current row.
	if in.Quota != nil {
		cur.Quota = *in.Quota
	}
	if in.ResetCadence != nil {
		cur.ResetCadence = *in.ResetCadence
	}
	if in.PaywallTitle != nil {
		cur.PaywallTitle = *in.PaywallTitle
	}
	if in.PaywallBody != nil {
		cur.PaywallBody = *in.PaywallBody
	}
	if in.PaywallCTALabel != nil {
		cur.PaywallCTALabel = *in.PaywallCTALabel
	}
	if in.PaywallCTAHref != nil {
		cur.PaywallCTAHref = *in.PaywallCTAHref
	}
	if in.PaywallTier != nil {
		cur.PaywallTier = *in.PaywallTier
	}
	if in.BlockSearchBots != nil {
		cur.BlockSearchBots = *in.BlockSearchBots
	}
	if cur.ResetCadence == "" {
		cur.ResetCadence = MeteredCadenceMonthly
	}
	_, err = tx.Exec(ctx, `
INSERT INTO tenant_metered_paywall
    (tenant_id, quota, reset_cadence, paywall_title, paywall_body,
     paywall_cta_label, paywall_cta_href, paywall_tier, block_search_bots)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tenant_id) DO UPDATE SET
    quota             = EXCLUDED.quota,
    reset_cadence     = EXCLUDED.reset_cadence,
    paywall_title     = EXCLUDED.paywall_title,
    paywall_body      = EXCLUDED.paywall_body,
    paywall_cta_label = EXCLUDED.paywall_cta_label,
    paywall_cta_href  = EXCLUDED.paywall_cta_href,
    paywall_tier      = EXCLUDED.paywall_tier,
    block_search_bots = EXCLUDED.block_search_bots`,
		tenantID, cur.Quota, string(cur.ResetCadence), cur.PaywallTitle,
		cur.PaywallBody, cur.PaywallCTALabel, cur.PaywallCTAHref, cur.PaywallTier,
		cur.BlockSearchBots)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// readMeteredConfigInTx returns the current row + a boolean indicating
// whether one existed. Used by UpsertMeteredPaywallConfig to preserve
// unspecified columns on PATCH. Sharing the tx avoids a read-modify-
// write race with a concurrent edit.
func readMeteredConfigInTx(ctx context.Context, tx pgx.Tx, tenantID string) (MeteredPaywallConfig, bool, error) {
	var (
		quota                                         int
		cadence, title, body, ctaLabel, ctaHref, tier string
		blockBots                                     bool
	)
	err := tx.QueryRow(ctx, `
SELECT quota, reset_cadence, paywall_title, paywall_body,
       paywall_cta_label, paywall_cta_href, paywall_tier,
       block_search_bots
  FROM tenant_metered_paywall
 WHERE tenant_id = $1::uuid
 LIMIT 1`, tenantID).Scan(
		&quota, &cadence, &title, &body, &ctaLabel, &ctaHref, &tier, &blockBots,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return MeteredPaywallConfig{ResetCadence: MeteredCadenceMonthly}, false, nil
	}
	if err != nil {
		return MeteredPaywallConfig{}, false, err
	}
	return MeteredPaywallConfig{
		Quota:           quota,
		ResetCadence:    MeteredCadence(cadence),
		PaywallTitle:    title,
		PaywallBody:     body,
		PaywallCTALabel: ctaLabel,
		PaywallCTAHref:  ctaHref,
		PaywallTier:     tier,
		BlockSearchBots: blockBots,
	}, true, nil
}

// ResetExpiredMeterBuckets is the worker-friendly housekeeping entry
// point. Deletes anon_visitor_meter rows whose period_started_at is
// older than `cutoff` AND whose cadence (read via the join with
// tenant_metered_paywall) is NOT 'never'. The Allow() path is
// self-healing on stale rows (it re-anchors the bucket on next read),
// so this routine only exists to bound storage growth.
//
// Returns the number of rows deleted from each table — useful for an
// operator-visible metric. Tenant-scoped lookups: the caller passes
// `tenantID` so the worker can iterate tenants one at a time.
func (r *Repo) ResetExpiredMeterBuckets(ctx context.Context, tenantID string, cutoff time.Time) (meterRows, readRows int64, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM anon_visitor_meter
 WHERE tenant_id = $1::uuid AND period_started_at < $2`, tenantID, cutoff)
	if err != nil {
		return 0, 0, err
	}
	meterRows = tag.RowsAffected()
	tag, err = tx.Exec(ctx, `
DELETE FROM anon_visitor_meter_reads
 WHERE tenant_id = $1::uuid AND period_started_at < $2`, tenantID, cutoff)
	if err != nil {
		return 0, 0, err
	}
	readRows = tag.RowsAffected()
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return meterRows, readRows, nil
}

// ApplyMeteredPaywall is the renderer-side helper. Given a (possibly
// gated) MeteredDecision + the full HTMLBody, returns the body the
// public response should serialise:
//
//   - dec.Allowed == true → body untouched.
//   - dec.Allowed == false → above-fold teaser only + a small inline
//     paywall card so non-Moosewave clients (RSS readers, integrations)
//     still see something sensible. The richer card is rendered by
//     the frontend using the MeteredPaywallActive/Locked JSON fields.
//
// Mirrors ApplySubscribeWall's contract so the public handler has a
// consistent shape.
func ApplyMeteredPaywall(body string, cfg MeteredPaywallConfig, dec MeteredDecision) string {
	if dec.Allowed {
		return body
	}
	// Generate a short above-fold teaser by truncating at ~600 chars.
	// We don't try to be smart about paragraph boundaries — the
	// frontend overlay is what reads, this is just the fallback
	// payload for integrations.
	const teaserCharBudget = 600
	teaser := body
	if len(teaser) > teaserCharBudget {
		teaser = teaser[:teaserCharBudget] + "…"
	}
	title := cfg.PaywallTitle
	if title == "" {
		title = "You've reached your free article limit"
	}
	cta := cfg.PaywallCTALabel
	if cta == "" {
		cta = "Subscribe to keep reading"
	}
	href := cfg.PaywallCTAHref
	if href == "" {
		href = "#"
	}
	return teaser + `<aside data-pw-paywall="metered" class="pw-archive-metered-paywall">` +
		`<p><strong>` + htmlEscape(title) + `</strong></p>` +
		`<p>` + htmlEscape(cfg.PaywallBody) + `</p>` +
		`<a href="` + htmlEscape(href) + `" class="pw-archive-metered-cta">` + htmlEscape(cta) + `</a>` +
		`</aside>`
}

// htmlEscape is a tiny stand-in that escapes the four characters that
// can break out of an HTML element context. Used only by
// ApplyMeteredPaywall for the inline teaser-fallback card — the
// frontend renderer doesn't run through this path. Inlined rather than
// pulling in html/template to keep this file allocation-light.
func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

// ExtractVisitorID returns the anon_visitor_id this request maps to.
// Delegates to DailyVisitorID so the metered paywall and the
// view-pixel path agree on the same identity-hash for each visitor —
// keyed on (clientIP, User-Agent, UTC day, salt). The hash rotates
// daily so a stored visitor row can't be re-identified after the salt
// changes.
//
// trustHeaders MUST be bound to cfg.TrustForwardedIPHeaders at the
// handler call site — never passed true unconditionally. See
// DailyVisitorID for the spoofing threat model.
//
// Returned value is the same 16-byte hex (32 char) shape the
// archive_views path stores in anon_visitor_id. Returns "" only when
// the caller couldn't determine a client IP at all, which is rare
// behind a real CDN / reverse proxy.
func ExtractVisitorID(r *http.Request, trustHeaders bool) string {
	id := DailyVisitorID(r, trustHeaders)
	// Defensive shape check — DailyVisitorID always returns 16 chars
	// in normal operation, but we'd rather treat a degenerate value
	// as "no visitor" than write a malformed row.
	if len(id) < 16 || len(id) > 128 {
		return ""
	}
	return id
}
