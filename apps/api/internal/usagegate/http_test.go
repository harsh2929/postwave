package usagegate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"
)

type fakeMeter struct {
	calls    int
	err      error
	receipt  sharedusage.Receipt
	tenantID string
	resource sharedusage.Resource
	units    int64
	source   string
}

func (f *fakeMeter) Reserve(_ context.Context, tenantID string, resource sharedusage.Resource, units int64, _ string, source string) (sharedusage.Receipt, error) {
	f.calls++
	f.tenantID = tenantID
	f.resource = resource
	f.units = units
	f.source = source
	if f.receipt == (sharedusage.Receipt{}) {
		f.receipt = sharedusage.Receipt{Used: 7, Limit: 100}
	}
	return f.receipt, f.err
}

func TestBrowserSessionTrafficDoesNotConsumeAPIOperations(t *testing.T) {
	meter := &fakeMeter{}
	h := APIOperationMiddleware(meter)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", nil))
	if rec.Code != http.StatusNoContent || meter.calls != 0 {
		t.Fatalf("status=%d calls=%d", rec.Code, meter.calls)
	}
}

func TestMissingMeterFailsAPIKeyTrafficClosed(t *testing.T) {
	h := APIOperationMiddleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("next handler ran without a configured meter")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiKeyRequest())
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestAPIKeyTrafficConsumesOperationAndExposesReceipt(t *testing.T) {
	meter := &fakeMeter{receipt: sharedusage.Receipt{Used: 42, Limit: 100}}
	reached := false
	h := APIOperationMiddleware(meter)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusNoContent)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiKeyRequest())
	if rec.Code != http.StatusNoContent || !reached {
		t.Fatalf("status=%d reached=%v", rec.Code, reached)
	}
	if meter.calls != 1 || meter.tenantID != "00000000-0000-4000-8000-000000000001" || meter.resource != sharedusage.ResourceAPIOperations || meter.units != 1 || meter.source != "authenticated_api" {
		t.Fatalf("unexpected reservation: %+v", meter)
	}
	if got := rec.Header().Get("X-Moosewave-API-Operations-Used"); got != "42" {
		t.Fatalf("used header=%q want 42", got)
	}
	if got := rec.Header().Get("X-Moosewave-API-Operations-Limit"); got != "100" {
		t.Fatalf("limit header=%q want 100", got)
	}
}

func TestExceededAPIOperationUsesCanonicalQuotaDenial(t *testing.T) {
	meter := &fakeMeter{err: &sharedusage.Error{
		Resource: sharedusage.ResourceAPIOperations,
		Tier:     "launch", Limit: 100, Used: 100, Requested: 1,
	}}
	h := APIOperationMiddleware(meter)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("next handler ran after an exceeded reservation")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiKeyRequest())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d want %d", rec.Code, http.StatusTooManyRequests)
	}
	var body struct {
		Error struct {
			Reason   string `json:"reason"`
			Code     string `json:"code"`
			Resource string `json:"resource"`
			Limit    int64  `json:"limit"`
			Current  int64  `json:"current"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Reason != "quota" || body.Error.Code != "api_operations_limit_exceeded" || body.Error.Resource != "api_operations" || body.Error.Limit != 100 || body.Error.Current != 100 {
		t.Fatalf("unexpected denial: %+v", body.Error)
	}
}

func apiKeyRequest() *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001", Tier: "launch"})
	return req.WithContext(ctx)
}
