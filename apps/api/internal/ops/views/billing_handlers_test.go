package views

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeBilling struct {
	rows []BillingRow
	err  error
}

func (f fakeBilling) BillingByTenant(_ context.Context, _ int) ([]BillingRow, error) {
	return f.rows, f.err
}

func TestBillingHandler_OKAndFailLoud(t *testing.T) {
	ok := BillingHandler(fakeBilling{rows: []BillingRow{{TenantID: "t1", Tier: "pro", MonthlyCap: 500000}}})
	w := httptest.NewRecorder()
	ok(w, httptest.NewRequest("GET", "/views/billing/by-tenant", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", w.Code)
	}
	bad := BillingHandler(fakeBilling{err: context.DeadlineExceeded})
	w2 := httptest.NewRecorder()
	bad(w2, httptest.NewRequest("GET", "/views/billing/by-tenant", nil))
	if w2.Code != http.StatusInternalServerError {
		t.Fatalf("failed read must be 500, got %d", w2.Code)
	}
}
