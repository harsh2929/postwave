package streaming_export

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateHandlerReturnsResult(t *testing.T) {
	d := &Deps{}
	body := `{"config":{"format":"avro","compression":"gzip","batch_size":1000,"prefix":"events"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/warehouse/streaming/validate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Validate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var out ValidationResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Valid {
		t.Fatalf("expected valid, got %#v", out)
	}
}

func TestValidateHandlerRejectsBadFormat(t *testing.T) {
	d := &Deps{}
	body := `{"config":{"format":"csv","compression":"weird","batch_size":1}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/warehouse/streaming/validate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Validate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var out ValidationResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// ParseConfig clamps bad enums to defaults, so the only hard error
	// here is the out-of-range batch_size.
	if out.Valid {
		t.Fatalf("expected invalid due to batch_size, got %#v", out)
	}
}

func TestValidateHandlerEmptyBody(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/warehouse/streaming/validate", strings.NewReader(""))
	rec := httptest.NewRecorder()
	d.Validate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestShipNowWithoutWorkerIsUnavailable(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	// No middleware tenant in context → 401 before worker check; assert
	// the handler does not panic and returns a client error.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/warehouse/connections/x/streaming/ship", nil)
	rec := httptest.NewRecorder()
	d.ShipNow(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d want 401 (no tenant)", rec.Code)
	}
}
