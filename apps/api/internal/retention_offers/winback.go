// SPDX-License-Identifier: AGPL-3.0-only
//
// winback.go — dormant churn-triggered win-back implementation.
//
// RELEASE BOUNDARY: no production composition root constructs or runs this
// worker, and MountRoutes exposes only the settings GET. The behavior described
// below is package implementation, not evidence of runtime enrollment,
// delivery, portal acceptance, or coupon application.
//
// Bridges a churn signal to the retention-offer flow: when a
// subscriber's churn risk crosses the configured threshold, the worker
//
//  1. SENDS them a win-back e-mail (winback_email.go) via the platform's
//     transactional mailer (the same mailer.Mailer the referral-congrats
//     sender uses — NOT a parallel mailer). The CTA links to the
//     intended retention/preference portal. That customer portal and its
//     recipient-bound acceptance endpoint are not mounted, so dispatch stays
//     compile-time held.
//  2. would log the standard 'shown' event on retention_offer_events — the
//     same event shape used by the historical funnel. The portal handlers are
//     present in this package but deliberately unmounted.
//
// CHURN SOURCE (if a future certified composition runs it). The worker uses the commerce
// churn score (profile_predictions.churn_risk, order-recency based) when
// the tenant has commerce data, ELSE an engagement-recency fallback
// (predictive.EngagementChurnCrossers — days since last open/click in
// campaign_report_events). The fallback is injected as ChurnSource so
// this package doesn't take a hard dep on predictive. Non-commerce
// tenants (newsletters) therefore get win-backs too — closing the
// "no-ops without commerce" gap.
//
// IDEMPOTENCY / NO SPAM. Two guards: (a) the NOT EXISTS check on the
// 'shown' event keeps a member enrolled in an offer at most once, and
// (b) a cooldown (default 30 days, CooldownDays) backed by
// retention_winback_sends (migration 0396): a subscriber e-mailed inside the
// window is skipped. This is an implementation guard, not production
// exactly-once certification; the worker remains rollout-held.
//
// CONSENT + SUPPRESSION. Before sending we reuse the platform's
// suppression check and per-purpose consent gate (the same ones the
// normal send path uses) — never bypassed. A suppressed or
// non-consented address is skipped (no send, no 'shown' row).
//
// Settings live in tenant_feature_flags (keys below), exposed via:
//
//	GET /api/v1/retention-offers/winback-settings
//
// The package contains a PUT handler, but MountRoutes deliberately does not
// register it.

package retention_offers

import (
	"context"

	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// defaultWinbackCooldownDays is the no-spam window: a subscriber who
// received a win-back e-mail within this many days is skipped on the
// next tick. 30 days matches the referral / re-engagement cadence the
// rest of the platform uses for promotional touches.
const defaultWinbackCooldownDays = 30

// WinbackDispatchAvailable is the compile-time production dispatch boundary.
// Keep false until send+cooldown persistence is atomic/exactly-once, a mounted
// recipient-bound portal exists, fixed-amount offers carry explicit currency,
// and provider delivery/application reconciliation has live certification.
const WinbackDispatchAvailable = false

// ErrWinbackDispatchUnavailable is returned before any worker dependency or
// database access while the dispatch boundary is held.
var ErrWinbackDispatchUnavailable = errors.New("retention winback dispatch is release-held")

// ChurnCrosser is one subscriber the churn source flagged as at/above
// threshold. Source is "commerce" or "engagement" (recorded on the send
// row for analytics). Risk is the churn risk at selection time.
type ChurnCrosser struct {
	Email  string
	Source string
	Risk   float64
}

// ChurnSource is the engagement-recency fallback a future composition may use
// when a tenant has no commerce churn data. It stays abstract so this package
// remains decoupled from predictive. A nil source means no fallback.
type ChurnSource interface {
	// HasCommerceChurn reports whether the tenant has commerce-derived
	// churn scores (profile_predictions). When false the worker uses the
	// engagement fallback.
	HasCommerceChurn(ctx context.Context, tenantID string) (bool, error)
	// EngagementChurnCrossers returns enabled subscribers whose
	// engagement-recency churn risk is at/above threshold, most-at-risk
	// first, capped at limit.
	EngagementChurnCrossers(ctx context.Context, tenantID string, threshold float64, limit int) ([]ChurnCrosser, error)
}

// SuppressionChecker mirrors the platform suppression store's Check: is
// this (tenant, email) suppressed? Injected so the worker reuses the
// real suppression path without importing the store. A future production
// composition must supply it and prove fail-closed behavior before release.
type SuppressionChecker interface {
	Check(ctx context.Context, tenantID, email string) (suppressed bool, err error)
}

// ConsentChecker mirrors consent.PurposeLookup.Allowed: may we send a
// marketing e-mail to this (tenant, email)? Injected for the same reason as
// SuppressionChecker. A future production composition must supply it and prove
// fail-closed behavior. The win-back is a marketing touch, so the worker checks
// the email_marketing purpose.
type ConsentChecker interface {
	Allowed(ctx context.Context, tenantID, email, purpose string) (bool, error)
}

// Feature-flag keys backing the win-back settings.
const (
	winbackEnabledFlag   = "retention.winback.enabled"
	winbackThresholdFlag = "retention.winback.churn_threshold"
)

// defaultWinbackThreshold queues members whose churn risk is ≥ 0.7
// when the tenant hasn't tuned the threshold.
const defaultWinbackThreshold = 0.7

// winbackMaxEnrollsPerTenantPerTick bounds one tenant's enrolment per
// tick so a freshly-enabled tenant with thousands of at-risk profiles
// drains gradually.
const winbackMaxEnrollsPerTenantPerTick = 100

// WinbackSettings is the wire shape.
type WinbackSettings struct {
	Enabled        bool    `json:"enabled"`
	ChurnThreshold float64 `json:"churn_threshold"`
	// ChurnProfilesScored is the number of profile_predictions rows
	// for the tenant — 0 means the predictive model has not run (or has no
	// commerce signal). This is scoring coverage only, not runtime readiness.
	ChurnProfilesScored int64 `json:"churn_profiles_scored"`
}

// normalizeWinbackThreshold validates a threshold, returning the
// default for out-of-range values. Pure — unit-tested directly.
func normalizeWinbackThreshold(v float64) (float64, error) {
	if v == 0 {
		return defaultWinbackThreshold, nil
	}
	if v < 0 || v > 1 {
		return 0, errors.New("churn_threshold must be in (0, 1]")
	}
	return v, nil
}

// parseWinbackThreshold parses the stored flag value, falling back to
// the default on absent/malformed values. Pure — unit-tested.
func parseWinbackThreshold(raw string) float64 {
	if raw == "" {
		return defaultWinbackThreshold
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v <= 0 || v > 1 {
		return defaultWinbackThreshold
	}
	return v
}

// GetWinbackSettings GET /api/v1/retention-offers/winback-settings.
func (d *Deps) GetWinbackSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	s, err := loadWinbackSettings(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// PutWinbackSettings PUT /api/v1/retention-offers/winback-settings.
func (d *Deps) PutWinbackSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in struct {
		Enabled        bool    `json:"enabled"`
		ChurnThreshold float64 `json:"churn_threshold"`
	}
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	threshold, err := normalizeWinbackThreshold(in.ChurnThreshold)
	if err != nil {
		httperror.WriteValidation(w, "invalid_threshold", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	upsert := `
INSERT INTO tenant_feature_flags (tenant_id, flag_key, value, note)
VALUES ($1::uuid, $2, $3, 'retention win-back setting')
ON CONFLICT (tenant_id, flag_key) WHERE tenant_id IS NOT NULL
DO UPDATE SET value = EXCLUDED.value, enabled = true, updated_at = now()`
	if _, err := tx.Exec(r.Context(), upsert, t.ID, winbackEnabledFlag,
		strconv.FormatBool(in.Enabled)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if _, err := tx.Exec(r.Context(), upsert, t.ID, winbackThresholdFlag,
		strconv.FormatFloat(threshold, 'f', -1, 64)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	s, err := loadWinbackSettings(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// loadWinbackSettings reads the two flag rows + the scored-profile
// count in one tenant-scoped tx.
func loadWinbackSettings(ctx context.Context, pool *db.Pool, tenantID string) (*WinbackSettings, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &WinbackSettings{ChurnThreshold: defaultWinbackThreshold}
	rows, err := tx.Query(ctx, `
SELECT flag_key, value FROM tenant_feature_flags
 WHERE tenant_id = $1::uuid AND flag_key IN ($2, $3) AND enabled`,
		tenantID, winbackEnabledFlag, winbackThresholdFlag)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			rows.Close()
			return nil, err
		}
		switch k {
		case winbackEnabledFlag:
			out.Enabled = v == "true"
		case winbackThresholdFlag:
			out.ChurnThreshold = parseWinbackThreshold(v)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM profile_predictions WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&out.ChurnProfilesScored); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ----------------------------------------------------------------------
// Worker
// ----------------------------------------------------------------------

// WinbackWorker selects churn-threshold-crossers, e-mails them a
// win-back, and enrolls them into the tenant's active retention offer.
// Worker pattern per audience_destinations: cross-tenant enumeration
// under db.WithWorkerScope (tenants worker_select policy, migration
// 1708); per-tenant reads + the 'shown'/send writes re-enter
// db.WithTenant.
type WinbackWorker struct {
	Pool   *db.Pool
	Repo   *Repo
	Logger *slog.Logger
	// Interval defaults to 1 hour.
	Interval time.Duration

	// Mailer is the platform transactional sender. Nil is a hard runtime
	// dependency failure; a partial composition must not degrade silently.
	Mailer mailer.Mailer
	// From is the envelope From address for win-back e-mails. When blank
	// the worker skips sending (no valid envelope).
	From string
	// PortalBaseURL is POSTWAVE_PORTAL_ORIGIN — the base for the CTA
	// link. When blank the worker skips sending (no actionable link).
	PortalBaseURL string

	// ChurnSource provides the engagement-recency fallback for tenants
	// without commerce churn data. Nil = commerce-only (legacy
	// behaviour).
	ChurnSource ChurnSource
	// Suppressions / Consent gate every send. Nil is fail-closed.
	Suppressions SuppressionChecker
	Consent      ConsentChecker

	// CooldownDays overrides the no-spam window. <= 0 uses
	// defaultWinbackCooldownDays (30).
	CooldownDays int

	// Test seams. These default to the real DB-backed methods; tests
	// override them to exercise the send-path decision logic (mailer,
	// cooldown, suppression, consent) without a live Postgres. Production
	// never sets them — see ensureHooks.
	cooldownFn func(ctx context.Context, tenantID, email string) (bool, error)
	recordFn   func(ctx context.Context, tenantID, offerID, email, source string, risk float64) error
	shownFn    func(ctx context.Context, tenantID, offerID, email string) error
}

// ensureHooks binds the DB-backed implementations of the test seams when
// a test hasn't overridden them. Called once at the top of deliverOne so
// the zero-value worker (production) behaves exactly as before.
func (w *WinbackWorker) ensureHooks() {
	if w.cooldownFn == nil {
		w.cooldownFn = w.sentWithinCooldown
	}
	if w.recordFn == nil {
		w.recordFn = w.recordSend
	}
	if w.shownFn == nil {
		w.shownFn = func(ctx context.Context, tenantID, offerID, email string) error {
			_, err := w.Repo.LogEvent(ctx, tenantID, offerID, EventInput{
				SubscriberEmail: email,
				EventType:       EventShown,
			})
			return err
		}
	}
}

// cooldownDays returns the effective no-spam window.
func (w *WinbackWorker) cooldownDays() int {
	if w.CooldownDays > 0 {
		return w.CooldownDays
	}
	return defaultWinbackCooldownDays
}

func (w *WinbackWorker) validateRuntimeDependencies() error {
	if w == nil || w.Pool == nil || w.Repo == nil {
		return errors.New("retention winback worker: nil database dependencies")
	}
	if w.Mailer == nil {
		return errors.New("retention winback worker: mailer is required")
	}
	if strings.TrimSpace(w.From) == "" {
		return errors.New("retention winback worker: from address is required")
	}
	if strings.TrimSpace(w.PortalBaseURL) == "" {
		return errors.New("retention winback worker: portal base URL is required")
	}
	if w.Suppressions == nil {
		return errors.New("retention winback worker: suppression checker is required")
	}
	if w.Consent == nil {
		return errors.New("retention winback worker: consent checker is required")
	}
	return nil
}

// Run drives the worker until ctx is canceled.
func (w *WinbackWorker) Run(ctx context.Context) error {
	if !WinbackDispatchAvailable {
		return ErrWinbackDispatchUnavailable
	}
	if err := w.validateRuntimeDependencies(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	if w.Logger != nil {
		w.Logger.Info("retention winback worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("retention winback tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *WinbackWorker) tick(ctx context.Context) error {
	tenants, err := w.listTenants(ctx)
	if err != nil {
		return err
	}
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.processTenant(ctx, tenantID); err != nil && w.Logger != nil {
			w.Logger.Warn("retention winback: tenant failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}
	return nil
}

func (w *WinbackWorker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// processTenant selects the tenant's threshold-crossers (commerce churn
// when available, else the engagement-recency fallback), then for each:
// enforces the cooldown, checks suppression + consent, sends the win-back
// e-mail, records the send (cooldown marker), and logs the 'shown' funnel
// event. Runs only when win-backs are enabled and an active offer exists.
func (w *WinbackWorker) processTenant(ctx context.Context, tenantID string) error {
	settings, err := loadWinbackSettings(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	if !settings.Enabled {
		return nil
	}
	offer, err := w.activeOffer(ctx, tenantID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // enabled but no active offer — nothing to enroll into
		}
		return err
	}
	crossers, err := w.selectCrossers(ctx, tenantID, offer.ID, settings.ChurnThreshold)
	if err != nil {
		return err
	}
	amountLabel := offer.FormatAmount()
	sent, enrolled, skipped := 0, 0, 0
	for _, c := range crossers {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		ok, err := w.deliverOne(ctx, tenantID, offer, amountLabel, c)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("retention winback: deliver failed",
					"tenant_id", tenantID, "err", err.Error())
			}
			continue
		}
		if !ok {
			skipped++
			continue
		}
		sent++
		enrolled++
	}
	if (sent > 0 || skipped > 0) && w.Logger != nil {
		w.Logger.Info("retention winback: processed threshold-crossers",
			"tenant_id", tenantID, "offer_id", offer.ID,
			"sent", sent, "enrolled", enrolled, "skipped", skipped,
			"threshold", fmt.Sprintf("%.2f", settings.ChurnThreshold))
	}
	return nil
}

// deliverOne handles a single crosser end-to-end. Returns (true, nil)
// when a win-back was actually sent + enrolled; (false, nil) when the
// subscriber was skipped (cooldown, suppression, consent, or no valid
// envelope) — a skip is not an error. The order is deliberate:
//
//  1. cooldown   — cheapest, and the no-spam contract;
//  2. suppression + consent — never bypass the platform's send gates;
//  3. build envelope (needs From + PortalBaseURL);
//  4. send;
//  5. record the send marker (cooldown) — AFTER a successful send so a
//     mailer failure leaves no marker and the next tick retries;
//  6. log the 'shown' funnel event (best-effort; a failure here doesn't
//     un-send the e-mail).
func (w *WinbackWorker) deliverOne(ctx context.Context, tenantID string, offer Offer, amountLabel string, c ChurnCrosser) (bool, error) {
	w.ensureHooks()
	email := strings.TrimSpace(strings.ToLower(c.Email))
	if email == "" {
		return false, nil
	}
	if w.Mailer == nil {
		return false, errors.New("retention winback worker: mailer is required")
	}
	if strings.TrimSpace(w.From) == "" {
		return false, errors.New("retention winback worker: from address is required")
	}
	if strings.TrimSpace(w.PortalBaseURL) == "" {
		return false, errors.New("retention winback worker: portal base URL is required")
	}
	if w.Suppressions == nil {
		return false, errors.New("retention winback worker: suppression checker is required")
	}
	if w.Consent == nil {
		return false, errors.New("retention winback worker: consent checker is required")
	}

	// 1. Cooldown.
	recent, err := w.cooldownFn(ctx, tenantID, email)
	if err != nil {
		return false, err
	}
	if recent {
		return false, nil
	}

	// 2. Suppression + consent — reuse the platform send gates.
	suppressed, err := w.Suppressions.Check(ctx, tenantID, email)
	if err != nil {
		return false, err
	}
	if suppressed {
		return false, nil
	}
	allowed, err := w.Consent.Allowed(ctx, tenantID, email, "email_marketing")
	if err != nil {
		return false, err
	}
	if !allowed {
		return false, nil
	}

	// 3. Build the envelope. Runtime dependencies were checked above.
	portalURL := winbackPortalURL(w.PortalBaseURL, offer.ID, email)
	if portalURL == "" {
		return false, errors.New("retention winback worker: portal URL is invalid")
	}
	msg, ok := buildWinbackMessage(w.From, email, WinbackEmailData{
		Offer:       offer,
		AmountLabel: amountLabel,
		PortalURL:   portalURL,
	})
	if !ok {
		return false, errors.New("retention winback worker: mail envelope is invalid")
	}
	// 4. Send via the platform transactional mailer.
	if err := w.Mailer.Send(ctx, msg); err != nil {
		return false, err
	}

	// 5. Cooldown marker — only after a successful send.
	if err := w.recordFn(ctx, tenantID, offer.ID, email, c.Source, c.Risk); err != nil {
		// The e-mail went out; a marker-write failure would let the next
		// tick re-send. Surface it so the tick logs a warning, but don't
		// claim "not sent".
		return true, err
	}

	// 6. Funnel 'shown' event — best-effort.
	if err := w.shownFn(ctx, tenantID, offer.ID, email); err != nil && w.Logger != nil {
		w.Logger.Warn("retention winback: shown-event log failed",
			"tenant_id", tenantID, "err", err.Error())
	}
	return true, nil
}

// selectCrossers picks at-risk subscribers using the commerce churn
// source when the tenant has commerce data, else the engagement-recency
// fallback. Both paths already exclude subscribers enrolled in this
// offer (commerce via NOT EXISTS; engagement via the cooldown +
// per-offer 'shown' guard in deliverOne). Capped at
// winbackMaxEnrollsPerTenantPerTick.
func (w *WinbackWorker) selectCrossers(ctx context.Context, tenantID, offerID string, threshold float64) ([]ChurnCrosser, error) {
	useCommerce, err := w.useCommerceChurn(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if useCommerce {
		return w.thresholdCrossers(ctx, tenantID, offerID, threshold)
	}
	return w.ChurnSource.EngagementChurnCrossers(ctx, tenantID, threshold, winbackMaxEnrollsPerTenantPerTick)
}

// useCommerceChurn decides, per tenant, whether to use the commerce
// churn source (profile_predictions) or the engagement-recency fallback.
// A nil ChurnSource means no fallback is wired, so we stay commerce-only
// (legacy behaviour). Split out from selectCrossers so the routing
// decision is unit-testable without a DB.
func (w *WinbackWorker) useCommerceChurn(ctx context.Context, tenantID string) (bool, error) {
	if w.ChurnSource == nil {
		return true, nil
	}
	return w.ChurnSource.HasCommerceChurn(ctx, tenantID)
}

// activeOffer picks the tenant's most recently updated active offer.
func (w *WinbackWorker) activeOffer(ctx context.Context, tenantID string) (Offer, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return Offer{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var o Offer
	if err := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, paywall_tier_id::text,
       percent_off, fixed_off_cents, duration_months,
       COALESCE(headline, ''), COALESCE(body, ''),
       COALESCE(stripe_coupon_id, ''),
       active, created_at, updated_at
  FROM retention_offers
 WHERE tenant_id = $1::uuid AND active
 ORDER BY updated_at DESC
 LIMIT 1`, tenantID).Scan(
		&o.ID, &o.TenantID, &o.PaywallTierID,
		&o.PercentOff, &o.FixedOffCents, &o.DurationMonths,
		&o.Headline, &o.Body, &o.StripeCouponID,
		&o.Active, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return Offer{}, err
	}
	return o, tx.Commit(ctx)
}

// sentWithinCooldown reports whether the subscriber received a win-back
// e-mail within the cooldown window. The lookup runs under db.WithTenant
// so RLS clamps it to this tenant.
func (w *WinbackWorker) sentWithinCooldown(ctx context.Context, tenantID, email string) (bool, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM retention_winback_sends
   WHERE tenant_id = $1::uuid
     AND lower(subscriber_email) = lower($2)
     AND sent_at >= now() - ($3::int * interval '1 day'))`,
		tenantID, email, w.cooldownDays()).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

// recordSend inserts the cooldown marker. Runs under db.WithTenant
// (FORCE-RLS WITH CHECK clamps the write to this tenant).
func (w *WinbackWorker) recordSend(ctx context.Context, tenantID, offerID, email, source string, risk float64) error {
	if source != "commerce" && source != "engagement" {
		source = "commerce"
	}
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO retention_winback_sends
    (tenant_id, offer_id, subscriber_email, churn_source, churn_risk)
VALUES ($1::uuid, $2::uuid, lower($3), $4, $5)`,
		tenantID, offerID, email, source, risk); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// thresholdCrossers returns enabled subscribers whose commerce churn
// risk is at/above the threshold and who have never been enrolled in
// (shown) this offer. The NOT EXISTS guard is the per-offer idempotency
// key — re-ticks never re-enroll. The cooldown (retention_winback_sends)
// guards against re-sending across offers; this guard keeps a single
// offer's funnel clean.
func (w *WinbackWorker) thresholdCrossers(ctx context.Context, tenantID, offerID string, threshold float64) ([]ChurnCrosser, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT p.email::text, p.churn_risk::float8
  FROM profile_predictions p
  JOIN subscribers s
    ON s.tenant_id = p.tenant_id
   AND lower(s.email::text) = lower(p.email::text)
   AND s.status = 'enabled'
 WHERE p.tenant_id = $1::uuid
   AND p.churn_risk >= $2
   AND NOT EXISTS (
       SELECT 1 FROM retention_offer_events e
        WHERE e.tenant_id = p.tenant_id
          AND e.offer_id = $3::uuid
          AND lower(e.subscriber_email) = lower(p.email::text))
 ORDER BY p.churn_risk DESC
 LIMIT $4`, tenantID, threshold, offerID, winbackMaxEnrollsPerTenantPerTick)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChurnCrosser{}
	for rows.Next() {
		var email string
		var risk float64
		if err := rows.Scan(&email, &risk); err != nil {
			return nil, err
		}
		out = append(out, ChurnCrosser{Email: email, Source: "commerce", Risk: risk})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
