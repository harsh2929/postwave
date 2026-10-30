// SPDX-License-Identifier: AGPL-3.0-only
package emailpreview

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeEngine spins up an httptest server that mimics the Listmonk
// fork's POST /api/templates/preview: it records the submitted body
// and answers with handler-provided HTML/status.
func fakeEngine(t *testing.T, status int, respond func(body string) string) (*EngineRenderer, *string) {
	t.Helper()
	var seenBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/templates/preview" {
			http.Error(w, "wrong route", http.StatusNotFound)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		seenBody = r.PostFormValue("body")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(respond(seenBody)))
	}))
	t.Cleanup(srv.Close)
	return NewEngineRenderer(srv.URL, "user", "pass"), &seenBody
}

func TestRenderPipeline_EngineRendersPlainHTML(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")
	engine, seen := fakeEngine(t, http.StatusOK, func(body string) string {
		return "<html><body><!-- engine wrapper -->" + body + "</body></html>"
	})

	html, renderer, warnings, err := renderPipeline(context.Background(), engine,
		`<p>Hello {{name}}</p>`, map[string]string{"name": "Ada"})
	if err != nil {
		t.Fatalf("renderPipeline: %v", err)
	}
	if renderer != RendererEngine {
		t.Fatalf("renderer = %q, want %q (warnings: %v)", renderer, RendererEngine, warnings)
	}
	if !strings.Contains(html, "engine wrapper") {
		t.Errorf("expected engine-rendered document, got: %s", html)
	}
	// Vars must be substituted BEFORE the engine sees the input so our
	// {{name}} syntax never reaches the engine's template compiler.
	if !strings.Contains(*seen, "Hello Ada") || strings.Contains(*seen, "{{name}}") {
		t.Errorf("engine received unsubstituted body: %q", *seen)
	}
}

func TestRenderPipeline_EngineFailureFallsBackWithLabel(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")
	engine, _ := fakeEngine(t, http.StatusInternalServerError, func(string) string {
		return "template compile error"
	})

	html, renderer, warnings, err := renderPipeline(context.Background(), engine,
		`<p>Hi</p>`, nil)
	if err != nil {
		t.Fatalf("renderPipeline: %v", err)
	}
	if renderer != RendererFallback {
		t.Fatalf("renderer = %q, want %q", renderer, RendererFallback)
	}
	if !strings.Contains(html, "<p>Hi</p>") {
		t.Errorf("pass-through fallback should preserve the input, got: %s", html)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "engine renderer failed") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected engine-failure warning, got %v", warnings)
	}
}

func TestRenderPipeline_NoEnginePlainHTMLIsLabelledFallback(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")

	html, renderer, warnings, err := renderPipeline(context.Background(), nil,
		`<p>Hi</p>`, nil)
	if err != nil {
		t.Fatalf("renderPipeline: %v", err)
	}
	if renderer != RendererFallback {
		t.Fatalf("renderer = %q, want %q (warnings: %v)", renderer, RendererFallback, warnings)
	}
	// Pass-through wraps bare fragments in a document skeleton so the
	// per-client transforms have <html>/<body> anchors.
	if !strings.Contains(html, "<html>") || !strings.Contains(html, "<p>Hi</p>") {
		t.Errorf("expected wrapped pass-through, got: %s", html)
	}
}

func TestRenderPipeline_MJMLInputNeverHitsEngine(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")
	engine, seen := fakeEngine(t, http.StatusOK, func(body string) string { return body })

	_, renderer, _, err := renderPipeline(context.Background(), engine,
		`<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`,
		nil)
	if err != nil {
		t.Fatalf("renderPipeline: %v", err)
	}
	// No CLI in this environment, so the MJML branch downgrades to the
	// stub — but it must not detour through the engine, which can't
	// transform mj-* tags.
	if renderer != RendererFallback {
		t.Fatalf("renderer = %q, want %q", renderer, RendererFallback)
	}
	if *seen != "" {
		t.Errorf("engine should not be called for MJML input; saw body %q", *seen)
	}
}

func TestNewEngineRendererEmptyURLIsNil(t *testing.T) {
	if e := NewEngineRenderer("", "u", "p"); e != nil {
		t.Errorf("expected nil renderer for empty base URL")
	}
	if e := NewEngineRenderer("   ", "u", "p"); e != nil {
		t.Errorf("expected nil renderer for blank base URL")
	}
}

func TestLooksLikeMJML(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{`<mjml><mj-body></mj-body></mjml>`, true},
		{`<MJML>`, true},
		{`<mj-section>`, true},
		{`<p>plain html</p>`, false},
		{`<html><body>x</body></html>`, false},
		// "mj" inside text must not trigger the MJML branch.
		{`<p>i love mjml the framework</p>`, false},
	}
	for _, tc := range cases {
		if got := looksLikeMJML(tc.in); got != tc.want {
			t.Errorf("looksLikeMJML(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
