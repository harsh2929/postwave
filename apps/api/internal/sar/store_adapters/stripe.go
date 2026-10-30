// SPDX-License-Identifier: AGPL-3.0-only
//
// Stripe DSAR adapter — customer search + ANONYMISE via the Stripe REST API.
//
//   Search: GET  {host}/v1/customers?email=<email>
//   Delete: Stripe's DELETE /v1/customers/{id} detaches the customer but a
//           hard delete is not always available/desirable (it breaks payment
//           history references). For a DSAR we ANONYMISE instead: POST
//           /v1/customers/{id} clearing name/email/phone and stamping a
//           dsar_anonymized metadata marker. The customer URL is the receipt.
//
// Auth: Bearer secret key.

package store_adapters

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// StripeAdapter implements Adapter for Stripe.
type StripeAdapter struct{}

func (StripeAdapter) Provider() string { return ProviderStripe }

func (a StripeAdapter) baseURL(cfg Config) string {
	if cfg.BaseURL != "" {
		return strings.TrimRight(cfg.BaseURL, "/")
	}
	return "https://api.stripe.com"
}

func (a StripeAdapter) auth(req *http.Request, cfg Config) {
	if cfg.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.AccessToken)
	}
}

// SearchCustomer lists Stripe customers filtered by email.
func (a StripeAdapter) SearchCustomer(ctx context.Context, cfg Config, email string) (CustomerMatch, error) {
	base := a.baseURL(cfg)
	reqURL := fmt.Sprintf("%s/v1/customers?email=%s", base, queryEscape(email))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return CustomerMatch{}, err
	}
	a.auth(req, cfg)
	var body struct {
		Data []map[string]any `json:"data"`
	}
	raw, err := doJSON(cfg.client(), req, &body)
	if err != nil {
		return CustomerMatch{}, err
	}
	if len(body.Data) == 0 {
		return CustomerMatch{Found: false, Raw: raw}, nil
	}
	first := body.Data[0]
	return CustomerMatch{
		Found:      true,
		CustomerID: stringifyID(first["id"]),
		Raw:        first,
	}, nil
}

// DeleteCustomer anonymises the Stripe customer (clears PII, stamps a marker).
func (a StripeAdapter) DeleteCustomer(ctx context.Context, cfg Config, customerID string) (DeleteResult, error) {
	base := a.baseURL(cfg)
	reqURL := fmt.Sprintf("%s/v1/customers/%s", base, customerID)
	form := url.Values{}
	form.Set("name", "")
	form.Set("email", "")
	form.Set("phone", "")
	form.Set("metadata[dsar_anonymized]", "true")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, strings.NewReader(form.Encode()))
	if err != nil {
		return DeleteResult{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	a.auth(req, cfg)
	raw, err := doJSON(cfg.client(), req, nil)
	if err != nil {
		return DeleteResult{}, err
	}
	return DeleteResult{
		Status:     "deleted",
		ReceiptURL: fmt.Sprintf("%s/v1/customers/%s", base, customerID),
		Raw:        raw,
	}, nil
}
