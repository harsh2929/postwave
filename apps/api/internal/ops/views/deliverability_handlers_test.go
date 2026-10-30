package views

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeDeliv struct {
	rows []DeliverabilityRow
	err  error
}

func (f fakeDeliv) DeliverabilityByTenant(_ context.Context, _ int) ([]DeliverabilityRow, error) {
	return f.rows, f.err
}

func TestDeliverabilityHandler_OKAndFailLoud(t *testing.T) {
	ok := DeliverabilityHandler(fakeDeliv{rows: []DeliverabilityRow{{TenantID: "t1", Sent7d: 1000, Complained7d: 4, ComplaintRate: 0.004}}})
	w := httptest.NewRecorder()
	ok(w, httptest.NewRequest("GET", "/views/deliverability/by-tenant", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", w.Code)
	}
	bad := DeliverabilityHandler(fakeDeliv{err: context.DeadlineExceeded})
	w2 := httptest.NewRecorder()
	bad(w2, httptest.NewRequest("GET", "/views/deliverability/by-tenant", nil))
	if w2.Code != http.StatusInternalServerError {
		t.Fatalf("a failed read must be 500, got %d", w2.Code)
	}
}
