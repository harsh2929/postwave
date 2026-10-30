package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/deliverability/internal/render"
)

// TestPostRenderIssuesAreArraysForCleanEnvironments renders clean HTML across
// the default matrix through the mounted route with the real static checks.
//
// An environment with nothing to report got a nil issue slice, which marshals
// to `"issues": null`. The web preview client requires an array and rejected
// the whole response ("Cross-client preview N was malformed"), so clean HTML —
// the common case — could not be previewed at all.
func TestPostRenderIssuesAreArraysForCleanEnvironments(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Renderer: render.MockRenderer{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/render",
		strings.NewReader(`{"html":"<table><tr><td>Hello</td></tr></table>"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Renders    []map[string]json.RawMessage `json:"renders"`
		RenderMode string                       `json:"render_mode"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(body.Renders) != len(render.AllEnvironments) {
		t.Fatalf("renders=%d, want the %d-environment matrix", len(body.Renders), len(render.AllEnvironments))
	}
	if body.RenderMode != "placeholder" {
		t.Fatalf("render_mode=%q, want placeholder", body.RenderMode)
	}
	clean := 0
	for i, item := range body.Renders {
		raw := strings.TrimSpace(string(item["issues"]))
		if !strings.HasPrefix(raw, "[") {
			t.Fatalf("renders[%d].issues=%s, want an array", i, raw)
		}
		if raw == "[]" {
			clean++
		}
	}
	if clean == 0 {
		t.Fatal("clean HTML produced no clean environment; the nil-issues path was not exercised")
	}
}

func TestPostRenderEmptyRendererAnswersArray(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Renderer: fakeRenderer{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/render", strings.NewReader(`{"html":"ok"}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"renders":[]`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
