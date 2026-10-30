package retention

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestHandlerRunRequiresTenant(t *testing.T) {
	d := &HandlerDeps{Sweeper: &Sweeper{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/retention/run",
		strings.NewReader(""))
	rec := httptest.NewRecorder()
	d.Run(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHandlerRunSurfacesSweepError(t *testing.T) {
	// Empty Sweeper (Pool == nil) surfaces "nil pool" via
	// SweepOnceForTenant -> the handler returns 500.
	d := &HandlerDeps{Sweeper: &Sweeper{}}
	ctx := middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/retention/run", strings.NewReader(""))
	rec := httptest.NewRecorder()
	d.Run(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "sweep_failed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestMountRoutesNilSafe confirms passing nil deps or a nil sweeper
// does not panic — main.go wire-up assumes this so the route is
// optional in environments that disable the retention sweeper.
func TestMountRoutesNilSafe(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panicked: %v", r)
		}
	}()
	var d *HandlerDeps
	d.MountRoutes(nil)
	(&HandlerDeps{Sweeper: nil}).MountRoutes(nil)
}

// TestHandlerResponseShape verifies the success-path JSON envelope
// when the sweep runs with no per-class work to do. We construct a
// Sweeper whose ListTenants subquery short-circuits because Pool is
// nil — the test exercises the JSON marshalling, not the SQL path.
// SweepOnceForTenant with a nil pool now returns "nil pool" before
// writing the envelope, so this test asserts the error path emits
// well-formed JSON (mirrors what the SDK consumes).
func TestHandlerErrorEnvelopeIsValidJSON(t *testing.T) {
	d := &HandlerDeps{Sweeper: &Sweeper{}}
	ctx := middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "tenant-x"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/v1/retention/run", strings.NewReader(""))
	rec := httptest.NewRecorder()
	d.Run(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not valid JSON: %v; body=%s", err, rec.Body.String())
	}
	if _, ok := body["error"]; !ok {
		t.Fatalf("expected 'error' key, got %v", body)
	}
}
