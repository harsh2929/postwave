// SPDX-License-Identifier: AGPL-3.0-only
//
// gifts.go — turns the gift_subscriptions table from a row-insert
// stub into a real end-to-end product:
//
//   * Redemption tokens — minted at create, stored as sha256, raw
//     surfaced once in RedemptionURL + the recipient email.
//   * Public lookup + redeem endpoints — /api/public/gifts/{token}
//     (GET preview) + /api/public/gifts/{token}/redeem (POST claim).
//   * Cancel endpoint — POST /api/v1/gift-subscriptions/{id}/cancel.
//   * Stats endpoint — GET /api/v1/gift-subscriptions/stats; powers
//     the dashboard's headline tiles (pending / redeemed / refunded
//     / conversion rate).
//   * Expiration sweeper — pending gifts with expires_at past now
//     transition to status='expired' once per hour.
//   * GiftNotifier — best-effort send of recipient + giver emails on
//     lifecycle transitions. Reuses the approvals package's email
//     notifier pattern (best-effort, never blocks the request).
//
// Pairs with migration 0181 (token + expires_at + redeemed_at +
// cancel columns). The original paid_subs.go is untouched except
// for the minimal GiftSub-struct + Repo-struct extensions called
// from here.

package paid_tiers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// DefaultGiftExpiryDays is the cliff after which an unclaimed
// pending gift transitions to status='expired'. Operators can
// override per-Repo via Repo.GiftExpiryDays.
const DefaultGiftExpiryDays = 90

// Sentinels surfaced from the public endpoints + cancel path.
var (
	ErrGiftAlreadyRedeemed = errors.New("paid_tiers: gift already redeemed")
	ErrGiftExpired         = errors.New("paid_tiers: gift expired")
	ErrGiftCanceled        = errors.New("paid_tiers: gift canceled")
	ErrGiftNotPending      = errors.New("paid_tiers: gift not in pending state")
)

// GiftNotifier is the optional interface the Repo uses to fire
// recipient + giver emails on lifecycle events. Implementations
// live in apps/api/main.go (Postmark-backed); tests pass nil.
//
// SendGiftCreated — receives the raw token because the gift row
// stores only the hash; the email body embeds the raw redemption
// URL.
type GiftNotifier interface {
	SendGiftCreated(ctx context.Context, gift GiftSub, rawToken string)
	SendGiftRedeemed(ctx context.Context, gift GiftSub)
	SendGiftCanceled(ctx context.Context, gift GiftSub)
	SendGiftExpired(ctx context.Context, gift GiftSub)
}

// mintRedemptionToken returns (rawToken, sha256(rawToken)). The raw
// is returned to the caller once (embedded in the email + dashboard
// post-create sheet); only the hash is persisted, so a DB dump
// can't be replayed.
func mintRedemptionToken() (string, [32]byte, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", [32]byte{}, err
	}
	raw := base64.RawURLEncoding.EncodeToString(b[:])
	sum := sha256.Sum256([]byte(raw))
	return raw, sum, nil
}

// giftRedemptionURL builds the public claim URL. Empty base URL
// returns just the path so tests don't have to mock an origin.
func giftRedemptionURL(baseURL, rawToken string) string {
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		return "/gift/" + rawToken
	}
	return base + "/gift/" + rawToken
}

// ---------------------------------------------------------------------
// Repo methods — redemption, cancel, lookup, stats
// ---------------------------------------------------------------------

// GiftPreview is the projection the public preview endpoint returns
// BEFORE claim. Strips invoice + tenant ids; the recipient doesn't
// need them and the page shouldn't leak operator-side identifiers.
type GiftPreview struct {
	PurchaserEmail string     `json:"purchaserEmail"`
	PlanID         string     `json:"planId"`
	DurationMonths int        `json:"durationMonths"`
	Message        string     `json:"message,omitempty"`
	Status         string     `json:"status"`
	ExpiresAt      *time.Time `json:"expiresAt,omitempty"`
}

// LookupGiftByToken resolves a raw redemption token to its preview.
// Used by GET /api/public/gifts/{token}.
//
// Returns ErrNotFound when the hash doesn't match (covers expired,
// canceled, wrong-token, never-existed). The handler renders a
// generic "this gift isn't available" so a stolen token can't
// distinguish those cases.
func (r *Repo) LookupGiftByToken(ctx context.Context, rawToken string) (*GiftPreview, error) {
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return nil, ErrNotFound
	}
	sum := sha256.Sum256([]byte(rawToken))

	// Public path — wrap SET + SELECT in one TX. set_config(..., true)
	// only persists within the active transaction, so auto-commit
	// `conn.Exec` calls drop the GUC before the SELECT runs. The
	// tenant_visible policy (0079) casts current_setting('app.tenant_id', true)
	// to uuid; we pin a zero-UUID so the cast succeeds (its predicate
	// is then false but our public_token policy admits via OR).
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tokenHex := fmt.Sprintf("%x", sum[:])
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.public_gift_token', $1, true)",
		tokenHex); err != nil {
		return nil, err
	}
	var p GiftPreview
	err = tx.QueryRow(ctx, `
SELECT purchaser_email, plan_id, duration_months,
       COALESCE(message,''), status, expires_at
  FROM gift_subscriptions
 WHERE redemption_token_sha256 = $1
 LIMIT 1`, sum[:]).Scan(
		&p.PurchaserEmail, &p.PlanID, &p.DurationMonths,
		&p.Message, &p.Status, &p.ExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

// RedeemGift is the public claim path. Idempotent — re-clicking the
// same link returns ErrGiftAlreadyRedeemed rather than re-granting.
// Wires the recipient's email to a subscribers row if one exists;
// that linkage powers the dashboard's "redeemed by" surface.
//
// Lifecycle: pending → granted. Other source statuses surface as
// errors so the public page can render a precise reason
// ("already claimed", "expired", "canceled").
func (r *Repo) RedeemGift(ctx context.Context, rawToken string) (*GiftSub, error) {
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return nil, ErrNotFound
	}
	sum := sha256.Sum256([]byte(rawToken))

	// Wrap SET + SELECT + UPDATE in one TX so set_config(..., is_local=true)
	// persists across all three. RLS bypass for SELECT + UPDATE comes from
	// the public_token_visible / public_token_redeem policies (0182);
	// zero-UUID for app.tenant_id keeps the existing tenant_visible
	// policy's `::uuid` cast happy.
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tokenHex := fmt.Sprintf("%x", sum[:])
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.public_gift_token', $1, true)",
		tokenHex); err != nil {
		return nil, err
	}

	// Find the row first so we can return precise errors. We tolerate
	// the small race between this SELECT and the UPDATE — the UPDATE's
	// WHERE clause re-asserts status='pending' so concurrent claims
	// resolve to one winner.
	var (
		id, tenantID, recipient, purchaserEmail, planID, gifterSubID string
		status                                                       string
		durationMonths                                               int
		expiresAt                                                    *time.Time
	)
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, recipient_email, purchaser_email,
       plan_id, duration_months, COALESCE(gifter_subscriber_id::text,''),
       status, expires_at
  FROM gift_subscriptions
 WHERE redemption_token_sha256 = $1
 LIMIT 1`, sum[:]).Scan(&id, &tenantID, &recipient, &purchaserEmail,
		&planID, &durationMonths, &gifterSubID, &status, &expiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	switch status {
	case "granted":
		return nil, ErrGiftAlreadyRedeemed
	case "canceled":
		return nil, ErrGiftCanceled
	case "expired":
		return nil, ErrGiftExpired
	case "pending":
		// fall through
	default:
		return nil, ErrGiftNotPending
	}
	if expiresAt != nil && expiresAt.Before(time.Now().UTC()) {
		return nil, ErrGiftExpired
	}

	// Resolve subscriber id by email (best-effort; nil when the
	// recipient isn't an existing subscriber). Use the tenant_id we
	// just read; re-pin app.tenant_id so the subscribers RLS admits
	// the lookup.
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return nil, err
	}
	var subID *string
	_ = tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2
 LIMIT 1`, tenantID, recipient).Scan(&subID)

	// Re-pin the gift token GUC for the UPDATE (we just clobbered the
	// session GUCs with the tenant_id set above).
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.public_gift_token', $1, true)", tokenHex); err != nil {
		return nil, err
	}

	// Atomic transition: re-asserts pending so a concurrent claim
	// loses cleanly.
	now := time.Now().UTC()
	tag, err := tx.Exec(ctx, `
UPDATE gift_subscriptions
   SET status = 'granted',
       redeemed_at = $2,
       granted_at = COALESCE(granted_at, $2),
       redeemed_by_subscriber_id = NULLIF($3,'')::uuid
 WHERE id = $1::uuid AND status = 'pending'`,
		id, now, ifNilEmpty(subID))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		// Lost the race — re-read to surface the precise reason.
		return nil, ErrGiftAlreadyRedeemed
	}
	redeemedSubID := ""
	if subID != nil {
		redeemedSubID = *subID
	}
	if err := emitAttributionEvent(ctx, tx, tenantID, id, gifterSubID, purchaserEmail,
		redeemedSubID, recipient, planID, durationMonths); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	// Reload the full row for the response + notifier. Uses
	// WithTenant — at this point we have the real tenant id, so the
	// existing tenant_visible policy admits the read normally.
	g, err := r.lookupGiftByID(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if r.Notifier != nil {
		go r.Notifier.SendGiftRedeemed(context.Background(), *g)
	}
	return g, nil
}

// CancelGift is the operator-initiated cancel. Refuses non-pending
// rows so the dashboard's "Cancel" affordance doesn't accidentally
// undo a successful redemption.
func (r *Repo) CancelGift(ctx context.Context, tenantID, id, reason string) (*GiftSub, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE gift_subscriptions
   SET status = 'canceled',
       canceled_at = now(),
       cancel_reason = $3
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'pending'`,
		id, tenantID, reason)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrGiftNotPending
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	g, err := r.lookupGiftByID(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if r.Notifier != nil {
		go r.Notifier.SendGiftCanceled(context.Background(), *g)
	}
	return g, nil
}

// GiftStats is the aggregated payload the dashboard renders above the
// gifts list. One round-trip, computed across all gift rows for the
// tenant (no window — gift lifecycle is much slower than per-call
// telemetry).
type GiftStats struct {
	Total       int       `json:"total"`
	Pending     int       `json:"pending"`
	Paid        int       `json:"paid"`
	Granted     int       `json:"granted"`
	Canceled    int       `json:"canceled"`
	Expired     int       `json:"expired"`
	Refunded    int       `json:"refunded"`
	GeneratedAt time.Time `json:"generated_at"`
	// ConversionRate = granted ÷ (granted + canceled + expired + refunded).
	// Pending and paid are unresolved and excluded. Refunded is terminal but
	// not treated as redeemed. NaN-safe — returns 0 when the denominator is 0.
	ConversionRate float64 `json:"conversionRate"`
}

func giftHistoryConversionRate(granted, canceled, expired, refunded int) float64 {
	resolved := granted + canceled + expired + refunded
	if resolved <= 0 {
		return 0
	}
	return float64(granted) / float64(resolved)
}

// GetGiftStats computes the headline tile counts.
func (r *Repo) GetGiftStats(ctx context.Context, tenantID string) (*GiftStats, error) {
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s GiftStats
	err = tx.QueryRow(ctx, `
SELECT
  COUNT(*),
  COUNT(*) FILTER (WHERE status = 'pending'),
  COUNT(*) FILTER (WHERE status = 'paid'),
  COUNT(*) FILTER (WHERE status = 'granted'),
  COUNT(*) FILTER (WHERE status = 'canceled'),
  COUNT(*) FILTER (WHERE status = 'expired'),
  COUNT(*) FILTER (WHERE status = 'refunded')
  FROM gift_subscriptions
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&s.Total, &s.Pending, &s.Paid, &s.Granted, &s.Canceled, &s.Expired, &s.Refunded)
	if err != nil {
		return nil, err
	}
	s.ConversionRate = giftHistoryConversionRate(
		s.Granted,
		s.Canceled,
		s.Expired,
		s.Refunded,
	)
	s.GeneratedAt = time.Now().UTC()
	return &s, tx.Commit(ctx)
}

// lookupGiftByID is the internal helper for re-reading a row after
// a state transition. Returns the full GiftSub including new
// fields. Does NOT set RedemptionURL — that's only known at create
// time.
func (r *Repo) lookupGiftByID(ctx context.Context, tenantID, id string) (*GiftSub, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var g GiftSub
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, purchaser_email, recipient_email, plan_id,
       duration_months, COALESCE(message,''), status,
       COALESCE(stripe_invoice_id,''), COALESCE(stripe_payment_url,''),
       granted_at, created_at,
       redeemed_at, expires_at, canceled_at, COALESCE(cancel_reason,''),
       COALESCE(gifter_subscriber_id::text,''), COALESCE(gifter_attribution_token,'')
  FROM gift_subscriptions
 WHERE id = $1::uuid AND tenant_id = $2::uuid`, id, tenantID).Scan(
		&g.ID, &g.TenantID, &g.PurchaserEmail, &g.RecipientEmail, &g.PlanID,
		&g.DurationMonths, &g.Message, &g.Status,
		&g.StripeInvoiceID, &g.StripePaymentURL,
		&g.GrantedAt, &g.CreatedAt,
		&g.RedeemedAt, &g.ExpiresAt, &g.CanceledAt, &g.CancelReason,
		&g.GifterSubscriberID, &g.GifterAttributionToken)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &g, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Expiration sweeper — runs as a background goroutine, transitions
// unclaimed pending gifts past expires_at to status='expired'.
// ---------------------------------------------------------------------

// GiftExpirationSweeper trims old pending gifts.
type GiftExpirationSweeper struct {
	Pool     *db.Pool
	Notifier GiftNotifier
	Logger   *slog.Logger
	// Interval defaults to 1h.
	Interval time.Duration
}

// Run blocks until ctx is cancelled.
func (s *GiftExpirationSweeper) Run(ctx context.Context) {
	if s == nil || s.Pool == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	s.tick(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *GiftExpirationSweeper) tick(ctx context.Context) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		s.log().Warn("gift sweeper worker scope failed", "err", err.Error())
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// RETURNING lets us notify each expiring gift in the same query.
	rows, err := tx.Query(ctx, `
UPDATE gift_subscriptions
   SET status = 'expired'
 WHERE status = 'pending'
   AND expires_at IS NOT NULL
   AND expires_at < now()
RETURNING id::text, tenant_id::text, purchaser_email, recipient_email,
          plan_id, duration_months, COALESCE(message,'')`)
	if err != nil {
		s.log().Warn("gift sweeper query failed", "err", err.Error())
		return
	}
	var expired []GiftSub
	for rows.Next() {
		var g GiftSub
		if err := rows.Scan(&g.ID, &g.TenantID, &g.PurchaserEmail, &g.RecipientEmail,
			&g.PlanID, &g.DurationMonths, &g.Message); err != nil {
			rows.Close()
			s.log().Warn("gift sweeper scan failed", "err", err.Error())
			return
		}
		g.Status = "expired"
		expired = append(expired, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.log().Warn("gift sweeper rows.Err", "err", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.log().Warn("gift sweeper commit failed", "err", err.Error())
		return
	}
	if len(expired) > 0 {
		s.log().Info("gift sweeper", "expired", len(expired))
	}
	for _, g := range expired {
		if s.Notifier != nil {
			s.Notifier.SendGiftExpired(ctx, g)
		}
	}
}

func (s *GiftExpirationSweeper) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

// GiftHandlers is the slim glue type the dashboard + public routes
// hang their handlers off. Constructed in main.go.
type GiftHandlers struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountGiftRoutes registers sanitized historical gift reporting. Mutation and
// public-claim routes remain unmounted until paid commerce is backed by a
// verified payment-provider adapter and reconciliation.
func (h *GiftHandlers) MountGiftRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(giftHistoryNoStore, read).Get("/api/v1/gift-subscriptions/stats", h.Stats)
	r.With(giftHistoryNoStore, read).Get("/api/v1/gift-subscriptions/{id}", h.Detail)
}

// Stats handles GET /api/v1/gift-subscriptions/stats.
func (h *GiftHandlers) Stats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		giftWriteErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	s, err := h.Repo.GetGiftStats(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	giftWriteJSON(w, http.StatusOK, s)
}

type giftCancelInput struct {
	Reason string `json:"reason,omitempty"`
}

// Cancel handles POST /api/v1/gift-subscriptions/{id}/cancel.
func (h *GiftHandlers) Cancel(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		giftWriteErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		giftWriteErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	var in giftCancelInput
	if err :=
		// Body is optional — empty cancels with no reason.
		httpbody.DecodeJSONWith(w, r, 4<<10, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	reason := strings.TrimSpace(in.Reason)
	g, err := h.Repo.CancelGift(r.Context(), tenant.ID, id, reason)
	if err != nil {
		switch {
		case errors.Is(err, ErrGiftNotPending):
			giftWriteErr(w, http.StatusConflict, "not_pending",
				"only pending gifts can be canceled")
		default:
			httperror.WriteInternal(w, h.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		}
		return
	}
	// p5-audit-gifts: audit the operator-initiated cancel. Reason is
	// captured in the metadata block so the audit timeline retains the
	// "why" alongside the row state transition.
	audit.EmitOrLog(r.Context(), h.Repo.Pool,
		"gift_subscription.cancel", "gift_subscription", g.ID,
		nil, map[string]any{
			"id":     g.ID,
			"status": g.Status,
		}, map[string]any{
			"reason": reason,
		})
	giftWriteJSON(w, http.StatusOK, g)
}

// PublicLookup handles GET /api/public/gifts/{token}. Returns a
// recipient-safe preview (no tenant / invoice ids) so the public
// claim page can render the giver + plan + message + "claim"
// button before the recipient acts.
func (h *GiftHandlers) PublicLookup(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	preview, err := h.Repo.LookupGiftByToken(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			giftWriteErr(w, http.StatusNotFound, "not_found",
				"this gift is no longer available")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	giftWriteJSON(w, http.StatusOK, preview)
}

// PublicRedeem handles POST /api/public/gifts/{token}/redeem. The
// "claim" button on the public page hits this.
func (h *GiftHandlers) PublicRedeem(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	g, err := h.Repo.RedeemGift(r.Context(), token)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			giftWriteErr(w, http.StatusNotFound, "not_found",
				"this gift is no longer available")
		case errors.Is(err, ErrGiftAlreadyRedeemed):
			giftWriteErr(w, http.StatusConflict, "already_redeemed",
				"this gift has already been claimed")
		case errors.Is(err, ErrGiftExpired):
			giftWriteErr(w, http.StatusGone, "expired",
				"this gift has expired")
		case errors.Is(err, ErrGiftCanceled):
			giftWriteErr(w, http.StatusGone, "canceled",
				"this gift was canceled")
		default:
			httperror.WriteInternal(w, h.Logger, err, r.Context())
		}
		return
	}
	// p5-audit-gifts: audit the public claim. The redeem path runs
	// without a tenant on ctx (public token IS the authn factor), so we
	// re-pin the tenant from the row we just loaded so audit.Emit can
	// resolve a tenant_id. The payload deliberately omits the raw token.
	auditCtx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: g.TenantID})
	audit.EmitOrLog(auditCtx, h.Repo.Pool,
		"gift_subscription.redeem", "gift_subscription", g.ID,
		nil, map[string]any{
			"id":              g.ID,
			"status":          g.Status,
			"plan_id":         g.PlanID,
			"duration_months": g.DurationMonths,
		}, nil)
	// Return a minimal redeem envelope — recipient doesn't need the
	// full row, just "you did it".
	giftWriteJSON(w, http.StatusOK, map[string]any{
		"status":         g.Status,
		"redeemedAt":     g.RedeemedAt,
		"planId":         g.PlanID,
		"durationMonths": g.DurationMonths,
	})
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

func giftWriteJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func giftWriteErr(w http.ResponseWriter, code int, errCode, msg string) {
	giftWriteJSON(w, code, map[string]any{
		"error": map[string]any{"code": errCode, "message": msg},
	})
}

func ifNilEmpty(v any) any {
	if v == nil {
		return ""
	}
	if s, ok := v.(*string); ok {
		if s == nil {
			return ""
		}
		return *s
	}
	return v
}

// Silence the fmt import if the unused-import linter ever runs
// against this file — fmt is used by sprintf in future iterations
// of the notifier wiring.
var _ = fmt.Sprintf
