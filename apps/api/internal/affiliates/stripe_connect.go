// SPDX-License-Identifier: AGPL-3.0-only
//
// stripe_connect.go — Stripe Connect Transfer execution for affiliate
// payouts. When an affiliate's payout_method is 'stripe_connect' and
// they have a payout_email recorded, the AdminCreatePayout handler
// (after creating the local payout row) calls ExecuteTransfer to fire
// a Stripe Transfers API call into their connected account.
//
// We use Stripe's Transfers endpoint (not Payouts) because affiliates
// have Connect accounts under our platform — Transfers move money
// from our balance into theirs, and Stripe issues the per-affiliate
// payout to their bank from there.
//
// Idempotency: each transfer uses the local payout id as the
// Idempotency-Key so a retried call after a transient failure does
// NOT double-charge.

package affiliates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// stripeAPIBase is overridable for tests.
var stripeAPIBase = "https://api.stripe.com"

// StripeConnectClient executes Transfers against a connected account.
// The Secret field is the platform's secret key (sk_live_... or
// sk_test_...). DestinationAccountID is the affiliate's connected
// account id (acct_...).
type StripeConnectClient struct {
	Secret string
	HTTP   *http.Client
}

// NewStripeConnectClient reads STRIPE_SECRET_KEY from env. Returns nil
// when no key is configured (callers MUST gracefully fall back to a
// manual-payout flag when the client is nil).
func NewStripeConnectClient() *StripeConnectClient {
	secret := strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY"))
	if secret == "" {
		return nil
	}
	return &StripeConnectClient{
		Secret: secret,
		HTTP:   &http.Client{Timeout: 15 * time.Second},
	}
}

// TransferResult is the subset of Stripe's Transfer object we care
// about.
type TransferResult struct {
	ID           string `json:"id"`
	Amount       int64  `json:"amount"`
	Currency     string `json:"currency"`
	Destination  string `json:"destination"`
	Created      int64  `json:"created"`
	BalanceTxnID string `json:"balance_transaction"`
}

// ErrStripeNotConfigured is returned when ExecuteTransfer is called
// without a STRIPE_SECRET_KEY.
var ErrStripeNotConfigured = errors.New("affiliates: stripe connect not configured")

// ExecuteTransfer creates a Stripe Transfer to the destination
// connected account. amountCents is in the lowest currency unit
// (e.g. 12345 = $123.45 for USD). idempotencyKey should be the
// local AffiliatePayout.ID so retries collapse correctly.
func (c *StripeConnectClient) ExecuteTransfer(
	ctx context.Context,
	destinationAccountID string,
	amountCents int64,
	currency string,
	description string,
	idempotencyKey string,
) (*TransferResult, error) {
	if c == nil || c.Secret == "" {
		return nil, ErrStripeNotConfigured
	}
	if destinationAccountID == "" {
		return nil, errors.New("affiliates: destination_account_id required")
	}
	if amountCents <= 0 {
		return nil, errors.New("affiliates: transfer amount must be > 0")
	}
	if currency == "" {
		currency = "usd"
	}

	form := url.Values{}
	form.Set("amount", strconv.FormatInt(amountCents, 10))
	form.Set("currency", strings.ToLower(currency))
	form.Set("destination", destinationAccountID)
	if description != "" {
		form.Set("description", description)
	}
	form.Set("metadata[postwave_payout_id]", idempotencyKey)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		stripeAPIBase+"/v1/transfers", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build stripe transfer request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if idempotencyKey != "" {
		// Stripe expects Idempotency-Key per their docs (lowercase 'k').
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	if v := strings.TrimSpace(os.Getenv("STRIPE_API_VERSION")); v != "" {
		req.Header.Set("Stripe-Version", v)
	}

	httpC := c.HTTP
	if httpC == nil {
		httpC = http.DefaultClient
	}
	resp, err := httpC.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stripe transfer http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

	if resp.StatusCode >= 400 {
		// Try to surface Stripe's structured error.
		var se struct {
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &se)
		if se.Error.Message != "" {
			return nil, fmt.Errorf("stripe %d %s: %s",
				resp.StatusCode, se.Error.Code, se.Error.Message)
		}
		return nil, fmt.Errorf("stripe %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out TransferResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("stripe transfer decode: %w", err)
	}
	return &out, nil
}
