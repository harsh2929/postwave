package billing

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateDodoCheckoutSession(t *testing.T) {
	var got dodoCheckoutRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/checkouts" {
			t.Fatalf("request = %s %s, want POST /checkouts", r.Method, r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Fatalf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"session_id":"cks_123","checkout_url":"https://checkout.dodopayments.com/cks_123"}`))
	}))
	defer server.Close()

	oldBase, oldClient := dodoAPIBaseOverride, dodoHTTPClient
	dodoAPIBaseOverride = server.URL
	dodoHTTPClient = server.Client()
	t.Cleanup(func() {
		dodoAPIBaseOverride = oldBase
		dodoHTTPClient = oldClient
	})

	session, err := createDodoCheckoutSession(t.Context(), "test-key", dodoCheckoutCreate{
		ProductID:     "pdt_sending",
		CustomerEmail: "owner@example.com",
		TenantID:      "tenant-123",
		Tier:          "growth",
		Origin:        "dashboard",
		ReturnURL:     "https://app.moosewave.com/app/billing?checkout=success",
		CancelURL:     "https://app.moosewave.com/app/billing?checkout=cancelled",
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.SessionID != "cks_123" {
		t.Fatalf("session id = %q", session.SessionID)
	}
	if len(got.ProductCart) != 1 || got.ProductCart[0].ProductID != "pdt_sending" || got.ProductCart[0].Quantity != 1 {
		t.Fatalf("product cart = %+v", got.ProductCart)
	}
	if got.Customer.Email != "owner@example.com" || got.Metadata["tenant_id"] != "tenant-123" || got.Metadata["tier"] != "growth" {
		t.Fatalf("checkout attribution = customer:%+v metadata:%+v", got.Customer, got.Metadata)
	}
	if !got.FeatureFlags.RedirectImmediately {
		t.Fatal("redirect_immediately was not enabled")
	}
}

func TestResolveDodoProductRejectsDuplicateConfiguration(t *testing.T) {
	t.Setenv("DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY", "pdt_duplicate")
	t.Setenv("DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY", "pdt_duplicate")
	t.Setenv("DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY", "pdt_scale")
	if _, _, err := resolveDodoProduct(PublicCheckoutInput{Tier: "launch"}); err == nil {
		t.Fatal("duplicate product mapping was accepted")
	}
}
