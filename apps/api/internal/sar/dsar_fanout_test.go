package sar

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/sar/store_adapters"
)

// fakeAdapter is a programmable store_adapters.Adapter for the fan-out
// decision tests — no HTTP server needed.
type fakeAdapter struct {
	provider  string
	match     store_adapters.CustomerMatch
	searchErr error
	del       store_adapters.DeleteResult
	delErr    error
	deleted   bool
}

func (f *fakeAdapter) Provider() string { return f.provider }
func (f *fakeAdapter) SearchCustomer(ctx context.Context, cfg store_adapters.Config, email string) (store_adapters.CustomerMatch, error) {
	return f.match, f.searchErr
}
func (f *fakeAdapter) DeleteCustomer(ctx context.Context, cfg store_adapters.Config, customerID string) (store_adapters.DeleteResult, error) {
	f.deleted = true
	return f.del, f.delErr
}

// withFakeAdapter swaps adapterFor to return fa and restores it after fn.
func withFakeAdapter(fa *fakeAdapter, fn func()) {
	prev := adapterFor
	adapterFor = func(provider string) (store_adapters.Adapter, error) {
		if fa == nil {
			return nil, store_adapters.ErrUnsupportedProvider
		}
		return fa, nil
	}
	defer func() { adapterFor = prev }()
	fn()
}

func TestFanoutOne_NotFound(t *testing.T) {
	fa := &fakeAdapter{provider: "shopify", match: store_adapters.CustomerMatch{Found: false}}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindAccess, storeIntegration{provider: "shopify"}, dsarPolicy{}, "x@y.co")
		if resp.Status != "not_found" {
			t.Errorf("status = %q, want not_found", resp.Status)
		}
		if resp.ActionTaken != "none" {
			t.Errorf("action = %q, want none", resp.ActionTaken)
		}
	})
}

func TestFanoutOne_ReturnOnly(t *testing.T) {
	fa := &fakeAdapter{
		provider: "shopify",
		match:    store_adapters.CustomerMatch{Found: true, CustomerID: "c1", Raw: map[string]any{"id": "c1"}},
	}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindAccess, storeIntegration{provider: "shopify"}, dsarPolicy{policyType: "return_only"}, "x@y.co")
		if resp.Status != "returned" {
			t.Errorf("status = %q, want returned", resp.Status)
		}
		if resp.ActionTaken != "return_only" {
			t.Errorf("action = %q, want return_only", resp.ActionTaken)
		}
		if resp.FoundCustomer != "c1" {
			t.Errorf("customer = %q", resp.FoundCustomer)
		}
		if fa.deleted {
			t.Error("must not delete under return_only policy")
		}
	})
}

func TestFanoutOne_AccessIgnoresLegacyAutoDelete(t *testing.T) {
	fa := &fakeAdapter{
		provider: "woocommerce",
		match:    store_adapters.CustomerMatch{Found: true, CustomerID: "77"},
		del:      store_adapters.DeleteResult{Status: "deleted", ReceiptURL: "https://store/77"},
	}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindAccess,
			storeIntegration{provider: "woocommerce"},
			dsarPolicy{policyType: "auto_delete", autoDelete: true}, "x@y.co")
		if resp.Status != "returned" {
			t.Errorf("status = %q, want returned", resp.Status)
		}
		if resp.ActionTaken != "return_only" {
			t.Errorf("action = %q, want return_only", resp.ActionTaken)
		}
		if fa.deleted {
			t.Fatal("access request invoked DeleteCustomer under legacy auto_delete policy")
		}
	})
}

func TestFanoutToStores_RejectsUnknownOperationBeforeIO(t *testing.T) {
	if _, err := FanoutToStores(context.Background(), nil, "tenant", "x@y.co", "destroy"); err == nil {
		t.Fatal("unknown operation must be rejected before store or provider I/O")
	}
}

func TestFanoutOne_AutoDelete(t *testing.T) {
	fa := &fakeAdapter{
		provider: "woocommerce",
		match:    store_adapters.CustomerMatch{Found: true, CustomerID: "77"},
		del:      store_adapters.DeleteResult{Status: "deleted", ReceiptURL: "https://store/77"},
	}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindErase, storeIntegration{provider: "woocommerce"},
			dsarPolicy{policyType: "auto_delete", autoDelete: true}, "x@y.co")
		if resp.Status != "deleted" {
			t.Errorf("status = %q, want deleted", resp.Status)
		}
		if resp.ActionTaken != "auto_delete" {
			t.Errorf("action = %q, want auto_delete", resp.ActionTaken)
		}
		if resp.ReceiptURL != "https://store/77" {
			t.Errorf("receipt = %q", resp.ReceiptURL)
		}
		if !fa.deleted {
			t.Error("expected delete call under auto_delete policy")
		}
	})
}

func TestFanoutOne_AckRequiredHoldsDelete(t *testing.T) {
	fa := &fakeAdapter{
		provider: "stripe",
		match:    store_adapters.CustomerMatch{Found: true, CustomerID: "cus_1"},
	}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindErase, storeIntegration{provider: "stripe"},
			dsarPolicy{policyType: "auto_delete", autoDelete: true, ackRequired: true}, "x@y.co")
		if resp.Status != "ack_required" {
			t.Errorf("status = %q, want ack_required", resp.Status)
		}
		if fa.deleted {
			t.Error("must NOT delete while ack is required")
		}
	})
}

func TestFanoutOne_ExpiredPolicyFallsBackToReturnOnly(t *testing.T) {
	fa := &fakeAdapter{
		provider: "square",
		match:    store_adapters.CustomerMatch{Found: true, CustomerID: "SQ1"},
	}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindErase, storeIntegration{provider: "square"},
			dsarPolicy{policyType: "auto_delete", autoDelete: true, expired: true}, "x@y.co")
		if resp.Status != "returned" {
			t.Errorf("expired auto_delete should fall back to returned, got %q", resp.Status)
		}
		if fa.deleted {
			t.Error("must not delete under expired policy")
		}
	})
}

func TestFanoutOne_SearchError(t *testing.T) {
	fa := &fakeAdapter{provider: "shopify", searchErr: errors.New("boom")}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindAccess, storeIntegration{provider: "shopify"}, dsarPolicy{}, "x@y.co")
		if resp.Status != "error" {
			t.Errorf("status = %q, want error", resp.Status)
		}
		if resp.ResponseBody["error"] == nil {
			t.Error("expected error detail in response body")
		}
	})
}

func TestFanoutOne_DeleteError(t *testing.T) {
	fa := &fakeAdapter{
		provider: "shopify",
		match:    store_adapters.CustomerMatch{Found: true, CustomerID: "c1"},
		delErr:   errors.New("delete failed"),
	}
	withFakeAdapter(fa, func() {
		resp := fanoutOne(context.Background(), kindErase, storeIntegration{provider: "shopify"},
			dsarPolicy{policyType: "auto_delete", autoDelete: true}, "x@y.co")
		if resp.Status != "error" {
			t.Errorf("status = %q, want error", resp.Status)
		}
		if resp.ActionTaken != "auto_delete" {
			t.Errorf("action = %q, want auto_delete", resp.ActionTaken)
		}
	})
}

func TestFanoutOne_UnsupportedProvider(t *testing.T) {
	withFakeAdapter(nil, func() {
		resp := fanoutOne(context.Background(), kindAccess, storeIntegration{provider: "magento"}, dsarPolicy{}, "x@y.co")
		if resp.Status != "error" {
			t.Errorf("status = %q, want error", resp.Status)
		}
	})
}

// TestStoreResponses_NoTenantGate locks the 401 short-circuit on the admin
// read endpoint (mirrors the package's other no-tenant gates): no tenant in
// context => 401 before any DB work.
func TestStoreResponses_NoTenantGate(t *testing.T) {
	d := &Deps{Pool: nil}
	r := httptest.NewRequest("GET", "/api/v1/sar/requests/abc/store-responses", nil)
	w := httptest.NewRecorder()
	d.StoreResponses(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}
