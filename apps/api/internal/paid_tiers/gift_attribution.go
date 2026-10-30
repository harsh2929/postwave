// SPDX-License-Identifier: AGPL-3.0-only
//
// gift_attribution.go — sender-attribution layer on top of the
// gift_subscriptions table. Implements the audit gap
// "archive-gift-subscriptions": every gift can be tied to an
// existing subscriber (the gifter), and every redeemed gift emits
// an attribution event so the dashboard can answer:
//
// Schema home: infra/migrations/0304_gift_subscriptions_attribution.sql
// (added columns: gifter_subscriber_id, gifter_attribution_token;
//  new table: gift_attribution_events).
//
//   * Which existing members drive the most word-of-mouth? (top
//     givers by redeemed gift count)
//   * What's our gift-driven conversion funnel? (sent → redeemed)
//   * Per-giver lifetime referral count + revenue (joined via
//     gift_attribution_events.redeemed_subscriber_id → paid_subs).
//
// Read-side endpoints added here:
//
//   GET /api/v1/gift-subscriptions/attribution
//     → AttributionReport { top_givers[], funnel, total_givers }
//
// Write-side hooks (called from gifts.go):
//
//   * resolveGifterSubscriber — runs at CreateGift time. If
//     gifter_subscriber_id is unset, look up by purchaser_email
//     within the tenant; cache the result on the row.
//   * emitAttributionEvent — runs at RedeemGift time. Inserts a
//     gift_attribution_events row joining giver + recipient so the
//     report is one SELECT away.
//
// The attribution_token is stamped at create time and lives on the
// redemption URL as ?ref=<token>. Distinct from the auth token
// (sha256-hashed in redemption_token_sha256) so it can be rotated
// independently. The public redemption-preview endpoint surfaces
// the token-resolved giver name without exposing internal ids.

package paid_tiers

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AttributionTokenLen is the number of random bytes mixed into the
// short ?ref= code stamped on the redemption URL. 10 bytes → 16
// base32 chars; collision-resistant within a tenant + URL-safe
// without padding.
const AttributionTokenLen = 10

// GifterRef is the projection of a top-giver row in the attribution
// report. SubscriberID is empty when the giver was never a
// tenant-managed subscriber (Stripe-direct gift purchase).
type GifterRef struct {
	SubscriberID   string     `json:"subscriber_id,omitempty"`
	Email          string     `json:"email"`
	GiftsSent      int        `json:"gifts_sent"`
	GiftsRedeemed  int        `json:"gifts_redeemed"`
	GiftsPending   int        `json:"gifts_pending"`
	ConversionRate float64    `json:"conversion_rate"`
	LastGiftAt     *time.Time `json:"last_gift_at,omitempty"`
}

// AttributionFunnel mirrors the page-level funnel tiles the dashboard
// renders above the top-givers table.
type AttributionFunnel struct {
	GiftsSent      int     `json:"gifts_sent"`
	GiftsRedeemed  int     `json:"gifts_redeemed"`
	GiftsPending   int     `json:"gifts_pending"`
	GiftsCanceled  int     `json:"gifts_canceled"`
	GiftsExpired   int     `json:"gifts_expired"`
	ConversionRate float64 `json:"conversion_rate"`
}

// AttributionReport is the response envelope for
// GET /api/v1/gift-subscriptions/attribution.
type AttributionReport struct {
	Funnel      AttributionFunnel `json:"funnel"`
	TopGivers   []GifterRef       `json:"top_givers"`
	TotalGivers int               `json:"total_givers"`
	GeneratedAt time.Time         `json:"generated_at"`
}

// mintAttributionToken returns a short URL-safe ref code. Base32
// (no padding, lower-case) so it's safe in a query param without
// percent-encoding and case-insensitive for ergonomic copy-paste.
func mintAttributionToken() (string, error) {
	var b [AttributionTokenLen]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	tok := strings.ToLower(strings.TrimRight(
		base32.StdEncoding.EncodeToString(b[:]), "="))
	return tok, nil
}

// resolveGifterSubscriber finds the subscribers.id row matching the
// purchaser email within the tenant. Returns empty string + nil
// error when there's no match (the giver isn't a tenant-managed
// subscriber yet). Empty / lookup-error never blocks the gift
// create — attribution is best-effort metadata.
//
// Caller is expected to already hold a `WithTenant` tx so the RLS
// is set; we accept a generic Queryer so the same helper works in
// both the create-tx and the redemption-tx path.
func resolveGifterSubscriber(ctx context.Context, q pgx.Tx, tenantID, purchaserEmail string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(purchaserEmail))
	if email == "" {
		return "", nil
	}
	var id string
	err := q.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2
 LIMIT 1`, tenantID, email).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return id, nil
}

// emitAttributionEvent writes one gift_attribution_events row joining
// giver + redeemed subscriber. Called from RedeemGift inside the
// same tx so the event is atomic with the status='granted' transition.
//
// All fields except tenant_id/gifter_email/redeemed_email/plan_id/
// duration_months are nullable — the event survives a giver-side
// or recipient-side delete (FK SET NULL) so the aggregate signal
// stays intact for cohort reporting even after a GDPR purge.
func emitAttributionEvent(
	ctx context.Context, q pgx.Tx,
	tenantID, giftID, gifterSubID, gifterEmail, redeemedSubID, redeemedEmail, planID string,
	durationMonths int,
) error {
	if tenantID == "" || gifterEmail == "" || redeemedEmail == "" {
		// Defensive: bare minimum is required for the row to be
		// queryable. Empty values mean the redemption ran in a degraded
		// path (legacy gift row pre-0298) — skip silently rather than
		// fail the redemption.
		return nil
	}
	_, err := q.Exec(ctx, `
INSERT INTO gift_attribution_events (
    tenant_id, gift_id, gifter_subscriber_id, gifter_email,
    redeemed_subscriber_id, redeemed_email, plan_id, duration_months
)
VALUES (
    $1::uuid,
    NULLIF($2,'')::uuid,
    NULLIF($3,'')::uuid,
    $4,
    NULLIF($5,'')::uuid,
    $6,
    $7,
    $8
)`,
		tenantID, giftID, gifterSubID, strings.ToLower(strings.TrimSpace(gifterEmail)),
		redeemedSubID, strings.ToLower(strings.TrimSpace(redeemedEmail)),
		planID, durationMonths,
	)
	return err
}

// GetAttributionReport computes the top-giver leaderboard + the
// gift funnel. One round-trip per tenant — both queries are O(rows
// in gift_subscriptions for that tenant). Acceptable because gift
// volume is two orders of magnitude lower than transactional sub
// volume.
func (r *Repo) GetAttributionReport(ctx context.Context, tenantID string, limit int) (*AttributionReport, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Funnel: tile counts across all gifts.
	var f AttributionFunnel
	if err := tx.QueryRow(ctx, `
SELECT
  COUNT(*),
  COUNT(*) FILTER (WHERE status = 'granted'),
  COUNT(*) FILTER (WHERE status = 'pending'),
  COUNT(*) FILTER (WHERE status = 'canceled'),
  COUNT(*) FILTER (WHERE status = 'expired')
  FROM gift_subscriptions
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&f.GiftsSent, &f.GiftsRedeemed, &f.GiftsPending, &f.GiftsCanceled, &f.GiftsExpired,
	); err != nil {
		return nil, err
	}
	resolved := f.GiftsRedeemed + f.GiftsCanceled + f.GiftsExpired
	if resolved > 0 {
		f.ConversionRate = float64(f.GiftsRedeemed) / float64(resolved)
	}

	// Top givers: grouped by gifter identity. We aggregate on
	// (gifter_subscriber_id, purchaser_email) so that gifts from a
	// known subscriber land in one bucket; Stripe-direct gifts (NULL
	// subscriber id) still cluster on email so they're attributable
	// to a person even when not a tenant subscriber.
	rows, err := tx.Query(ctx, `
SELECT
  COALESCE(gifter_subscriber_id::text, '')           AS sub_id,
  LOWER(purchaser_email)                             AS email,
  COUNT(*)                                           AS sent,
  COUNT(*) FILTER (WHERE status = 'granted')         AS redeemed,
  COUNT(*) FILTER (WHERE status = 'pending')         AS pending,
  MAX(created_at)                                    AS last_at
FROM gift_subscriptions
WHERE tenant_id = $1::uuid
GROUP BY gifter_subscriber_id, LOWER(purchaser_email)
ORDER BY redeemed DESC, sent DESC, last_at DESC
LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	givers := []GifterRef{}
	for rows.Next() {
		var g GifterRef
		var lastAt *time.Time
		if err := rows.Scan(&g.SubscriberID, &g.Email, &g.GiftsSent,
			&g.GiftsRedeemed, &g.GiftsPending, &lastAt); err != nil {
			return nil, err
		}
		g.LastGiftAt = lastAt
		denom := g.GiftsSent - g.GiftsPending
		if denom > 0 {
			g.ConversionRate = float64(g.GiftsRedeemed) / float64(denom)
		}
		givers = append(givers, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Total distinct givers (separate from the top-N projection above).
	var total int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(DISTINCT COALESCE(gifter_subscriber_id::text, LOWER(purchaser_email)))
  FROM gift_subscriptions
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&total); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &AttributionReport{
		Funnel:      f,
		TopGivers:   givers,
		TotalGivers: total,
		GeneratedAt: time.Now().UTC(),
	}, nil
}

// ---------------------------------------------------------------------
// HTTP handler — read-only attribution report endpoint
// ---------------------------------------------------------------------

// MountGiftAttributionRoutes registers GET /api/v1/gift-subscriptions/attribution.
// Caller wires this alongside GiftHandlers.MountGiftRoutes in main.go;
// kept on the GiftHandlers receiver so it inherits the same auth
// middleware group.
func (h *GiftHandlers) MountGiftAttributionRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/gift-subscriptions/attribution", h.Attribution)
}

// Attribution handles GET /api/v1/gift-subscriptions/attribution.
// Query params:
//   - limit (optional, default 50, max 200): cap for the top-givers list.
func (h *GiftHandlers) Attribution(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		giftWriteErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	limit := 50
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	rep, err := h.Repo.GetAttributionReport(r.Context(), tenant.ID, limit)
	if err != nil {
		giftWriteErr(w, http.StatusInternalServerError, "attribution_failed", "an internal error occurred")
		return
	}
	giftWriteJSON(w, http.StatusOK, rep)
}
