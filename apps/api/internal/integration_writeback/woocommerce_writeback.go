// SPDX-License-Identifier: AGPL-3.0-only
//
// woocommerce_writeback.go — push profile fields onto a WooCommerce customer,
// found by email. WooCommerce customers carry no native tags, so fields and the
// audience tags both land in meta_data ([{key,value}]) — fields keyed directly,
// tags under "postwave_segments". Find via GET /wp-json/wc/v3/customers?email=…,
// update via PUT /wp-json/wc/v3/customers/{id}. Auth: Basic (consumer key/secret).
// Extends two-way write-back to a second commerce platform beyond Shopify.
package integration_writeback

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// WooCommerceWritebackAdapter updates a customer's meta_data.
type WooCommerceWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a WooCommerceWritebackAdapter) Provider() string { return ProviderWooCommerce }

func (a WooCommerceWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

// wooCommerceBase derives the WC REST v3 base. An explicit api_base_url override
// (tests/staging, already including the REST path) wins; otherwise it's the
// store_url + /wp-json/wc/v3.
func wooCommerceBase(settings map[string]any) (string, error) {
	if override := settingString(settings, "api_base_url"); override != "" {
		return strings.TrimRight(override, "/"), nil
	}
	store := settingString(settings, "store_url")
	if store == "" {
		return "", fmt.Errorf("woocommerce write-back requires store_url")
	}
	if !strings.HasPrefix(store, "http") {
		store = "https://" + store
	}
	return strings.TrimRight(store, "/") + "/wp-json/wc/v3", nil
}

func (a WooCommerceWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	key := firstNonEmpty(creds["consumer_key"], creds["key"])
	secret := firstNonEmpty(creds["consumer_secret"], creds["secret"])
	if key == "" || secret == "" {
		return WriteResult{}, fmt.Errorf("woocommerce write-back requires consumer_key + consumer_secret")
	}
	base, err := wooCommerceBase(settings)
	if err != nil {
		return WriteResult{}, err
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}

	id, err := a.findCustomer(ctx, base, key, secret, email)
	if err != nil {
		return WriteResult{}, err
	}
	if id == 0 {
		return WriteResult{Matched: false}, nil
	}
	res := WriteResult{Matched: true}

	meta := make([]map[string]any, 0, len(p.Fields)+1)
	for k, v := range p.Fields {
		meta = append(meta, map[string]any{"key": k, "value": v})
	}
	if len(p.Tags) > 0 {
		meta = append(meta, map[string]any{"key": "postwave_segments", "value": strings.Join(p.Tags, ",")})
	}
	if len(meta) == 0 {
		return res, nil // matched, nothing to write
	}
	if err := a.updateCustomer(ctx, base, key, secret, id, meta); err != nil {
		return res, err
	}
	res.FieldsWritten = len(p.Fields)
	if len(p.Tags) > 0 {
		res.TagsWritten = len(p.Tags)
	}
	return res, nil
}

func (a WooCommerceWritebackAdapter) findCustomer(ctx context.Context, base, key, secret, email string) (int, error) {
	endpoint := base + "/customers?per_page=1&email=" + url.QueryEscape(email)
	resp, body, err := a.do(ctx, http.MethodGet, endpoint, key, secret, nil)
	if err != nil {
		return 0, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("woocommerce customer search http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var out []struct {
		ID    int    `json:"id"`
		Email string `json:"email"`
	}
	_ = json.Unmarshal(body, &out)
	for _, c := range out {
		if c.ID != 0 && strings.EqualFold(strings.TrimSpace(c.Email), email) {
			return c.ID, nil
		}
	}
	return 0, nil
}

func (a WooCommerceWritebackAdapter) updateCustomer(ctx context.Context, base, key, secret string, id int, meta []map[string]any) error {
	payload, _ := json.Marshal(map[string]any{"meta_data": meta})
	endpoint := base + "/customers/" + strconv.Itoa(id)
	resp, body, err := a.do(ctx, http.MethodPut, endpoint, key, secret, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("woocommerce customer update http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	return nil
}

func (a WooCommerceWritebackAdapter) do(ctx context.Context, method, endpoint, key, secret string, payload []byte) (*http.Response, []byte, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, nil, err
	}
	req.SetBasicAuth(key, secret)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return resp, nil, fmt.Errorf("woocommerce rate limited (429); retry after %s", resp.Header.Get("Retry-After"))
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp, body, nil
}
