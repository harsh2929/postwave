// SPDX-License-Identifier: AGPL-3.0-only
//
// WooCommerce DSAR adapter — customer search + erasure via the WooCommerce
// REST API v3 (basic auth with consumer key/secret).
//
//   Search: GET    {host}/wp-json/wc/v3/customers?email=<email>
//   Delete: DELETE {host}/wp-json/wc/v3/customers/{id}?force=true
//           (force=true permanently deletes rather than trashing). The
//           canonical customer URL is returned as the deletion receipt.

package store_adapters

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// WooCommerceAdapter implements Adapter for WooCommerce.
type WooCommerceAdapter struct{}

func (WooCommerceAdapter) Provider() string { return ProviderWooCommerce }

func (a WooCommerceAdapter) baseURL(cfg Config) string {
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

func (a WooCommerceAdapter) auth(req *http.Request, cfg Config) {
	if cfg.AccessToken != "" || cfg.APISecret != "" {
		req.SetBasicAuth(cfg.AccessToken, cfg.APISecret)
	}
}

// SearchCustomer queries the WooCommerce customers collection filtered by email.
func (a WooCommerceAdapter) SearchCustomer(ctx context.Context, cfg Config, email string) (CustomerMatch, error) {
	base := a.baseURL(cfg)
	if base == "" {
		return CustomerMatch{}, fmt.Errorf("woocommerce: missing site url")
	}
	url := fmt.Sprintf("%s/wp-json/wc/v3/customers?email=%s", base, queryEscape(email))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return CustomerMatch{}, err
	}
	a.auth(req, cfg)
	var customers []map[string]any
	raw, err := doJSON(cfg.client(), req, &customers)
	if err != nil {
		return CustomerMatch{}, err
	}
	if len(customers) == 0 {
		return CustomerMatch{Found: false, Raw: raw}, nil
	}
	first := customers[0]
	return CustomerMatch{
		Found:      true,
		CustomerID: stringifyID(first["id"]),
		Raw:        first,
	}, nil
}

// DeleteCustomer permanently deletes the WooCommerce customer (force=true).
func (a WooCommerceAdapter) DeleteCustomer(ctx context.Context, cfg Config, customerID string) (DeleteResult, error) {
	base := a.baseURL(cfg)
	if base == "" {
		return DeleteResult{}, fmt.Errorf("woocommerce: missing site url")
	}
	url := fmt.Sprintf("%s/wp-json/wc/v3/customers/%s?force=true", base, customerID)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return DeleteResult{}, err
	}
	a.auth(req, cfg)
	raw, err := doJSON(cfg.client(), req, nil)
	if err != nil {
		return DeleteResult{}, err
	}
	return DeleteResult{
		Status:     "deleted",
		ReceiptURL: fmt.Sprintf("%s/wp-json/wc/v3/customers/%s", base, customerID),
		Raw:        raw,
	}, nil
}
