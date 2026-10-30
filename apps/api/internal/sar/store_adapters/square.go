// SPDX-License-Identifier: AGPL-3.0-only
//
// Square DSAR adapter — customer search + delete via the Square REST API.
//
//   Search: POST {host}/v2/customers/search   {"query":{"filter":{"email_address":{"exact":<email>}}}}
//   Delete: DELETE {host}/v2/customers/{id}
//           Square's customer delete removes the customer profile; the
//           customer URL is returned as the deletion receipt.
//
// Auth: Bearer access token. API version pinned via the Square-Version header.

package store_adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// SquareAdapter implements Adapter for Square.
type SquareAdapter struct{}

func (SquareAdapter) Provider() string { return ProviderSquare }

func (a SquareAdapter) baseURL(cfg Config) string {
	if cfg.BaseURL != "" {
		return strings.TrimRight(cfg.BaseURL, "/")
	}
	return "https://connect.squareup.com"
}

func (a SquareAdapter) auth(req *http.Request, cfg Config) {
	if cfg.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.AccessToken)
	}
	req.Header.Set("Square-Version", "2024-01-18")
}

// SearchCustomer searches Square customers by exact email match.
func (a SquareAdapter) SearchCustomer(ctx context.Context, cfg Config, email string) (CustomerMatch, error) {
	base := a.baseURL(cfg)
	reqURL := fmt.Sprintf("%s/v2/customers/search", base)
	payload := map[string]any{
		"query": map[string]any{
			"filter": map[string]any{
				"email_address": map[string]any{"exact": email},
			},
		},
	}
	bodyBytes, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return CustomerMatch{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	a.auth(req, cfg)
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

// DeleteCustomer removes the Square customer profile.
func (a SquareAdapter) DeleteCustomer(ctx context.Context, cfg Config, customerID string) (DeleteResult, error) {
	base := a.baseURL(cfg)
	reqURL := fmt.Sprintf("%s/v2/customers/%s", base, customerID)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, reqURL, nil)
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
		ReceiptURL: fmt.Sprintf("%s/v2/customers/%s", base, customerID),
		Raw:        raw,
	}, nil
}
