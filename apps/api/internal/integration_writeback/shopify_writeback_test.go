// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type shopifyMock struct {
	gotToken    string
	sawCustomer bool
	sawTagsAdd  bool
	sawMetafld  bool
	tagsSent    []string
	metafields  []map[string]any
	customerID  string // returned by the customers query; "" = not found
}

func (m *shopifyMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m.gotToken = r.Header.Get("X-Shopify-Access-Token")
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.Unmarshal(body, &req)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(req.Query, "customers(first:1"):
			m.sawCustomer = true
			if m.customerID == "" {
				_, _ = w.Write([]byte(`{"data":{"customers":{"edges":[]}}}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"customers":{"edges":[{"node":{"id":"` + m.customerID + `"}}]}}}`))
		case strings.Contains(req.Query, "tagsAdd"):
			m.sawTagsAdd = true
			if raw, ok := req.Variables["tags"].([]any); ok {
				for _, t := range raw {
					m.tagsSent = append(m.tagsSent, t.(string))
				}
			}
			_, _ = w.Write([]byte(`{"data":{"tagsAdd":{"userErrors":[]}}}`))
		case strings.Contains(req.Query, "metafieldsSet"):
			m.sawMetafld = true
			if raw, ok := req.Variables["metafields"].([]any); ok {
				for _, mf := range raw {
					m.metafields = append(m.metafields, mf.(map[string]any))
				}
			}
			_, _ = w.Write([]byte(`{"data":{"metafieldsSet":{"metafields":[{"id":"gid://shopify/Metafield/1"}],"userErrors":[]}}}`))
		default:
			http.Error(w, "unexpected query", http.StatusBadRequest)
		}
	}
}

func TestShopifyWriteProfileTagsAndMetafields(t *testing.T) {
	mock := &shopifyMock{customerID: "gid://shopify/Customer/123"}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := ShopifyWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "shptest"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "VIP@Example.com", Tags: []string{"Moosewave-VIP", "High-Value"}, Fields: map[string]string{"clv_tier": "gold"}},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.TagsWritten != 2 || res.FieldsWritten != 1 {
		t.Fatalf("result=%+v", res)
	}
	if mock.gotToken != "shptest" {
		t.Fatalf("access token header not sent: %q", mock.gotToken)
	}
	if !mock.sawCustomer || !mock.sawTagsAdd || !mock.sawMetafld {
		t.Fatalf("missing calls: customer=%v tagsAdd=%v metafields=%v", mock.sawCustomer, mock.sawTagsAdd, mock.sawMetafld)
	}
	if len(mock.tagsSent) != 2 || mock.tagsSent[0] != "Moosewave-VIP" {
		t.Fatalf("tags not appended via tagsAdd: %+v", mock.tagsSent)
	}
	if len(mock.metafields) != 1 ||
		mock.metafields[0]["ownerId"] != "gid://shopify/Customer/123" ||
		mock.metafields[0]["namespace"] != "postwave" ||
		mock.metafields[0]["key"] != "clv_tier" ||
		mock.metafields[0]["value"] != "gold" {
		t.Fatalf("metafield input wrong: %+v", mock.metafields)
	}
}

type shopifyBatchMock struct {
	existing     map[string]string // lowercased email -> gid
	lookupCalls  int
	metafields   []map[string]any
	tagsAddCalls int
}

func (m *shopifyBatchMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.Unmarshal(body, &req)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(req.Query, "customers(first:250"):
			m.lookupCalls++
			edges := make([]string, 0)
			for email, gid := range m.existing {
				edges = append(edges, `{"node":{"id":"`+gid+`","email":"`+email+`"}}`)
			}
			_, _ = w.Write([]byte(`{"data":{"customers":{"edges":[` + strings.Join(edges, ",") + `]}}}`))
		case strings.Contains(req.Query, "metafieldsSet"):
			if raw, ok := req.Variables["metafields"].([]any); ok {
				ids := make([]string, 0, len(raw))
				for _, mf := range raw {
					m.metafields = append(m.metafields, mf.(map[string]any))
					ids = append(ids, `{"id":"gid://shopify/Metafield/x"}`)
				}
				_, _ = w.Write([]byte(`{"data":{"metafieldsSet":{"metafields":[` + strings.Join(ids, ",") + `],"userErrors":[]}}}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"metafieldsSet":{"metafields":[],"userErrors":[]}}}`))
		case strings.Contains(req.Query, "tagsAdd"):
			m.tagsAddCalls++
			// Echo an empty-userErrors object per alias.
			obj := map[string]any{}
			for k := range req.Variables {
				if strings.HasPrefix(k, "id") {
					obj["a"+strings.TrimPrefix(k, "id")] = map[string]any{"userErrors": []any{}}
				}
			}
			payload, _ := json.Marshal(map[string]any{"data": obj})
			_, _ = w.Write(payload)
		default:
			http.Error(w, "unexpected query: "+req.Query, http.StatusBadRequest)
		}
	}
}

func TestShopifyBatchWrite(t *testing.T) {
	mock := &shopifyBatchMock{existing: map[string]string{
		"a@x.com": "gid://shopify/Customer/1",
		"b@x.com": "gid://shopify/Customer/2",
	}}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := ShopifyWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.BatchWrite(context.Background(),
		map[string]string{"token": "shptest"},
		map[string]any{"api_base_url": srv.URL},
		[]ProfileWrite{
			{Email: "A@X.com", Tags: []string{"VIP"}, Fields: map[string]string{"clv": "gold"}},
			{Email: "b@x.com", Tags: []string{"VIP"}, Fields: map[string]string{"clv": "silver"}},
			{Email: "ghost@x.com", Tags: []string{"VIP"}, Fields: map[string]string{"clv": "bronze"}}, // not in Shopify
		},
	)
	if err != nil {
		t.Fatalf("BatchWrite: %v", err)
	}
	if res.Matched != 2 || res.FieldsWritten != 2 || res.TagsWritten != 2 || res.RowsFailed != 0 {
		t.Fatalf("result=%+v want {Matched:2 FieldsWritten:2 TagsWritten:2 RowsFailed:0}", res)
	}
	// One OR'd lookup for the whole chunk (not one per email).
	if mock.lookupCalls != 1 {
		t.Fatalf("expected a single batched lookup, got %d", mock.lookupCalls)
	}
	// Only the two matched customers get metafields — the ghost is never created.
	if len(mock.metafields) != 2 {
		t.Fatalf("expected 2 metafield inputs (matched only), got %d", len(mock.metafields))
	}
	if mock.tagsAddCalls != 1 {
		t.Fatalf("expected one aliased tagsAdd request for the chunk, got %d", mock.tagsAddCalls)
	}
}

func TestShopifyEscapeSearchValue(t *testing.T) {
	// Backslash escaped first, then the single quote — so a value can't break out
	// of the email:'...' search term.
	if got := shopifyEscapeSearchValue(`a'b\c`); got != `a\'b\\c` {
		t.Fatalf("escape = %q, want %q", got, `a\'b\\c`)
	}
}

func TestShopifyWriteProfileCustomerNotFound(t *testing.T) {
	mock := &shopifyMock{customerID: ""} // no match
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()
	adapter := ShopifyWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "shptest"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "ghost@example.com", Tags: []string{"X"}},
	)
	if err != nil {
		t.Fatalf("a missing customer is not an error: %v", err)
	}
	if res.Matched || res.TagsWritten != 0 {
		t.Fatalf("expected unmatched no-op, got %+v", res)
	}
	if mock.sawTagsAdd {
		t.Fatal("must not attempt tagsAdd when the customer was not found")
	}
}

func TestShopifyWriteProfileComposesEndpointFromShopDomain(t *testing.T) {
	url, err := shopifyGraphQLEndpoint(map[string]any{"shop_domain": "acme", "api_version": "2026-04"})
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://acme.myshopify.com/admin/api/2026-04/graphql.json" {
		t.Fatalf("endpoint=%q", url)
	}
}

func TestShopifyWriteProfileRequiresToken(t *testing.T) {
	adapter := ShopifyWritebackAdapter{}
	if _, err := adapter.WriteProfile(context.Background(), map[string]string{}, map[string]any{"shop_domain": "acme"}, ProfileWrite{Email: "x@y.com"}); err == nil {
		t.Fatal("expected an error without an access token")
	}
}
