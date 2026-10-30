// SPDX-License-Identifier: AGPL-3.0-only
//
// Shopify DSAR adapter — customer search + erasure via the Admin REST API.
//
//   Search: GET  {host}/admin/api/2024-01/customers/search.json?query=email:<email>
//   Delete: requests a customer redact via the GDPR data-request webhook
//           contract. Shopify does not expose a synchronous "scrub PII" REST
//           call; the merchant-app contract is to acknowledge the
//           customers/redact webhook. For an operator-initiated DSAR we issue
//           DELETE {host}/admin/api/2024-01/customers/{id}.json which removes
//           the customer record (Shopify's strongest operator-available
//           erasure) and return the canonical customer URL as the receipt.

package store_adapters

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// ShopifyAdapter implements Adapter for Shopify.
type ShopifyAdapter struct{}

func (ShopifyAdapter) Provider() string { return ProviderShopify }

func (a ShopifyAdapter) baseURL(cfg Config) string {
	if cfg.BaseURL != "" {
		return strings.TrimRight(cfg.BaseURL, "/")
	}
	dom := strings.TrimRight(cfg.ShopDomain, "/")
	if dom == "" {
		return ""
	}
	if !strings.HasPrefix(dom, "http") {
		dom = "https://" + dom
	}
	return dom
}

// SearchCustomer queries the Shopify customer search endpoint by email.
func (a ShopifyAdapter) SearchCustomer(ctx context.Context, cfg Config, email string) (CustomerMatch, error) {
	base := a.baseURL(cfg)
	if base == "" {
		return CustomerMatch{}, fmt.Errorf("shopify: missing shop domain / base url")
	}
	url := fmt.Sprintf("%s/admin/api/2024-01/customers/search.json?query=%s",
		base, "email:"+queryEscape(email))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return CustomerMatch{}, err
	}
	if cfg.AccessToken != "" {
		req.Header.Set("X-Shopify-Access-Token", cfg.AccessToken)
	}
	var body struct {
		Customers []map[string]any `json:"customers"`
	}
	raw, err := doJSON(cfg.client(), req, &body)
	if err != nil {
		return CustomerMatch{}, err
	}
	if len(body.Customers) == 0 {
		return CustomerMatch{Found: false, Raw: raw}, nil
	}
	first := body.Customers[0]
	return CustomerMatch{
		Found:      true,
		CustomerID: stringifyID(first["id"]),
		Raw:        first,
	}, nil
}

// DeleteCustomer removes the Shopify customer record.
func (a ShopifyAdapter) DeleteCustomer(ctx context.Context, cfg Config, customerID string) (DeleteResult, error) {
	base := a.baseURL(cfg)
	if base == "" {
		return DeleteResult{}, fmt.Errorf("shopify: missing shop domain / base url")
	}
	url := fmt.Sprintf("%s/admin/api/2024-01/customers/%s.json", base, customerID)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return DeleteResult{}, err
	}
	if cfg.AccessToken != "" {
		req.Header.Set("X-Shopify-Access-Token", cfg.AccessToken)
	}
	raw, err := doJSON(cfg.client(), req, nil)
	if err != nil {
		return DeleteResult{}, err
	}
	return DeleteResult{
		Status:     "deleted",
		ReceiptURL: fmt.Sprintf("%s/admin/api/2024-01/customers/%s.json", base, customerID),
		Raw:        raw,
	}, nil
}
