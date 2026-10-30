package store_adapters

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFor(t *testing.T) {
	for _, p := range []string{ProviderShopify, ProviderWooCommerce, ProviderStripe, ProviderSquare} {
		a, err := For(p)
		if err != nil {
			t.Fatalf("For(%q): %v", p, err)
		}
		if a.Provider() != p {
			t.Errorf("Provider() = %q, want %q", a.Provider(), p)
		}
	}
	if _, err := For("magento"); err != ErrUnsupportedProvider {
		t.Errorf("For(magento) err = %v, want ErrUnsupportedProvider", err)
	}
}

func TestShopifyAdapter_SearchAndDelete(t *testing.T) {
	var gotSearchPath, gotToken, gotDeletePath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Shopify-Access-Token")
		switch {
		case strings.Contains(r.URL.Path, "/search.json"):
			gotSearchPath = r.URL.RequestURI()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customers": []map[string]any{{"id": float64(12345), "email": "a@b.co"}},
			})
		case r.Method == http.MethodDelete:
			gotDeletePath = r.URL.Path
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	a := ShopifyAdapter{}
	cfg := Config{BaseURL: srv.URL, AccessToken: "tok-123"}
	m, err := a.SearchCustomer(context.Background(), cfg, "a@b.co")
	if err != nil {
		t.Fatalf("SearchCustomer: %v", err)
	}
	if !m.Found || m.CustomerID != "12345" {
		t.Fatalf("match = %+v, want found id 12345", m)
	}
	if gotToken != "tok-123" {
		t.Errorf("token header = %q", gotToken)
	}
	if !strings.Contains(gotSearchPath, "email") {
		t.Errorf("search path missing email query: %q", gotSearchPath)
	}

	res, err := a.DeleteCustomer(context.Background(), cfg, m.CustomerID)
	if err != nil {
		t.Fatalf("DeleteCustomer: %v", err)
	}
	if res.Status != "deleted" {
		t.Errorf("delete status = %q, want deleted", res.Status)
	}
	if !strings.Contains(gotDeletePath, "12345") {
		t.Errorf("delete path = %q, want customer id", gotDeletePath)
	}
	if res.ReceiptURL == "" {
		t.Error("expected non-empty receipt url")
	}
}

func TestShopifyAdapter_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"customers": []map[string]any{}})
	}))
	defer srv.Close()
	m, err := ShopifyAdapter{}.SearchCustomer(context.Background(), Config{BaseURL: srv.URL}, "none@b.co")
	if err != nil {
		t.Fatalf("SearchCustomer: %v", err)
	}
	if m.Found {
		t.Errorf("expected not found, got %+v", m)
	}
}

func TestWooCommerceAdapter_SearchAndDelete(t *testing.T) {
	var gotUser, gotPass string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, _ = r.BasicAuth()
		if r.Method == http.MethodDelete {
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"id":77,"deleted":true}`))
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{{"id": float64(77), "email": "w@b.co"}})
	}))
	defer srv.Close()

	a := WooCommerceAdapter{}
	cfg := Config{BaseURL: srv.URL, AccessToken: "ck_key", APISecret: "cs_secret"}
	m, err := a.SearchCustomer(context.Background(), cfg, "w@b.co")
	if err != nil {
		t.Fatalf("SearchCustomer: %v", err)
	}
	if !m.Found || m.CustomerID != "77" {
		t.Fatalf("match = %+v", m)
	}
	if gotUser != "ck_key" || gotPass != "cs_secret" {
		t.Errorf("basic auth = %q:%q", gotUser, gotPass)
	}
	res, err := a.DeleteCustomer(context.Background(), cfg, "77")
	if err != nil {
		t.Fatalf("DeleteCustomer: %v", err)
	}
	if res.Status != "deleted" {
		t.Errorf("status = %q", res.Status)
	}
}

func TestStripeAdapter_SearchAndAnonymize(t *testing.T) {
	var gotAuth, gotForm string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/cus_1") {
			_ = r.ParseForm()
			gotForm = r.Form.Encode()
			_, _ = w.Write([]byte(`{"id":"cus_1","email":""}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"id": "cus_1", "email": "s@b.co"}},
		})
	}))
	defer srv.Close()

	a := StripeAdapter{}
	cfg := Config{BaseURL: srv.URL, AccessToken: "sk_test"}
	m, err := a.SearchCustomer(context.Background(), cfg, "s@b.co")
	if err != nil {
		t.Fatalf("SearchCustomer: %v", err)
	}
	if !m.Found || m.CustomerID != "cus_1" {
		t.Fatalf("match = %+v", m)
	}
	if gotAuth != "Bearer sk_test" {
		t.Errorf("auth = %q", gotAuth)
	}
	res, err := a.DeleteCustomer(context.Background(), cfg, "cus_1")
	if err != nil {
		t.Fatalf("DeleteCustomer: %v", err)
	}
	if res.Status != "deleted" {
		t.Errorf("status = %q", res.Status)
	}
	if !strings.Contains(gotForm, "dsar_anonymized") {
		t.Errorf("anonymize form missing marker: %q", gotForm)
	}
}

func TestSquareAdapter_SearchAndDelete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if r.Header.Get("Square-Version") == "" {
			t.Error("missing Square-Version header")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"customers": []map[string]any{{"id": "SQ123", "email_address": "sq@b.co"}},
		})
	}))
	defer srv.Close()

	a := SquareAdapter{}
	cfg := Config{BaseURL: srv.URL, AccessToken: "sq_tok"}
	m, err := a.SearchCustomer(context.Background(), cfg, "sq@b.co")
	if err != nil {
		t.Fatalf("SearchCustomer: %v", err)
	}
	if !m.Found || m.CustomerID != "SQ123" {
		t.Fatalf("match = %+v", m)
	}
	res, err := a.DeleteCustomer(context.Background(), cfg, "SQ123")
	if err != nil {
		t.Fatalf("DeleteCustomer: %v", err)
	}
	if res.Status != "deleted" {
		t.Errorf("status = %q", res.Status)
	}
}

func TestDoJSON_Non2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"errors":["not found"]}`))
	}))
	defer srv.Close()
	_, err := ShopifyAdapter{}.SearchCustomer(context.Background(), Config{BaseURL: srv.URL}, "x@y.co")
	if err == nil {
		t.Error("expected error on 404")
	}
}

func TestStringifyID(t *testing.T) {
	cases := map[string]any{
		"":    nil,
		"abc": "abc",
		"42":  float64(42),
		"99":  json.Number("99"),
	}
	for want, in := range cases {
		if got := stringifyID(in); got != want {
			t.Errorf("stringifyID(%v) = %q, want %q", in, got, want)
		}
	}
}
