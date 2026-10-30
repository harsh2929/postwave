// SPDX-License-Identifier: AGPL-3.0-only
//
// public_checkout.go — `POST /api/public/billing/checkout`.
//
// Unauthenticated checkout-session creator the marketing site /pricing
// page calls when a visitor clicks "Get Studio Lifetime" / "Choose Pro
// Sending" / similar. Returns the Stripe-hosted Checkout URL the
// page redirects to. Dodo Payments is the canonical Moosewave provider; the
// Stripe implementation below remains as a compatibility path for existing
// subscriptions and self-hosted installations.
//
// The provider's signed webhook owns fulfilment after Checkout. Dodo events are
// handled by DodoWebhookHandler; legacy Stripe events remain handled by
// WebhookHandler.
//
// Why a separate file (and not extending handlers.go::Checkout):
//   - handlers.go::Checkout is the AUTHENTICATED, dashboard-side flow
//     (admin clicks "upgrade" inside a logged-in tenant). It binds the
//     Checkout Session to that tenant and its signed-in administrator.
//   - This file's PublicCheckout is the UNAUTHENTICATED, pre-tenant
//     marketing-site flow. It must call out to Stripe live to mint a
//     fresh session per click — there's no tenant id yet, no
//     pre-canned URL, and the customer email comes from the form.
//
// Provider SDK note: both session clients use small, bounded HTTP requests so
// the package can keep its provider boundary explicit and testable.

package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// stripeAPIBase is overridable for tests. Production always hits
// api.stripe.com; tests redirect to a local httptest.Server.
var stripeAPIBase = "https://api.stripe.com"

// stripeHTTPClient is overridable for tests. Defaults to a standard
// net/http client with a sane timeout.
var stripeHTTPClient = &http.Client{Timeout: 10 * time.Second}

const (
	publicCheckoutMaxBodyBytes     int64 = 16 << 10 // 16 KiB
	stripeCheckoutResponseMaxBytes int64 = 1 << 20
)

var errStripePriceNotConfigured = errors.New("stripe price configuration is incomplete")

// PublicCheckoutInput is the JSON body the marketing site posts.
//
// `priceId` and `tier` are mutually convertible: callers may send a
// price id directly (forward-compatible with new tiers) OR a tier slug
// the server resolves against PriceMap. Sending both is fine; priceId
// wins.
//
// `customerEmail` is REQUIRED. Stripe Checkout will collect an email
// itself if we don't pass one, but pre-filling lets us link the
// payment to the eventual tenant via metadata once webhook fires.
type PublicCheckoutInput struct {
	ProductID string `json:"productId,omitempty"`
	// PriceID is retained for legacy Stripe clients. Dodo clients should send
	// productId or, preferably, the stable tier slug.
	PriceID       string `json:"priceId,omitempty"`
	Tier          string `json:"tier,omitempty"`
	CustomerEmail string `json:"customerEmail"`
	// Optional same-origin override for the success URL. Defaults to
	// PRICING_SUCCESS_URL env var or
	// `{PUBLIC_BASE_URL}/pricing/success?session_id={CHECKOUT_SESSION_ID}`.
	SuccessURL string `json:"successUrl,omitempty"`
	// Optional override for the cancel URL.
	CancelURL string `json:"cancelUrl,omitempty"`
}

// PublicCheckoutResponse is what the marketing site uses to redirect.
type PublicCheckoutResponse struct {
	URL       string `json:"url"`
	SessionID string `json:"sessionId,omitempty"`
}

// PublicCheckout is the public, unauthenticated checkout-session
// creator. Mounted under /api/public/billing/checkout.
//
// Returns:
//
//	200 {url}                            — session created, redirect here
//	400 invalid_request                  — missing email / unknown tier
//	503 checkout_not_configured          — selected provider is incomplete
//	502 payment_provider_request_failed  — selected provider rejected the request
func (h *Handlers) PublicCheckout(w http.ResponseWriter, r *http.Request) {
	var in PublicCheckoutInput
	if err := httpbody.DecodeJSON(w, r, publicCheckoutMaxBodyBytes, &in); err != nil {
		writeJSON(w, httpbody.StatusCode(err), errEnv(httpbody.ErrorCode(err), httpbody.PublicMessage(err)))
		return
	}
	in.CustomerEmail = strings.TrimSpace(in.CustomerEmail)
	if in.CustomerEmail == "" || !strings.Contains(in.CustomerEmail, "@") {
		writeJSON(w, http.StatusBadRequest, errEnv(
			"invalid_email",
			"customerEmail is required and must look like an email"))
		return
	}
	if !billingLaunchApproved() {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"checkout_launch_blocked",
			"paid checkout is disabled until the approved billing launch record is configured"))
		return
	}
	if configuredProvider() == ProviderDodo {
		h.publicDodoCheckout(w, r, in)
		return
	}

	// Resolve the price id. Either the caller sent it directly OR we
	// look it up from the tier slug against the env-configured
	// STRIPE_PRICE_* vars. We don't accept arbitrary price ids that
	// aren't in our env — the marketing site must reference one of the
	// known price-env vars so we can audit allowed SKUs.
	priceID, err := resolvePriceID(in)
	if err != nil {
		if errors.Is(err, errStripePriceNotConfigured) {
			writeJSON(w, http.StatusServiceUnavailable, errEnv(
				"checkout_not_configured",
				"the selected plan is not configured for Stripe Checkout"))
			return
		}
		// resolvePriceID only returns errors authored in this file
		// (constant strings + fmt.Errorf with controlled inputs) so
		// echoing the message is safe and useful for the caller.
		httperror.Write(w, http.StatusBadRequest, "invalid_price", err.Error())
		return
	}

	secret := strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY"))
	if secret == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"checkout_not_configured",
			"Stripe Checkout isn't configured on this Moosewave server. "+
				"Set STRIPE_SECRET_KEY + the matching STRIPE_PRICE_* env "+
				"vars to enable. See docs/RELEASE.md §7."))
		return
	}

	successURL, err := trustedCheckoutReturnURL(in.SuccessURL, defaultSuccessURL())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_return_url", err.Error()))
		return
	}
	cancelURL, err := trustedCheckoutReturnURL(in.CancelURL, defaultCancelURL())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_return_url", err.Error()))
		return
	}

	// The approved Price mapping, not caller-supplied labels, decides whether
	// Stripe creates a one-time payment or a recurring subscription.
	mode := sessionModeFor(priceID)

	// Public callers cannot select a tenant. Existing signed-in tenants use the
	// authenticated Checkout handler; this flow always resolves or creates the
	// tenant server-side from the paid email after Stripe confirms payment.
	clientRef := "auto:" + in.CustomerEmail
	sess, sErr := createStripeCheckoutSession(r.Context(), secret, stripeCheckoutCreate{
		PriceID:           priceID,
		Mode:              mode,
		CustomerEmail:     in.CustomerEmail,
		ClientReferenceID: clientRef,
		SuccessURL:        successURL,
		CancelURL:         cancelURL,
		Origin:            "marketing_pricing_page",
	})
	if sErr != nil {
		// sErr may wrap network errors or Stripe-authored messages that
		// could leak upstream internals. Log full detail server-side and
		// surface a generic 502 to the unauthenticated caller.
		if h.Logger != nil {
			h.Logger.Error("public checkout stripe session create failed",
				"err", sErr.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "stripe_request_failed",
			"upstream Stripe request failed")
		return
	}
	writeJSON(w, http.StatusOK, PublicCheckoutResponse{
		URL:       sess.URL,
		SessionID: sess.ID,
	})
}

// resolvePriceID maps the request shape onto a concrete price id we'll
// pass to Stripe. Tier slugs are resolved against the env-configured
// price map so the only allowed prices are the ones operators have
// explicitly approved.
func resolvePriceID(in PublicCheckoutInput) (string, error) {
	pid := strings.TrimSpace(in.PriceID)
	if pid != "" {
		if !strings.HasPrefix(pid, "price_") {
			return "", errors.New("priceId must be a Stripe Price ID")
		}
		// Verify the price id matches one of the configured envs —
		// don't let arbitrary prices be passed through.
		if !priceIDIsKnown(pid) {
			return "", fmt.Errorf("priceId %q is not in the configured STRIPE_PRICE_* env vars", pid)
		}
		if configuredPriceRoleCount(pid) != 1 {
			return "", fmt.Errorf("%w: duplicate Stripe Price ID", errStripePriceNotConfigured)
		}
		return pid, nil
	}
	tier := strings.ToLower(strings.TrimSpace(in.Tier))
	switch tier {
	case "studio_ltd", "ltd", "studio":
		v := strings.TrimSpace(os.Getenv("STRIPE_PRICE_LTD"))
		if v == "" {
			return "", fmt.Errorf("%w: STRIPE_PRICE_LTD env var not set", errStripePriceNotConfigured)
		}
		if !strings.HasPrefix(v, "price_") {
			return "", fmt.Errorf("%w: STRIPE_PRICE_LTD must be a Stripe Price ID", errStripePriceNotConfigured)
		}
		if configuredPriceRoleCount(v) != 1 {
			return "", fmt.Errorf("%w: duplicate Stripe Price ID", errStripePriceNotConfigured)
		}
		return v, nil
	case "launch", "studio_ltd_cloud", "sending":
		v := strings.TrimSpace(os.Getenv("STRIPE_PRICE_SENDING"))
		if v == "" {
			return "", fmt.Errorf("%w: STRIPE_PRICE_SENDING env var not set", errStripePriceNotConfigured)
		}
		if !strings.HasPrefix(v, "price_") {
			return "", fmt.Errorf("%w: STRIPE_PRICE_SENDING must be a Stripe Price ID", errStripePriceNotConfigured)
		}
		if configuredPriceRoleCount(v) != 1 {
			return "", fmt.Errorf("%w: duplicate Stripe Price ID", errStripePriceNotConfigured)
		}
		return v, nil
	case "scale", "studio_ltd_plus", "pro":
		v := strings.TrimSpace(os.Getenv("STRIPE_PRICE_PRO"))
		if v == "" {
			return "", fmt.Errorf("%w: STRIPE_PRICE_PRO env var not set", errStripePriceNotConfigured)
		}
		if !strings.HasPrefix(v, "price_") {
			return "", fmt.Errorf("%w: STRIPE_PRICE_PRO must be a Stripe Price ID", errStripePriceNotConfigured)
		}
		if configuredPriceRoleCount(v) != 1 {
			return "", fmt.Errorf("%w: duplicate Stripe Price ID", errStripePriceNotConfigured)
		}
		return v, nil
	default:
		return "", fmt.Errorf("either priceId or a known tier must be set (got tier=%q)", in.Tier)
	}
}

// priceIDIsKnown returns true iff the candidate matches one of the
// STRIPE_PRICE_* env vars. Empty env vars never match.
func priceIDIsKnown(candidate string) bool {
	return configuredPriceRoleCount(candidate) > 0
}

func configuredPriceRoleCount(candidate string) int {
	count := 0
	for _, name := range []string{"STRIPE_PRICE_LTD", "STRIPE_PRICE_SENDING", "STRIPE_PRICE_PRO"} {
		v := strings.TrimSpace(os.Getenv(name))
		if v != "" && v == candidate {
			count++
		}
	}
	return count
}

// sessionModeFor chooses payment vs subscription from the operator-approved
// Price mapping. priceId wins during resolution, so the caller's optional tier
// label must never be allowed to change the mode of a different Price.
func sessionModeFor(priceID string) string {
	if priceID != "" && priceID == strings.TrimSpace(os.Getenv("STRIPE_PRICE_LTD")) {
		return "payment"
	}
	return "subscription"
}

func defaultSuccessURL() string {
	if v := strings.TrimSpace(os.Getenv("PRICING_SUCCESS_URL")); v != "" {
		return v
	}
	base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/")
	if base == "" {
		base = "https://moosewave.com"
	}
	return base + "/pricing/success?session_id={CHECKOUT_SESSION_ID}"
}

func defaultCancelURL() string {
	if v := strings.TrimSpace(os.Getenv("PRICING_CANCEL_URL")); v != "" {
		return v
	}
	base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/")
	if base == "" {
		base = "https://moosewave.com"
	}
	return base + "/pricing"
}

// trustedCheckoutReturnURL prevents the unauthenticated checkout endpoint from
// turning Stripe into an open redirect. Operator-configured defaults remain
// trusted, while request overrides must stay on PUBLIC_BASE_URL's exact origin.
func trustedCheckoutReturnURL(candidate, fallback string) (string, error) {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return fallback, nil
	}
	allowedBase := strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL"))
	if allowedBase == "" {
		allowedBase = "https://moosewave.com"
	}
	allowed, err := url.Parse(allowedBase)
	if err != nil || allowed.Scheme == "" || allowed.Host == "" {
		return "", errors.New("checkout return URL origin is not configured")
	}
	target, err := url.Parse(candidate)
	if err != nil || target.Scheme == "" || target.Host == "" || target.User != nil {
		return "", errors.New("successUrl and cancelUrl must be absolute HTTP(S) URLs")
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return "", errors.New("successUrl and cancelUrl must be absolute HTTP(S) URLs")
	}
	if !strings.EqualFold(target.Scheme, allowed.Scheme) || !strings.EqualFold(target.Host, allowed.Host) {
		return "", errors.New("successUrl and cancelUrl must use the configured public origin")
	}
	return candidate, nil
}

// stripeCheckoutCreate is the input to the Stripe form-encoded POST.
type stripeCheckoutCreate struct {
	PriceID           string
	Mode              string // "payment" | "subscription"
	CustomerID        string // existing Stripe customer; mutually exclusive with CustomerEmail
	CustomerEmail     string
	ClientReferenceID string // optional
	SuccessURL        string
	CancelURL         string
	TenantID          string
	Origin            string
}

// stripeCheckoutSessionResponse is the slice of the Stripe response
// shape we actually care about (id + url; the full Session object is
// huge).
type stripeCheckoutSessionResponse struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// stripeErrorResponse mirrors Stripe's error envelope.
type stripeErrorResponse struct {
	Error struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

// createStripeCheckoutSession POSTs to Stripe's Checkout API and
// returns the {id, url}. Errors retain Stripe's detail for structured server
// logs; public handlers deliberately return a generic upstream failure.
func createStripeCheckoutSession(
	ctx context.Context,
	secret string,
	in stripeCheckoutCreate,
) (*stripeCheckoutSessionResponse, error) {
	form := url.Values{}
	form.Set("mode", in.Mode)
	form.Set("success_url", in.SuccessURL)
	form.Set("cancel_url", in.CancelURL)
	form.Set("line_items[0][price]", in.PriceID)
	form.Set("line_items[0][quantity]", "1")
	if strings.TrimSpace(in.CustomerID) != "" {
		form.Set("customer", strings.TrimSpace(in.CustomerID))
	} else {
		form.Set("customer_email", in.CustomerEmail)
	}
	if in.ClientReferenceID != "" {
		form.Set("client_reference_id", in.ClientReferenceID)
	}
	origin := strings.TrimSpace(in.Origin)
	if origin == "" {
		origin = "marketing_pricing_page"
	}
	form.Set("metadata[origin]", origin)
	if in.TenantID != "" {
		form.Set("metadata[tenant_id]", in.TenantID)
		if in.Mode == "subscription" {
			form.Set("subscription_data[metadata][tenant_id]", in.TenantID)
		}
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		stripeAPIBase+"/v1/checkout/sessions",
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return nil, fmt.Errorf("build stripe request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// Stripe pins the API version per request; we let the account
	// default win unless the operator overrode it. (Setting this here
	// also documents that we're aware of API-version drift.)
	if v := strings.TrimSpace(os.Getenv("STRIPE_API_VERSION")); v != "" {
		req.Header.Set("Stripe-Version", v)
	}

	resp, err := stripeHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stripe http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, stripeCheckoutResponseMaxBytes)

	if resp.StatusCode >= 400 {
		if readErr != nil {
			return nil, fmt.Errorf("stripe HTTP %d: %w", resp.StatusCode, readErr)
		}
		var se stripeErrorResponse
		_ = json.Unmarshal(body, &se)
		msg := strings.TrimSpace(se.Error.Message)
		if msg == "" {
			msg = fmt.Sprintf("stripe HTTP %d", resp.StatusCode)
		}
		return nil, errors.New(msg)
	}
	if readErr != nil {
		return nil, fmt.Errorf("decode stripe response: %w", readErr)
	}

	var out stripeCheckoutSessionResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode stripe response: %w", err)
	}
	if out.URL == "" {
		return nil, errors.New("stripe response missing url")
	}
	return &out, nil
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return body, nil
}
