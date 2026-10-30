// SPDX-License-Identifier: AGPL-3.0-only
//
// tips_checkout.go — minimal Stripe Checkout session-create wrapper
// for the archive Tips/Donations gap feature (`archive-tips-donations`).
// Lives in the billing package because the existing
// createStripeCheckoutSession helper (public_checkout.go) is private to
// this package; rather than export it we expose a narrow adapter that
// satisfies `archive.StripeCheckoutCreator`.
//
// Why a separate file:
//   - public_checkout.go's session-create uses a fixed Stripe Price ID
//     (the marketing-site /pricing flow). Tips are custom-amount per
//     click; we have to use `price_data` inline rather than a Price.
//   - The product description is per-tenant ("Tip — {publication}"),
//     so a single shared session-create helper would have to carry an
//     extra ProductName field. Keeping the two flows separate is
//     simpler and lets tips evolve independently.

package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// TipSessionInput is the input shape for CreateTipCheckoutSession.
// Mirrors archive.StripeTipSessionInput byte-for-byte (kept here as a
// duplicate type so the billing package doesn't have to import archive,
// which would cause a cycle since main wires both).
type TipSessionInput struct {
	TenantID      string
	TipID         string
	AmountMinor   int
	Currency      string // ISO 4217 lowercase
	CustomerEmail string
	ProductName   string
	SuccessURL    string
	CancelURL     string
}

// CreateTipCheckoutSession mints a Stripe Checkout session for a
// custom-amount tip. Returns (sessionID, redirectURL, error).
//
// Wire shape (Stripe Checkout `price_data` form-encoded):
//
//	mode=payment
//	line_items[0][price_data][currency]=usd
//	line_items[0][price_data][unit_amount]=500
//	line_items[0][price_data][product_data][name]=Tip — Publication
//	line_items[0][quantity]=1
//	success_url=...
//	cancel_url=...
//	client_reference_id=tip:<tipID>          ← lets webhook identify flow
//	metadata[postwave_kind]=archive_tip      ← redundant safety net
//	metadata[postwave_tenant_id]=<uuid>
//	metadata[postwave_tip_id]=<uuid>
//	customer_email=<email>                   ← optional
//
// `secret` is the Stripe secret key (caller passes it so tests can pin
// a fake server's known-value secret). Empty `secret` returns an error
// so the public-checkout endpoint surfaces 503 instead of silently
// 4xx-ing.
func CreateTipCheckoutSession(ctx context.Context, secret string, p TipSessionInput) (string, string, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		secret = strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY"))
	}
	if secret == "" {
		return "", "", errors.New("Stripe Checkout is not configured (STRIPE_SECRET_KEY unset)")
	}
	if p.AmountMinor <= 0 {
		return "", "", errors.New("tip amount must be positive")
	}
	if p.Currency == "" {
		p.Currency = "usd"
	}
	productName := strings.TrimSpace(p.ProductName)
	if productName == "" {
		productName = "Tip"
	}

	form := url.Values{}
	form.Set("mode", "payment")
	form.Set("success_url", p.SuccessURL)
	form.Set("cancel_url", p.CancelURL)
	form.Set("line_items[0][quantity]", "1")
	form.Set("line_items[0][price_data][currency]", p.Currency)
	form.Set("line_items[0][price_data][unit_amount]", strconv.Itoa(p.AmountMinor))
	form.Set("line_items[0][price_data][product_data][name]", productName)
	// Identifies the flow on the webhook side.
	form.Set("client_reference_id", "tip:"+p.TipID)
	form.Set("metadata[postwave_kind]", "archive_tip")
	form.Set("metadata[postwave_tenant_id]", p.TenantID)
	form.Set("metadata[postwave_tip_id]", p.TipID)
	if p.CustomerEmail != "" {
		form.Set("customer_email", p.CustomerEmail)
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		stripeAPIBase+"/v1/checkout/sessions",
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return "", "", fmt.Errorf("build stripe request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if apiV := strings.TrimSpace(os.Getenv("STRIPE_API_VERSION")); apiV != "" {
		req.Header.Set("Stripe-Version", apiV)
	}

	resp, err := stripeHTTPClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("stripe http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, stripeCheckoutResponseMaxBytes)

	if resp.StatusCode >= 400 {
		if readErr != nil {
			return "", "", fmt.Errorf("stripe HTTP %d: %w", resp.StatusCode, readErr)
		}
		var se stripeErrorResponse
		_ = json.Unmarshal(body, &se)
		msg := strings.TrimSpace(se.Error.Message)
		if msg == "" {
			msg = fmt.Sprintf("stripe HTTP %d", resp.StatusCode)
		}
		return "", "", errors.New(msg)
	}
	if readErr != nil {
		return "", "", fmt.Errorf("decode stripe response: %w", readErr)
	}
	var out stripeCheckoutSessionResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return "", "", fmt.Errorf("decode stripe response: %w", err)
	}
	if out.URL == "" {
		return "", "", errors.New("stripe response missing url")
	}
	return out.ID, out.URL, nil
}
