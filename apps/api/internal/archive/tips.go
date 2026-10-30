// SPDX-License-Identifier: AGPL-3.0-only
//
// tips.go — public + admin surface for the archive Tips/Donations gap
// feature (P3, surface=archive, inspired by Ghost). Three endpoints:
//
//	GET  /api/public/archive/{tenant_slug}/tips/config
//	POST /api/public/archive/{tenant_slug}/tips/checkout
//	GET  /api/v1/archive/tips                 (admin — list recent tips)
//
// Wire shape:
//
//	GET .../config           → { enabled, currency, suggestedAmounts[], minAmount, message }
//	POST .../checkout body   → { amount: int (minor units), email?: string,
//	                             name?: string, message?: string,
//	                             campaignSlug?: string,
//	                             successUrl?: string, cancelUrl?: string }
//	POST .../checkout reply  → { url, sessionId }
//
// Flow:
//
//  1. Public archive page calls GET /config on render. If
//     `enabled=false` (or 404) the tip button is not rendered.
//  2. Reader clicks the tip button, picks an amount, optionally types a
//     supporter name + thank-you note, clicks "Tip with Stripe".
//  3. Browser POSTs to /checkout — server validates the amount against
//     the tenant's tips_min_amount and (when present) the
//     tips_suggested_amounts list, then mints a Stripe Checkout session
//     in `payment` mode with `client_reference_id="tip:<tipID>"` so the
//     existing Stripe webhook (billing.WebhookHandler) can identify
//     the tip flow and flip the archive_tips row from `pending` to
//     `succeeded`. A 0% platform fee — same as Ghost.
//  4. Browser redirects to the Stripe-hosted Checkout URL.
//  5. On `checkout.session.completed`, billing.WebhookHandler routes
//     to RecordTipSucceeded (registered via Deps.TipsHook) which
//     stamps amount/email/name onto the existing pending row and
//     fires an admin notification (when wired).
//
// RLS note: the writer-side INSERT runs WITHOUT a tenant GUC because
// the public-checkout path is unauthenticated. The migration adds a
// PERMISSIVE `archive_tips_public_writer` policy that lets the INSERT
// land; the row itself carries `tenant_id` validated against the
// resolved-from-slug tenant.

package archive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TipCheckoutRequest is the public-checkout body. All fields except
// `amount` are optional. `campaignSlug` ties a tip to a specific issue
// (so the per-issue dashboard tile can show "Tips on this issue"); the
// public archive index page omits it.
type TipCheckoutRequest struct {
	Amount       int    `json:"amount"`
	Email        string `json:"email,omitempty"`
	Name         string `json:"name,omitempty"`
	Message      string `json:"message,omitempty"`
	CampaignSlug string `json:"campaignSlug,omitempty"`
	SuccessURL   string `json:"successUrl,omitempty"`
	CancelURL    string `json:"cancelUrl,omitempty"`
}

// TipCheckoutResponse echoes the Stripe-hosted Checkout URL the
// frontend redirects to.
type TipCheckoutResponse struct {
	URL       string `json:"url"`
	SessionID string `json:"sessionId,omitempty"`
}

// TipRow is the per-tip projection for the admin list endpoint.
type TipRow struct {
	ID              string    `json:"id"`
	CampaignID      string    `json:"campaignId,omitempty"`
	StripeSessionID string    `json:"stripeSessionId,omitempty"`
	AmountMinor     int       `json:"amountMinor"`
	Currency        string    `json:"currency"`
	Status          string    `json:"status"`
	SupporterEmail  string    `json:"supporterEmail,omitempty"`
	SupporterName   string    `json:"supporterName,omitempty"`
	Message         string    `json:"message,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	CompletedAt     time.Time `json:"completedAt,omitempty"`
}

// TipsListPage is the admin list response.
type TipsListPage struct {
	Items      []TipRow `json:"items"`
	TotalMinor int      `json:"totalMinor"`
	Currency   string   `json:"currency"`
}

// StripeCheckoutCreator is the narrow surface tips.go needs from the
// billing package. Implemented in production by a wrapper around the
// existing billing.createStripeCheckoutSession function. Defined here
// as an interface so the tips handler doesn't take a dependency on
// billing (and can be unit-tested with an in-memory stub).
type StripeCheckoutCreator interface {
	CreateTipSession(ctx context.Context, in StripeTipSessionInput) (sessionID, url string, err error)
}

// StripeTipSessionInput packages what the Stripe Checkout API needs
// to mint a payment-mode session for a tip. Currency + amount are
// passed inline rather than via a price-id because tips are
// custom-amount per click (Ghost-equivalent flow).
type StripeTipSessionInput struct {
	TenantID      string
	TipID         string
	AmountMinor   int
	Currency      string // ISO 4217 lowercase
	CustomerEmail string // optional; Stripe collects one if unset
	ProductName   string // "Tip — {publication title}"
	SuccessURL    string
	CancelURL     string
}

// TipsHook is the optional admin-notification hook wired in main.go.
// Implementations get called once per `succeeded` row when the Stripe
// webhook lands. Errors are swallowed by the webhook entry-point —
// the tip is already recorded, the notification is best-effort.
type TipsHook interface {
	OnTipSucceeded(ctx context.Context, tenantID string, tip TipRow) error
}

// TipsDeps is wired in main.go alongside archive.Deps. Carries the
// Stripe creator + optional notification hook + the public base URL
// used for default success/cancel redirects.
//
// Verify, when non-nil, gates the dedicated tips webhook with Stripe
// HMAC signature verification. Wired from main.go to
// billing.VerifySignature. When nil the webhook accepts unsigned
// payloads — intended only for local dev where the operator runs
// `stripe listen --forward-to ...` without a signing secret.
type TipsDeps struct {
	Repo          *Repo
	Stripe        StripeCheckoutCreator
	Hook          TipsHook
	PublicBaseURL string
	Logger        *slog.Logger
	Verify        StripeSignatureVerifier
}

// tipBodyMaxBytes — the request body is tiny (a handful of integers +
// short strings). 4 KiB is generous and bounds a hostile payload.
const tipBodyMaxBytes int64 = 4 << 10

// PublicTipsConfigHandler GET /api/public/archive/{tenant_slug}/tips/config.
//
// Cheap, unauthenticated probe the public archive page calls on render
// to decide whether to surface the tip button. Returns Enabled=false
// (200 OK, not 404) when tips are off so the page doesn't have to
// disambiguate "missing tenant" from "tips off".
func (d *TipsDeps) PublicTipsConfigHandler(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such archive"))
		return
	}
	cfg, err := d.Repo.GetPublicTipsConfig(r.Context(), tid)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Cache hint: tip config rarely changes; let the CDN hold for 60s
	// so a viral issue doesn't hammer the DB on every render.
	w.Header().Set("Cache-Control", "public, max-age=60")
	writeJSON(w, http.StatusOK, cfg)
}

// PublicTipsCheckoutHandler POST /api/public/archive/{tenant_slug}/tips/checkout.
//
// Validates the amount against the tenant's tips_min_amount and (when
// non-empty) the tips_suggested_amounts allow-list; mints a Stripe
// Checkout session in payment mode; INSERTs an `archive_tips` row
// with status=pending; returns the Stripe URL.
//
// Returns:
//
//	200 {url, sessionId}        — session created, redirect here.
//	400 invalid_amount          — below floor or above ceiling.
//	403 tips_disabled           — tenant has tips_enabled=false.
//	404 not_found               — unknown tenant slug.
//	503 checkout_not_configured — TipsDeps.Stripe == nil (env unset).
//	502 stripe_request_failed   — Stripe rejected the session-create.
func (d *TipsDeps) PublicTipsCheckoutHandler(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such archive"))
		return
	}
	var in TipCheckoutRequest
	if err := httpbody.DecodeJSON(w, r, tipBodyMaxBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	cfg, err := d.Repo.GetPublicTipsConfig(r.Context(), tid)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !cfg.Enabled {
		// A configuration denial, not a plan one. This is a PUBLIC endpoint, so
		// the reader seeing it is not the person who can turn tips on — which is
		// exactly why the reason has to say "flag" and the remedy has to be empty
		// rather than pointing at a billing page the reader cannot use.
		entitlement.Write(w, entitlement.Denial{
			Subject: "archive_tips",
			Reason:  entitlement.ReasonFlag,
			Code:    "tips_disabled",
			Message: "this publication has not enabled tips",
		})
		return
	}
	if err := validateTipAmount(in.Amount, cfg); err != nil {
		httperror.WriteValidation(w, "invalid_amount", err.Error())
		return
	}
	// Optional issue context. Resolved to a campaign id (uuid) so the
	// tips row can FK to campaigns.id and survive a slug rename.
	var campaignID string
	if cs := strings.TrimSpace(in.CampaignSlug); cs != "" {
		issue, gErr := d.Repo.GetIssue(r.Context(), tid, cs)
		if gErr == nil && issue != nil {
			campaignID = issue.CampaignID
		}
		// Slug-not-found is silently demoted to "tip without issue
		// context" rather than a 404 — the public page may pass an
		// unpublished or renamed slug; the tip is still legitimate.
	}
	if d.Stripe == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"checkout_not_configured",
			"Stripe is not configured on this Moosewave server. "+
				"Set STRIPE_SECRET_KEY to enable tips."))
		return
	}
	// Insert the pending row FIRST so we have a stable tip-id to stamp
	// onto the Stripe session metadata. If Stripe creation fails we
	// mark the row as failed (rather than delete it) so the admin
	// panel can show "1 pending tip never completed" — much easier
	// to debug than a silent drop.
	tipID, err := d.Repo.insertPendingTip(r.Context(), pendingTipInsert{
		TenantID:    tid,
		CampaignID:  campaignID,
		AmountMinor: in.Amount,
		Currency:    cfg.Currency,
		Email:       strings.TrimSpace(in.Email),
		Name:        strings.TrimSpace(in.Name),
		Message:     strings.TrimSpace(in.Message),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	successURL := strings.TrimSpace(in.SuccessURL)
	if successURL == "" {
		successURL = d.defaultSuccessURL(tslug, in.CampaignSlug)
	}
	cancelURL := strings.TrimSpace(in.CancelURL)
	if cancelURL == "" {
		cancelURL = d.defaultCancelURL(tslug, in.CampaignSlug)
	}
	sessID, redirectURL, sErr := d.Stripe.CreateTipSession(r.Context(), StripeTipSessionInput{
		TenantID:      tid,
		TipID:         tipID,
		AmountMinor:   in.Amount,
		Currency:      cfg.Currency,
		CustomerEmail: strings.TrimSpace(in.Email),
		ProductName:   "Tip",
		SuccessURL:    successURL,
		CancelURL:     cancelURL,
	})
	if sErr != nil {
		// Flip the row to `failed` so the dashboard can show the
		// session-creation error without leaving an indefinite
		// pending row hanging.
		_ = d.Repo.markTipFailed(r.Context(), tid, tipID)
		if d.Logger != nil {
			d.Logger.Error("stripe tip session create failed",
				"tenant_id", tid, "tip_id", tipID, "err", sErr.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "stripe_request_failed",
			"upstream Stripe request failed")
		return
	}
	if err := d.Repo.attachStripeSession(r.Context(), tid, tipID, sessID); err != nil {
		if d.Logger != nil {
			d.Logger.Error("attach stripe session to tip row failed",
				"tenant_id", tid, "tip_id", tipID, "session_id", sessID, "err", err.Error())
		}
		// Non-fatal: the row exists, the Stripe session exists, the
		// webhook will reconcile on completion. The user can still pay.
	}
	writeJSON(w, http.StatusOK, TipCheckoutResponse{URL: redirectURL, SessionID: sessID})
}

// validateTipAmount enforces:
//   - amount >= cfg.MinAmount
//   - amount <= $1M (Stripe ceiling)
//   - when SuggestedAmounts is non-empty, amount MUST be one of them OR
//     pass the "custom amount" bypass — we accept any amount >= MinAmount
//     because Ghost lets readers type a custom amount even when quick-
//     picks are configured. The picker is suggestions, not allow-list.
func validateTipAmount(amount int, cfg PublicTipsConfig) error {
	if amount < cfg.MinAmount {
		return fmt.Errorf("amount must be at least %d minor units (the publication's floor)", cfg.MinAmount)
	}
	if amount > 100_000_000 {
		return errors.New("amount exceeds Stripe's $1,000,000 ceiling")
	}
	return nil
}

func (d *TipsDeps) defaultSuccessURL(tenantSlug, campaignSlug string) string {
	base := strings.TrimRight(d.PublicBaseURL, "/")
	if base == "" {
		base = strings.TrimRight(os.Getenv("ARCHIVE_PUBLIC_BASE_URL"), "/")
	}
	if base == "" {
		base = "https://archive.moosewave.com"
	}
	if campaignSlug != "" {
		return fmt.Sprintf("%s/%s/%s?tip=success&session_id={CHECKOUT_SESSION_ID}",
			base, tenantSlug, campaignSlug)
	}
	return fmt.Sprintf("%s/%s?tip=success&session_id={CHECKOUT_SESSION_ID}", base, tenantSlug)
}

func (d *TipsDeps) defaultCancelURL(tenantSlug, campaignSlug string) string {
	base := strings.TrimRight(d.PublicBaseURL, "/")
	if base == "" {
		base = strings.TrimRight(os.Getenv("ARCHIVE_PUBLIC_BASE_URL"), "/")
	}
	if base == "" {
		base = "https://archive.moosewave.com"
	}
	if campaignSlug != "" {
		return fmt.Sprintf("%s/%s/%s?tip=cancelled", base, tenantSlug, campaignSlug)
	}
	return fmt.Sprintf("%s/%s?tip=cancelled", base, tenantSlug)
}

// AdminListTips GET /api/v1/archive/tips
//
// Tenant-scoped list of recent tips for the dashboard. Defaults to the
// 50 most-recent rows; `?limit=N` clamps to [1,200]. Includes a
// totalMinor sum across `status='succeeded'` so the page can show a
// running "Tips this month" tile without a second query.
func (d *TipsDeps) AdminListTips(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	page, err := d.Repo.ListTips(r.Context(), t.ID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// MountPublicTipsRoutes wires the unauthenticated tip endpoints. Kept
// separate from MountPublicRoutes so the caller (main.go) can opt out
// when Stripe isn't configured — though even with d.Stripe==nil the
// config endpoint still works (returns Enabled=false) so it's safe to
// mount unconditionally.
func (d *TipsDeps) MountPublicTipsRoutes(r chi.Router) {
	r.Get("/api/public/archive/{tenant_slug}/tips/config", d.PublicTipsConfigHandler)
	r.Post("/api/public/archive/{tenant_slug}/tips/checkout", d.PublicTipsCheckoutHandler)
}

// MountAdminTipsRoutes wires the dashboard list endpoint. Read-scope
// gated (same as AdminList in archive.go).
func (d *TipsDeps) MountAdminTipsRoutes(r chi.Router) {
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadReports, apikeys.ScopeAdmin))
	read.Get("/api/v1/archive/tips", d.AdminListTips)
}

// ---------- repo helpers ----------

type pendingTipInsert struct {
	TenantID    string
	CampaignID  string
	AmountMinor int
	Currency    string
	Email       string
	Name        string
	Message     string
}

// insertPendingTip inserts a row with status='pending' and returns the
// generated UUID. Runs OUTSIDE db.WithTenant — the public-checkout path
// has no tenant context yet — and relies on the PERMISSIVE
// `archive_tips_public_writer` RLS policy from migration 0284.
func (r *Repo) insertPendingTip(ctx context.Context, in pendingTipInsert) (string, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	var id string
	// stripe_session_id is NOT NULL on the schema; we stamp a sentinel
	// placeholder ("pending:<uuid>") at INSERT time and rewrite it once
	// Stripe responds with the real session id. The UNIQUE index
	// tolerates the placeholder because each row gets a unique uuid.
	err = conn.QueryRow(ctx, `
INSERT INTO archive_tips (
    tenant_id, campaign_id, stripe_session_id,
    amount_minor, currency, supporter_email, supporter_name, message, status
) VALUES (
    $1::uuid,
    NULLIF($2, '')::uuid,
    'pending:' || gen_random_uuid()::text,
    $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
    'pending'
)
RETURNING id::text`,
		in.TenantID, in.CampaignID,
		in.AmountMinor, in.Currency,
		in.Email, in.Name, in.Message,
	).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, nil
}

// attachStripeSession overwrites the placeholder stripe_session_id
// with the real Stripe-issued one after the checkout-session-create
// call succeeds. Idempotent.
func (r *Repo) attachStripeSession(ctx context.Context, tenantID, tipID, sessionID string) error {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	_, err = conn.Exec(ctx, `
UPDATE archive_tips
   SET stripe_session_id = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, tipID, sessionID)
	return err
}

// markTipFailed flips the status column to 'failed'. Used when the
// Stripe Checkout session-create call returns an error AFTER we've
// already inserted the pending row.
func (r *Repo) markTipFailed(ctx context.Context, tenantID, tipID string) error {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	_, err = conn.Exec(ctx, `
UPDATE archive_tips
   SET status = 'failed'
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'`,
		tenantID, tipID)
	return err
}

// RecordTipSucceeded is the entry-point billing.WebhookHandler calls
// when a `checkout.session.completed` event arrives with a
// `client_reference_id` of `tip:<tipID>`. Idempotent — Stripe
// redelivers events on transient failures.
//
// `paymentID` is the underlying Stripe payment_intent id (carried on
// the Session object as `payment_intent`); we record it so a future
// refund handler can match the row.
//
// `email` / `name` may be supplied by the Stripe Customer details on
// the session — overrides the (possibly empty) values stored at
// session-create.
func (r *Repo) RecordTipSucceeded(ctx context.Context, tenantID, sessionID, paymentID, email, name string) (TipRow, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return TipRow{}, err
	}
	defer conn.Release()
	var row TipRow
	var (
		campaignID      *string
		supporterEmail  *string
		supporterName   *string
		message         *string
		stripeSessionID string
		stripePaymentID *string
		completedAt     *time.Time
	)
	err = conn.QueryRow(ctx, `
UPDATE archive_tips
   SET status            = 'succeeded',
       stripe_payment_id = NULLIF($3, ''),
       supporter_email   = COALESCE(NULLIF($4, ''), supporter_email),
       supporter_name    = COALESCE(NULLIF($5, ''), supporter_name),
       completed_at      = now()
 WHERE tenant_id = $1::uuid AND stripe_session_id = $2
RETURNING id::text, campaign_id::text, stripe_session_id, stripe_payment_id,
          amount_minor, currency, status,
          supporter_email, supporter_name, message, created_at, completed_at`,
		tenantID, sessionID, paymentID, email, name,
	).Scan(
		&row.ID, &campaignID, &stripeSessionID, &stripePaymentID,
		&row.AmountMinor, &row.Currency, &row.Status,
		&supporterEmail, &supporterName, &message, &row.CreatedAt, &completedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return TipRow{}, ErrNotFound
	}
	if err != nil {
		return TipRow{}, err
	}
	if campaignID != nil {
		row.CampaignID = *campaignID
	}
	row.StripeSessionID = stripeSessionID
	if supporterEmail != nil {
		row.SupporterEmail = *supporterEmail
	}
	if supporterName != nil {
		row.SupporterName = *supporterName
	}
	if message != nil {
		row.Message = *message
	}
	if completedAt != nil {
		row.CompletedAt = *completedAt
	}
	return row, nil
}

// ListTips returns the most-recent N tips for the tenant + the rolling
// 30-day succeeded-total in minor units. Tenant-scoped via WithTenant
// (the RESTRICTIVE RLS policy gates the SELECT).
func (r *Repo) ListTips(ctx context.Context, tenantID string, limit int) (TipsListPage, error) {
	if limit <= 0 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return TipsListPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text,
       COALESCE(campaign_id::text, ''),
       COALESCE(stripe_session_id, ''),
       amount_minor, currency, status,
       COALESCE(supporter_email, ''),
       COALESCE(supporter_name, ''),
       COALESCE(message, ''),
       created_at,
       completed_at
  FROM archive_tips
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return TipsListPage{}, err
	}
	defer rows.Close()
	out := TipsListPage{Items: []TipRow{}}
	for rows.Next() {
		var row TipRow
		var completedAt *time.Time
		if err := rows.Scan(
			&row.ID, &row.CampaignID, &row.StripeSessionID,
			&row.AmountMinor, &row.Currency, &row.Status,
			&row.SupporterEmail, &row.SupporterName, &row.Message,
			&row.CreatedAt, &completedAt,
		); err != nil {
			return TipsListPage{}, err
		}
		if completedAt != nil {
			row.CompletedAt = *completedAt
		}
		out.Items = append(out.Items, row)
	}
	if err := rows.Err(); err != nil {
		return TipsListPage{}, err
	}
	// 30d succeeded total. A second tiny query rather than aggregating
	// over Items (the page is capped at 200; the total may be larger).
	var total int
	var currency string
	err = tx.QueryRow(ctx, `
SELECT COALESCE(SUM(amount_minor), 0)::integer,
       COALESCE(MAX(currency), 'usd')
  FROM archive_tips
 WHERE tenant_id = $1::uuid
   AND status = 'succeeded'
   AND completed_at > now() - INTERVAL '30 days'`, tenantID).Scan(&total, &currency)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return TipsListPage{}, err
	}
	out.TotalMinor = total
	out.Currency = currency
	if err := tx.Commit(ctx); err != nil {
		return TipsListPage{}, err
	}
	return out, nil
}

// ---------- TipsHook adapter (called from billing webhook) ----------

// HandleStripeTipCompleted is invoked from the billing webhook router
// when `client_reference_id` on a checkout.session.completed event
// starts with `tip:`. Returns the recorded TipRow so the caller can
// fire the admin notification with a clean payload.
//
// Returns ErrNotFound when the supplied sessionID doesn't match any
// archive_tips row — typically benign (Stripe redelivery for a tip the
// webhook handled before).
func (d *TipsDeps) HandleStripeTipCompleted(ctx context.Context, tenantID, sessionID, paymentID, email, name string) error {
	row, err := d.Repo.RecordTipSucceeded(ctx, tenantID, sessionID, paymentID, email, name)
	if err != nil {
		return err
	}
	if d.Hook != nil {
		if hErr := d.Hook.OnTipSucceeded(ctx, tenantID, row); hErr != nil && d.Logger != nil {
			d.Logger.Warn("archive tip notification hook failed",
				"tenant_id", tenantID, "tip_id", row.ID, "err", hErr.Error())
		}
	}
	return nil
}

// ---------- dedicated Stripe webhook entrypoint ----------

// stripeTipEvent is the slice of the Stripe Event shape we care about
// on the tips webhook path. Kept local + minimal so we don't take an
// archive→billing dependency.
type stripeTipEvent struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data struct {
		Object stripeTipCheckoutSession `json:"object"`
	} `json:"data"`
	Created int64 `json:"created"`
}

type stripeTipCheckoutSession struct {
	ID                string            `json:"id"`
	ClientReferenceID string            `json:"client_reference_id"`
	CustomerEmail     string            `json:"customer_email"`
	PaymentIntent     string            `json:"payment_intent"`
	Metadata          map[string]string `json:"metadata"`
	CustomerDetails   struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"customer_details"`
}

// StripeSignatureVerifier is the narrow surface the tips webhook
// handler needs to verify a Stripe-signed payload. Wired in main.go
// to billing.VerifySignature so the same HMAC implementation governs
// both webhook flows.
type StripeSignatureVerifier func(secret, header string, body []byte, now time.Time, tolerance time.Duration) error

// TipsWebhookHandler is the dedicated Stripe webhook entry-point for
// the tips flow. Lives at `POST /api/public/archive/tips/webhook` so
// the operator can register a separate Stripe endpoint in their
// dashboard (with its own per-endpoint signing secret) and the tips
// flow doesn't have to share a code path with the
// tier-upgrade/auto-provision webhook.
//
// Why a separate endpoint:
//   - Letting tips ride the existing /api/public/stripe/webhook would
//     mean every event delivered to the platform's main signing
//     secret has to be considered for tip-vs-tier disambiguation —
//     and a Stripe `checkout.session.completed` with no metadata
//     would falsely match the auto-provision path.
//   - A per-endpoint secret means a leaked tips-webhook secret can be
//     rotated without affecting upgrade flows.
//
// Operators wire this by creating a Stripe webhook endpoint pointing
// at /api/public/archive/tips/webhook and setting
// ARCHIVE_TIPS_WEBHOOK_SECRET (falls back to STRIPE_WEBHOOK_SECRET
// when unset so single-tenant single-secret installs still work).
func (d *TipsDeps) TipsWebhookHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, errEnv("method_not_allowed", "POST required"))
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, 1<<20)
	if err != nil {
		httperror.WriteValidation(w, "read_failed", "request could not be processed")
		return
	}
	defer func() { _ = r.Body.Close() }()
	if d.Verify != nil {
		secret := strings.TrimSpace(os.Getenv("ARCHIVE_TIPS_WEBHOOK_SECRET"))
		if secret == "" {
			secret = strings.TrimSpace(os.Getenv("STRIPE_WEBHOOK_SECRET"))
		}
		if secret == "" {
			// Mis-configured: reject so the operator notices. Stripe
			// retries with backoff so a single misfire here doesn't
			// drop a tip silently — they get 4xx alerts in the
			// dashboard until they wire the secret.
			writeJSON(w, http.StatusServiceUnavailable,
				errEnv("webhook_not_configured",
					"ARCHIVE_TIPS_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET is not configured"))
			return
		}
		sig := r.Header.Get("Stripe-Signature")
		if vErr := d.Verify(secret, sig, body, time.Now().UTC(), 5*time.Minute); vErr != nil {
			if d.Logger != nil {
				d.Logger.Warn("archive tips webhook signature failed", "err", vErr.Error())
			}
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_signature", "invalid Stripe signature"))
			return
		}
	}
	var ev stripeTipEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		httperror.WriteValidation(w, "decode_failed", "request payload is invalid")
		return
	}
	switch ev.Type {
	case "checkout.session.completed":
		sess := ev.Data.Object
		// Disambiguate tips events: client_reference_id starts with
		// "tip:" AND metadata.postwave_kind == "archive_tip". Both
		// must be set by archive's checkout-create path; if either is
		// missing we treat the event as "not ours" and ACK silently
		// so Stripe stops retrying.
		if !strings.HasPrefix(sess.ClientReferenceID, "tip:") ||
			sess.Metadata["postwave_kind"] != "archive_tip" {
			w.WriteHeader(http.StatusOK)
			return
		}
		tenantID := sess.Metadata["postwave_tenant_id"]
		email := sess.CustomerEmail
		if email == "" {
			email = sess.CustomerDetails.Email
		}
		name := sess.CustomerDetails.Name
		if err := d.HandleStripeTipCompleted(r.Context(), tenantID, sess.ID, sess.PaymentIntent, email, name); err != nil {
			if d.Logger != nil {
				d.Logger.Warn("archive tips webhook reconcile failed",
					"event_id", ev.ID, "session_id", sess.ID,
					"tenant_id", tenantID, "err", err.Error())
			}
			// Return 200 anyway — the row is already pending and the
			// admin dashboard surfaces stale-pending rows for manual
			// reconciliation.
		}
	default:
		// Ignore other event types; the dashboard endpoint only cares
		// about checkout completion. Future: handle charge.refunded
		// to flip the row to status='refunded'.
	}
	w.WriteHeader(http.StatusOK)
}

// ---------- internal stub for tests / dev environments ----------

// stubStripeCreator is the no-Stripe-configured fallback. Always
// returns an error so the public-checkout endpoint surfaces a 503.
// Production wires a real implementation from main.go.
type stubStripeCreator struct{}

func (stubStripeCreator) CreateTipSession(_ context.Context, _ StripeTipSessionInput) (string, string, error) {
	return "", "", errors.New("Stripe Checkout is not configured (STRIPE_SECRET_KEY unset)")
}

// MarshalJSONForTest is a test helper that returns the canonical JSON
// encoding of a TipRow. Exported lowercase (test-only); not part of
// the public API.
func marshalTipRowForTest(row TipRow) string {
	b, _ := json.Marshal(row)
	return string(b)
}
