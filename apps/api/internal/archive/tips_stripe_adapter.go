// SPDX-License-Identifier: AGPL-3.0-only
//
// tips_stripe_adapter.go — thin adapter that satisfies archive.StripeCheckoutCreator
// by delegating to billing.CreateTipCheckoutSession.
//
// Lives in the archive package (not billing) because the adapter is the
// only point where archive sees a Stripe surface. Keeping it here means
// archive's TipsDeps wiring doesn't have to take a billing dependency at
// the call site (main.go) — main.go constructs this adapter once and
// hands it to TipsDeps.Stripe.
//
// The adapter is intentionally minimal: it copies the input fields one-
// for-one into billing.TipSessionInput (which mirrors the archive shape
// byte-for-byte, see billing/tips_checkout.go). The duplication is
// deliberate — neither package imports the other; this adapter is the
// bridge.
//
// Why a struct rather than a free function:
//   - main.go can stamp the Stripe secret + base URL onto the adapter at
//     wire time, so the public-checkout handler doesn't have to read env
//     vars on every request.
//   - A struct lets us add per-adapter knobs later (e.g. test-server
//     base URL, request timeout overrides) without changing the
//     interface or breaking nil-safety.

package archive

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/billing"
)

// TipsStripeAdapter implements StripeCheckoutCreator by delegating to
// billing.CreateTipCheckoutSession with a captured Stripe secret. Wired
// in main.go where the env-read happens once at startup.
//
// Nil-safe: a zero-value adapter (Secret == "") falls back to reading
// STRIPE_SECRET_KEY on each call so a future config-hot-reload path can
// stamp the secret without restarting the process.
type TipsStripeAdapter struct {
	// Secret is the Stripe `sk_live_...` / `sk_test_...` API key. When
	// empty, CreateTipSession falls back to os.Getenv("STRIPE_SECRET_KEY")
	// so the operator can rotate the key by restarting OR by re-reading
	// the env at request time (the env read is cheap; the Stripe HTTP
	// round-trip dwarfs it by 5+ orders of magnitude).
	Secret string
}

// NewTipsStripeAdapter is the wire-in helper main.go calls. Captures
// the secret once at startup. Pass an empty string to defer to the
// env-var read inside billing.CreateTipCheckoutSession.
func NewTipsStripeAdapter(secret string) *TipsStripeAdapter {
	return &TipsStripeAdapter{Secret: strings.TrimSpace(secret)}
}

// CreateTipSession satisfies archive.StripeCheckoutCreator by forwarding
// to billing.CreateTipCheckoutSession. The input shape is copied one-
// for-one; the two packages keep parallel types so neither has to
// import the other at call sites.
func (a *TipsStripeAdapter) CreateTipSession(ctx context.Context, in StripeTipSessionInput) (string, string, error) {
	if a == nil {
		return "", "", errors.New("archive tips stripe adapter: nil receiver")
	}
	secret := a.Secret
	if secret == "" {
		secret = strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY"))
	}
	return billing.CreateTipCheckoutSession(ctx, secret, billing.TipSessionInput{
		TenantID:      in.TenantID,
		TipID:         in.TipID,
		AmountMinor:   in.AmountMinor,
		Currency:      in.Currency,
		CustomerEmail: in.CustomerEmail,
		ProductName:   in.ProductName,
		SuccessURL:    in.SuccessURL,
		CancelURL:     in.CancelURL,
	})
}

// Compile-time assertion that TipsStripeAdapter satisfies the
// StripeCheckoutCreator surface the archive package exposes. A drift in
// either side (rename, new method) will fail the build here rather than
// at the first request that hits the handler.
var _ StripeCheckoutCreator = (*TipsStripeAdapter)(nil)
