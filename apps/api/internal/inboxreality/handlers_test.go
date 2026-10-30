// SPDX-License-Identifier: AGPL-3.0-only
package inboxreality

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// withTenant injects a Tenant into the request context. Mirrors the
// pattern used by other handler tests in apps/api/internal/.
func withTenant(r *http.Request, id string) *http.Request {
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: id})
	return r.WithContext(ctx)
}

func newDepsForTests(t *testing.T) *Deps {
	t.Helper()
	store := NewMemoryStore(nil)
	o := NewOrchestrator(store, testSeedRegistry{})
	o.TokenMinter = (&countingMinter{tokens: []string{
		"aaaa1111111111111111111111111111",
		"bbbb2222222222222222222222222222",
		"cccc3333333333333333333333333333",
	}}).next
	return &Deps{Orchestrator: o, Store: store, Seeds: testSeedRegistry{}, ActiveSeedCount: 1}
}

func TestListProviders_RequiresTenant(t *testing.T) {
	d := newDepsForTests(t)
	req := httptest.NewRequest("GET", "/api/v1/inbox-reality/providers", nil)
	rec := httptest.NewRecorder()
	d.ListProviders(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestListProviders_StaticCatalogReturnsAllEightProviders(t *testing.T) {
	d := newDepsForTests(t)
	req := withTenant(httptest.NewRequest("GET", "/api/v1/inbox-reality/providers", nil), "tenant-A")
	rec := httptest.NewRecorder()
	d.ListProviders(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Providers []ProviderInfo `json:"providers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Providers) != len(AllProviders) {
		t.Errorf("expected %d providers, got %d", len(AllProviders), len(resp.Providers))
	}
}

func TestCreateTest_Success(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"subject":"Hi","from":"team@acme.example"}`)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/inbox-reality/tests", body), "tenant-A")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.CreateTest(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	var out CreateTestOutput
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Test.ID == "" || out.HeaderName != "X-Postwave-Test-ID" {
		t.Errorf("expected populated test + standard header name, got %+v", out)
	}
	if len(out.HeaderValue) == 0 || out.HeaderValue[:4] != "irt_" {
		t.Errorf("header value should start with irt_, got %q", out.HeaderValue)
	}
}

func TestCreateTest_RejectsUnknownFields(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"subject":"Hi","sneaky":1}`)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/inbox-reality/tests", body), "tenant-A")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.CreateTest(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for unknown field", rec.Code)
	}
}

func TestCreateExactTestFailsClosedWhenLifecycleDisabled(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"kind":"campaign_assurance","artifactId":"11111111-1111-4111-8111-111111111111","scenarioId":"base"}`)
	req := withTenant(httptest.NewRequest("POST", "/api/v1/inbox-reality/tests", body), "tenant-A")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "exact-disabled")
	rec := httptest.NewRecorder()
	d.CreateTest(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
}

func TestGetTest_ReturnsResultsAndSummary(t *testing.T) {
	d := newDepsForTests(t)
	// Create a test by calling CreateTest directly on the orchestrator.
	out, err := d.Orchestrator.CreateTest(context.Background(), "tenant-A", CreateTestInput{Subject: "X"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Plant two results.
	for _, r := range []RecordResultParams{
		{TestID: out.Test.ID, MailboxID: "gmail-01", Provider: ProviderGmail, Placement: PlacementPrimary, FolderName: "INBOX"},
		{TestID: out.Test.ID, MailboxID: "outlook-01", Provider: ProviderOutlookCom, Placement: PlacementSpam, FolderName: "Junk Email"},
	} {
		if _, err := d.Store.RecordResult(context.Background(), r); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	// Build a chi router so URLParam("id") works.
	r := chi.NewRouter()
	d.MountRoutes(r)
	req := withTenant(httptest.NewRequest("GET", "/api/v1/inbox-reality/tests/"+out.Test.ID, nil), "tenant-A")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var view TestView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.Test.ID != out.Test.ID {
		t.Errorf("returned test id = %q, want %q", view.Test.ID, out.Test.ID)
	}
	if len(view.Results) != 2 {
		t.Errorf("results = %d, want 2", len(view.Results))
	}
	if view.Summary.Total != 2 {
		t.Errorf("summary total = %d, want 2", view.Summary.Total)
	}
	if view.Summary.PrimaryPct != 0.5 || view.Summary.SpamPct != 0.5 {
		t.Errorf("summary pct = primary %f / spam %f, want 0.5/0.5", view.Summary.PrimaryPct, view.Summary.SpamPct)
	}
}

func TestGetTest_NotFound(t *testing.T) {
	d := newDepsForTests(t)
	r := chi.NewRouter()
	d.MountRoutes(r)
	req := withTenant(httptest.NewRequest("GET", "/api/v1/inbox-reality/tests/00000000-0000-0000-0000-000000000000", nil), "tenant-A")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestPivotResult_HappyPath(t *testing.T) {
	d := newDepsForTests(t)
	out, _ := d.Orchestrator.CreateTest(context.Background(), "tenant-A", CreateTestInput{Subject: "Test"})
	body, _ := json.Marshal(map[string]any{
		"headerToken": out.Test.HeaderToken,
		"mailboxId":   "gmail-01",
		"provider":    "gmail",
		"labels":      []string{"INBOX", "CATEGORY_PROMOTIONS"},
		"folder":      "INBOX",
	})
	req := httptest.NewRequest("POST", "/internal/inbox-reality/pivot", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PivotResult(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got Result
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Our local classifier reclassified the labels — even though no
	// folder was set, the CATEGORY_PROMOTIONS label should land on
	// promotions.
	if got.Placement != PlacementPromotions {
		t.Errorf("placement = %q, want promotions", got.Placement)
	}
	if got.Provider != ProviderGmail {
		t.Errorf("provider = %q, want gmail", got.Provider)
	}
}

func TestPivotResult_UnknownProvider(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"headerToken":"x","mailboxId":"m","provider":"unknown_provider"}`)
	req := httptest.NewRequest("POST", "/internal/inbox-reality/pivot", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PivotResult(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPivotResult_TokenNotFound(t *testing.T) {
	d := newDepsForTests(t)
	body := bytes.NewBufferString(`{"headerToken":"irt_doesnotexist","mailboxId":"m","provider":"gmail","folder":"INBOX"}`)
	req := httptest.NewRequest("POST", "/internal/inbox-reality/pivot", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.PivotResult(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestListTests_RespectsTenantBoundary(t *testing.T) {
	d := newDepsForTests(t)
	// Create one test as tenant-A and one as tenant-B; tenant-A's list
	// must NOT return tenant-B's test.
	_, _ = d.Orchestrator.CreateTest(context.Background(), "tenant-A", CreateTestInput{Subject: "A-test"})
	_, _ = d.Orchestrator.CreateTest(context.Background(), "tenant-B", CreateTestInput{Subject: "B-test"})

	req := withTenant(httptest.NewRequest("GET", "/api/v1/inbox-reality/tests", nil), "tenant-A")
	rec := httptest.NewRecorder()
	d.ListTests(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp struct {
		Items []Test `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, it := range resp.Items {
		if it.TenantID != "tenant-A" {
			t.Errorf("cross-tenant leak: tenant-A sees test owned by %q", it.TenantID)
		}
	}
}
