package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/runtime"
)

// GET /v1/automations did not exist, so nothing could list automations.
//
// The SDK ships `client.automations.list()` and MCP's automations tool calls it,
// both hitting GET /api/v1/automations, which apps/api proxies to
// GET /v1/automations on this service. Register mounted nine routes and that was
// not one of them, so every call 404'd at the upstream.
//
// A CORRECTION TO THE FIRST FIX. The route first landed backed by the runtime's
// ListActiveByTenant and answering {automations: [...]}. Both were wrong: the
// SDK reads `items` (so callers saw undefined), and "active" excludes drafts,
// so an agent that created an automation could not list it. It now reads the
// AutomationStore across every status and answers the SDK's page shape.

type stubStore struct {
	out []*canonical.Automation
	err error
}

func (s stubStore) ListByTenant(_ context.Context, _, _ string) ([]*canonical.Automation, error) {
	return s.out, s.err
}
func (s stubStore) Create(_ context.Context, _ string, _ canonical.Automation) (*canonical.Automation, error) {
	return nil, s.err
}
func (s stubStore) Update(_ context.Context, _, _ string, _ runtime.AutomationPatch) (*canonical.Automation, error) {
	return nil, s.err
}

var _ runtime.AutomationStore = stubStore{}

func listRequest(t *testing.T, h *Handlers, tenant string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	Register(r, h)
	req := httptest.NewRequest(http.MethodGet, "/v1/automations", nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-Id", tenant)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestListAutomationsIsRoutedAtAll(t *testing.T) {
	rec := listRequest(t, &Handlers{Automations: stubStore{}}, "t-1")
	if rec.Code == http.StatusNotFound {
		t.Fatal("GET /v1/automations must be routed")
	}
}

func TestListAutomationsAnswersTheSDKPageShape(t *testing.T) {
	rec := listRequest(t, &Handlers{Automations: stubStore{out: []*canonical.Automation{
		{ID: "a1", TenantID: "t-1", Name: "Welcome", Status: "active"},
		{ID: "j1", TenantID: "t-1", Name: "GUI journey", Status: "draft"},
	}}}, "t-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var page struct {
		Items      []canonical.Automation `json:"items"`
		NextCursor *string                `json:"next_cursor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("body is not JSON: %s", rec.Body.String())
	}
	if len(page.Items) != 2 || page.Items[1].Status != "draft" {
		t.Fatalf("both rows, drafts included, must survive: %s", rec.Body.String())
	}
	if page.NextCursor != nil {
		t.Fatalf("no paging is offered, so next_cursor must be null: %s", rec.Body.String())
	}
}

func TestListAutomationsAlwaysSendsAnArray(t *testing.T) {
	rec := listRequest(t, &Handlers{Automations: stubStore{out: nil}}, "t-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	if string(raw["items"]) != "[]" {
		t.Fatalf("expected [], got %s", string(raw["items"]))
	}
}

func TestListAutomationsRequiresATenant(t *testing.T) {
	if rec := listRequest(t, &Handlers{Automations: stubStore{}}, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without X-Tenant-Id, got %d", rec.Code)
	}
}

func TestListAutomationsStaysOffWhenUnwired(t *testing.T) {
	if rec := listRequest(t, &Handlers{}, "t-1"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 with no store wired, got %d", rec.Code)
	}
}
