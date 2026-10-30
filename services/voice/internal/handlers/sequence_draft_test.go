package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/quota"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// overQuota always rejects, recording the kind it saw — proves the draft
// endpoint sits behind the same quota gate as the sibling LLM routes.
type overQuota struct{ gotKind string }

func (q *overQuota) CheckAndConsume(_ context.Context, _ string, kind string, _ int) error {
	q.gotKind = kind
	return quota.ErrOverQuota
}

func (q *overQuota) Limits(context.Context, string) (quota.Limits, error) {
	return quota.Limits{DailyTotal: 5}, nil
}

func newDraftTestHandler(llm profile.LLMClient) *Handler {
	return New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{LLM: llm},
		Templates: templates.NewMemoryStore(),
		Sequences: NewMemorySequenceStore(),
	})
}

func postDraft(h *Handler, body, tenant string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/sequences/draft", strings.NewReader(body))
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestDraftSequenceRequiresTenant(t *testing.T) {
	h := newDraftTestHandler(&profile.MockLLMClient{})
	rec := postDraft(h, `{"brief":"Launch a coffee subscription"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestDraftSequenceValidatesBody(t *testing.T) {
	for name, body := range map[string]string{
		"missing brief":        `{}`,
		"blank brief":          `{"brief":"   "}`,
		"step_count too large": `{"brief":"ok","step_count":11}`,
		"step_count negative":  `{"brief":"ok","step_count":-1}`,
		"not json":             `not json`,
		"tone too long":        `{"brief":"ok","tone":"` + strings.Repeat("x", 201) + `"}`,
	} {
		h := newDraftTestHandler(&profile.MockLLMClient{})
		rec := postDraft(h, body, "tenant-1")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestDraftSequenceHappyPathShape(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "Coffee club launch",
		"steps": [
			{"position": 1, "delay_hours": 0,  "subject": "Welcome to the club", "body": "Body one"},
			{"position": 2, "delay_hours": 48, "subject": "Why beans matter",    "body": "Body two"}
		]
	}`)}
	h := newDraftTestHandler(llm)
	rec := postDraft(h, `{"brief":"Launch a coffee subscription","step_count":2,"tone":"playful"}`, "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Name  string           `json:"name"`
		Steps []map[string]any `json:"steps"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Name != "Coffee club launch" {
		t.Errorf("name = %q", resp.Name)
	}
	if len(resp.Steps) != 2 {
		t.Fatalf("steps = %d, want 2", len(resp.Steps))
	}
	for i, s := range resp.Steps {
		for _, k := range []string{"subject", "body", "delay_hours", "position"} {
			if _, ok := s[k]; !ok {
				t.Errorf("step[%d] missing key %q: %v", i, k, s)
			}
		}
	}
	if resp.Steps[1]["delay_hours"] != float64(48) || resp.Steps[1]["position"] != float64(2) {
		t.Errorf("step[1] = %v", resp.Steps[1])
	}
}

func TestDraftSequenceQuotaExceededIs429(t *testing.T) {
	q := &overQuota{}
	h := newDraftTestHandler(&profile.MockLLMClient{})
	h = h.WithQuota(q)
	rec := postDraft(h, `{"brief":"Launch a coffee subscription"}`, "tenant-1")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: %s", rec.Code, rec.Body.String())
	}
	if q.gotKind != "sequence_draft" {
		t.Errorf("quota kind = %q, want sequence_draft", q.gotKind)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode 429 body: %v", err)
	}
	if body["error"] != "quota_exceeded" || body["kind"] != "sequence_draft" {
		t.Errorf("429 body = %v", body)
	}
}

func TestDraftSequenceLLMNotWiredIs503(t *testing.T) {
	h := newDraftTestHandler(nil) // Engine with nil LLM → ErrLLMNotWired
	rec := postDraft(h, `{"brief":"Launch a coffee subscription"}`, "tenant-1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
}

func TestDraftSequenceGarbageLLMOutputIs502(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`totally not json and no object either`)}
	h := newDraftTestHandler(llm)
	rec := postDraft(h, `{"brief":"Launch a coffee subscription"}`, "tenant-1")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", rec.Code, rec.Body.String())
	}
}
