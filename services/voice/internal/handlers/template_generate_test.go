package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

func newTemplateGenTestHandler(llm profile.LLMClient) *Handler {
	return New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{LLM: llm},
		Templates: templates.NewMemoryStore(),
		Sequences: NewMemorySequenceStore(),
	})
}

func postTemplateGenerate(h *Handler, body, tenant string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/templates/generate", strings.NewReader(body))
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestGenerateTemplateRequiresTenant(t *testing.T) {
	h := newTemplateGenTestHandler(&profile.MockLLMClient{})
	if rec := postTemplateGenerate(h, `{"brief":"Spring sale"}`, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestGenerateTemplateValidatesBody(t *testing.T) {
	for name, body := range map[string]string{
		"missing brief":  `{}`,
		"blank brief":    `{"brief":"   "}`,
		"bad kind":       `{"brief":"ok","kind":"poem"}`,
		"not json":       `not json`,
		"tone too long":  `{"brief":"ok","tone":"` + strings.Repeat("x", 201) + `"}`,
		"brief too long": `{"brief":"` + strings.Repeat("y", 8001) + `"}`,
	} {
		h := newTemplateGenTestHandler(&profile.MockLLMClient{})
		if rec := postTemplateGenerate(h, body, "tenant-1"); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestGenerateTemplateQuotaExceededIs429(t *testing.T) {
	q := &overQuota{}
	h := newTemplateGenTestHandler(&profile.MockLLMClient{}).WithQuota(q)
	rec := postTemplateGenerate(h, `{"brief":"Spring sale"}`, "tenant-1")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
	if q.gotKind != "template_generate" {
		t.Errorf("quota kind = %q, want template_generate", q.gotKind)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode 429 body: %v", err)
	}
	if body["error"] != "quota_exceeded" || body["kind"] != "template_generate" {
		t.Errorf("429 body = %v", body)
	}
}

func TestGenerateTemplateLLMNotWiredIs503(t *testing.T) {
	h := newTemplateGenTestHandler(nil) // Engine with nil LLM → ErrLLMNotWired
	if rec := postTemplateGenerate(h, `{"brief":"Spring sale"}`, "tenant-1"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
}

func TestGenerateTemplateGarbageLLMOutputIs502(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`no json here at all`)}
	h := newTemplateGenTestHandler(llm)
	if rec := postTemplateGenerate(h, `{"brief":"Spring sale"}`, "tenant-1"); rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", rec.Code, rec.Body.String())
	}
}

func TestGenerateTemplateHappyPathShape(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "Spring promo",
		"subject": "Save 20% on {{product_name}}",
		"body_html": "<p>Hello {{first_name}},</p><p><a href=\"{{cta_url}}\">Shop now</a></p>",
		"body_mjml": "<mjml><mj-body></mj-body></mjml>"
	}`)}
	h := newTemplateGenTestHandler(llm)
	rec := postTemplateGenerate(h, `{"brief":"Spring sale on coffee gear","kind":"promo","tone":"urgent"}`, "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var resp generation.GeneratedTemplate
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Name != "Spring promo" || !strings.Contains(resp.Subject, "{{product_name}}") {
		t.Errorf("resp = %+v", resp)
	}
	if !strings.Contains(resp.BodyHTML, "{{cta_url}}") || !strings.Contains(resp.BodyMJML, "<mjml>") {
		t.Errorf("bodies = %q / %q", resp.BodyHTML, resp.BodyMJML)
	}
}
