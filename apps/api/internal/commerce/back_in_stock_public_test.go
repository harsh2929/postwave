// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicBackInStockSubscribe(t *testing.T) {
	store := &fakeStore{integration: &Integration{ID: "cm_1", TenantID: "tenant-1", Provider: ProviderShopify}}
	d := &Deps{Repo: store, VerifyBackInStockProof: func(context.Context, string, string, string, string) error { return nil }}

	body := `{"shop_domain":"acme.myshopify.com","product_id":"shopify-prod-123","variant_id":"v-9","email":"Buyer@Example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/back-in-stock/subscribe", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PublicBackInStockSubscribe(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out["ok"] != true || out["status"] != "waiting" {
		t.Fatalf("response=%v", out)
	}
}

func TestPublicBackInStockSubscribeValidation(t *testing.T) {
	d := &Deps{Repo: &fakeStore{integration: &Integration{ID: "cm_1", TenantID: "tenant-1"}}}
	cases := []string{
		`{"shop_domain":"acme.myshopify.com","product_id":"p","email":"not-an-email"}`, // bad email
		`{"shop_domain":"","product_id":"p","email":"a@b.com"}`,                        // no shop
		`{"shop_domain":"acme.myshopify.com","product_id":"","email":"a@b.com"}`,       // no product
	}
	for _, body := range cases {
		req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		d.PublicBackInStockSubscribe(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status=%d want 400", body, rec.Code)
		}
	}
}

func TestPublicBackInStockSubscribeUnknownStore(t *testing.T) {
	d := &Deps{Repo: &fakeStore{integration: nil}, VerifyBackInStockProof: func(context.Context, string, string, string, string) error { return nil }} // FindShopifyIntegrationByShop -> (nil,nil)
	req := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader(`{"shop_domain":"ghost.myshopify.com","product_id":"p","email":"a@b.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PublicBackInStockSubscribe(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d want 404 for an unconnected store", rec.Code)
	}
}

func TestPublicBackInStockSubscribeFailsClosedWithoutStorefrontProofVerifier(t *testing.T) {
	d := &Deps{Repo: &fakeStore{integration: &Integration{ID: "cm_1", TenantID: "tenant-1"}}}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(
		`{"shop_domain":"acme.myshopify.com","product_id":"p","email":"a@b.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PublicBackInStockSubscribe(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "storefront_proof_unavailable") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
