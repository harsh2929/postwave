package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/runtime"
)

// POST /v1/automations and PATCH /v1/automations/{id} did not exist. The SDK
// ships both, the MCP tool calls both, and both 404'd at the upstream.
//
// These tests drive the handlers through the REAL in-memory store rather than a
// stub, because the interesting behaviour is at the seam: the SDK sends
// {type, config} and the canonical structs are flat, so a node's settings can
// be lost between the wire and the row without anything erroring. The
// assertions read the stored graph back and check the settings arrived.

func newMemHandlers() (*Handlers, *runtime.MemoryResolver) {
	mem := runtime.NewMemoryResolver()
	return &Handlers{Automations: mem}, mem
}

func do(t *testing.T, h *Handlers, method, path, body, tenant string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	Register(r, h)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if tenant != "" {
		req.Header.Set("X-Tenant-Id", tenant)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

const sdkShapedCreate = `{
  "name": "Welcome series",
  "triggers": [{"type": "list_joined", "config": {"list_id": "list-42"}}],
  "nodes": [
    {"id": "n1", "type": "send_email", "config": {"template_id": "tpl-7"}},
    {"id": "n2", "type": "wait", "config": {"duration_seconds": 3600}}
  ],
  "edges": [{"from": "n1", "to": "n2"}]
}`

func TestCreateIsRoutedAndReturns201(t *testing.T) {
	h, _ := newMemHandlers()
	rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, "t-1")
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var out canonical.Automation
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not JSON: %s", rec.Body.String())
	}
	if out.ID == "" || out.Status != "draft" || out.TenantID != "t-1" {
		t.Fatalf("unexpected: %+v", out)
	}
}

func TestCreateFlattensSDKConfigIntoCanonicalFields(t *testing.T) {
	// The seam this file exists for. Without the adapter these are all zero
	// and the automation would send no template and wait no time.
	h, mem := newMemHandlers()
	rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, "t-1")
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var out canonical.Automation
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	stored, err := mem.LookupAutomation(context.Background(), out.ID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if stored.Triggers[0].ListID != "list-42" {
		t.Fatalf("trigger config was dropped: %+v", stored.Triggers[0])
	}
	if stored.Nodes[0].TemplateID != "tpl-7" {
		t.Fatalf("node config was dropped: %+v", stored.Nodes[0])
	}
	if stored.Nodes[1].DurationSeconds != 3600 {
		t.Fatalf("numeric config was dropped: %+v", stored.Nodes[1])
	}
}

func TestCreateFoldsBranchEdgesOntoTheBranchNode(t *testing.T) {
	// canonical.AutomationEdge has no branch field; the engine reads
	// TrueNext/FalseNext on the node. A dropped label routes wrongly, silently.
	body := `{
	  "name": "Split",
	  "triggers": [{"type": "list_joined"}],
	  "nodes": [
	    {"id": "b", "type": "branch"},
	    {"id": "yes", "type": "send_email"},
	    {"id": "no", "type": "send_email"}
	  ],
	  "edges": [{"from": "b", "to": "yes", "branch": "true"}, {"from": "b", "to": "no", "branch": "false"}]
	}`
	h, mem := newMemHandlers()
	rec := do(t, h, http.MethodPost, "/v1/automations", body, "t-1")
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var out canonical.Automation
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	stored, _ := mem.LookupAutomation(context.Background(), out.ID)
	b := stored.FindNode("b")
	if b == nil || b.TrueNext == nil || *b.TrueNext != "yes" || b.FalseNext == nil || *b.FalseNext != "no" {
		t.Fatalf("branch labels were not folded onto the node: %+v", b)
	}
}

func TestCreateRejectsAnUnknownBranchLabel(t *testing.T) {
	body := `{"name":"x","triggers":[{"type":"list_joined"}],
	  "nodes":[{"id":"b","type":"branch"},{"id":"y","type":"send_email"}],
	  "edges":[{"from":"b","to":"y","branch":"maybe"}]}`
	h, _ := newMemHandlers()
	rec := do(t, h, http.MethodPost, "/v1/automations", body, "t-1")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateRejectsAGraphTheEngineCouldNotRun(t *testing.T) {
	cases := map[string]string{
		"no triggers":                       `{"name":"x","triggers":[],"nodes":[{"id":"n","type":"send_email"}],"edges":[]}`,
		"no nodes":                          `{"name":"x","triggers":[{"type":"list_joined"}],"nodes":[],"edges":[]}`,
		"empty name":                        `{"name":"  ","triggers":[{"type":"list_joined"}],"nodes":[{"id":"n","type":"send_email"}],"edges":[]}`,
		"dangling edge":                     `{"name":"x","triggers":[{"type":"list_joined"}],"nodes":[{"id":"n","type":"send_email"}],"edges":[{"from":"n","to":"ghost"}]}`,
		"duplicate id":                      `{"name":"x","triggers":[{"type":"list_joined"}],"nodes":[{"id":"n","type":"send_email"},{"id":"n","type":"wait"}],"edges":[]}`,
		"only a trigger node, no successor": `{"name":"x","triggers":[{"type":"list_joined"}],"nodes":[{"id":"t","type":"trigger"}],"edges":[]}`,
		"every_n_days without time":         `{"name":"x","triggers":[{"type":"every_n_days","config":{"every_n_days":3}}],"nodes":[{"id":"n","type":"send_email"}],"edges":[]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			h, _ := newMemHandlers()
			rec := do(t, h, http.MethodPost, "/v1/automations", body, "t-1")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"invalid_automation"`) {
				t.Fatalf("expected the invalid_automation code: %s", rec.Body.String())
			}
		})
	}
}

func TestCreatedAutomationIsListable(t *testing.T) {
	// The reason ListByTenant exists beside ListActiveByTenant: a fresh draft
	// is not active, and an agent that creates one and cannot see it has been
	// told its work vanished.
	h, _ := newMemHandlers()
	if rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, "t-1"); rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	rec := do(t, h, http.MethodGet, "/v1/automations", "", "t-1")
	var page struct {
		Items      []canonical.Automation `json:"items"`
		NextCursor *string                `json:"next_cursor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("not a page: %s", rec.Body.String())
	}
	if len(page.Items) != 1 || page.Items[0].Status != "draft" {
		t.Fatalf("the draft must be listed: %s", rec.Body.String())
	}
	// And the SDK's status filter works both ways.
	if rec := do(t, h, http.MethodGet, "/v1/automations?status=active", "", "t-1"); !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Fatalf("status=active must exclude the draft: %s", rec.Body.String())
	}
	if rec := do(t, h, http.MethodGet, "/v1/automations?status=bogus", "", "t-1"); rec.Code != http.StatusBadRequest {
		t.Fatalf("an unknown status filter must be 400, got %d", rec.Code)
	}
}

func TestUpdateMergesAndValidatesTheResult(t *testing.T) {
	h, mem := newMemHandlers()
	rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, "t-1")
	var created canonical.Automation
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	// A partial patch must leave untouched fields alone.
	rec = do(t, h, http.MethodPatch, "/v1/automations/"+created.ID, `{"status":"active","name":"Welcome v2"}`, "t-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	stored, _ := mem.LookupAutomation(context.Background(), created.ID)
	if stored.Status != "active" || stored.Name != "Welcome v2" {
		t.Fatalf("patch not applied: %+v", stored)
	}
	if stored.Nodes[0].TemplateID != "tpl-7" {
		t.Fatalf("a partial patch wiped the graph: %+v", stored.Nodes)
	}

	// A patch that breaks the graph is refused and leaves the row as it was.
	rec = do(t, h, http.MethodPatch, "/v1/automations/"+created.ID, `{"nodes":[]}`, "t-1")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an emptied graph, got %d", rec.Code)
	}
	stored, _ = mem.LookupAutomation(context.Background(), created.ID)
	if len(stored.Nodes) != 2 {
		t.Fatalf("a rejected patch must not be applied: %+v", stored.Nodes)
	}

	// A bad status is refused by vocabulary, not by the column.
	if rec := do(t, h, http.MethodPatch, "/v1/automations/"+created.ID, `{"status":"archived"}`, "t-1"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a status outside the vocabulary, got %d", rec.Code)
	}
}

func TestUpdateIs404ForAnotherTenantsAutomation(t *testing.T) {
	h, _ := newMemHandlers()
	rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, "t-1")
	var created canonical.Automation
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if rec := do(t, h, http.MethodPatch, "/v1/automations/"+created.ID, `{"name":"stolen"}`, "t-2"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 across tenants, got %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPatch, "/v1/automations/nope", `{"name":"x"}`, "t-1"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown id, got %d", rec.Code)
	}
}

func TestWritesAre503WhenNoStoreIsWired(t *testing.T) {
	h := &Handlers{}
	if rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, "t-1"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPatch, "/v1/automations/x", `{"name":"x"}`, "t-1"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

func TestWritesRequireATenant(t *testing.T) {
	h, _ := newMemHandlers()
	if rec := do(t, h, http.MethodPost, "/v1/automations", sdkShapedCreate, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}
