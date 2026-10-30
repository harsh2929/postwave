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
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// newVariantTestHandler seeds seq-ab (tenant-1): an email step with a
// 50/50 A/B split at position 1, a delay at 2, and a variant-less email
// at position 3.
func newVariantTestHandler(t *testing.T) *Handler {
	t.Helper()
	seqs := NewMemorySequenceStore()
	if err := seqs.Save(context.Background(), generation.Sequence{
		ID:       "seq-ab",
		TenantID: "tenant-1",
		Name:     "AB",
		Status:   "active",
		Steps: []generation.Step{
			{Type: generation.StepTypeEmail, Position: 1, Email: &generation.EmailConfig{
				Subject: "Base", Body: "Base body",
				Variants: []generation.EmailVariant{
					{Key: "A", Subject: "Subject A", Body: "Body A", WeightBP: 5000},
					{Key: "B", Subject: "Subject B", Body: "Body B", BodyHTML: "<p>B</p>", WeightBP: 5000},
				},
			}},
			{Type: generation.StepTypeDelay, Position: 2, Delay: &generation.DelayConfig{}},
			{Type: generation.StepTypeEmail, Position: 3, Email: &generation.EmailConfig{Subject: "Plain", Body: "Plain"}},
		},
	}); err != nil {
		t.Fatalf("seed sequence: %v", err)
	}
	return New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine:    &generation.Engine{},
		Templates: templates.NewMemoryStore(),
		Sequences: seqs,
	})
}

func newVariantDraftTestHandler(t *testing.T) *Handler {
	t.Helper()
	h := newVariantTestHandler(t)
	seq, err := h.gen.Sequences.Get(context.Background(), "tenant-1", "seq-ab")
	if err != nil {
		t.Fatalf("get seeded sequence: %v", err)
	}
	seq.Status = "draft"
	if err := h.gen.Sequences.Save(context.Background(), seq); err != nil {
		t.Fatalf("save draft sequence: %v", err)
	}
	return h
}

func postVariant(h *Handler, target, tenant, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestAssignStepVariantRequiresTenant(t *testing.T) {
	h := newVariantTestHandler(t)
	rec := postVariant(h, "/sequences/seq-ab/steps/1/variant", "", `{"subscriber_id":"subscriber_a"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAssignStepVariantValidatesBodyAndParams(t *testing.T) {
	h := newVariantTestHandler(t)
	for _, tc := range []struct {
		name   string
		target string
		body   string
	}{
		{name: "missing body", target: "/sequences/seq-ab/steps/1/variant"},
		{name: "invalid json", target: "/sequences/seq-ab/steps/1/variant", body: `{`},
		{name: "missing subscriber_id", target: "/sequences/seq-ab/steps/1/variant", body: `{}`},
		{name: "blank subscriber_id", target: "/sequences/seq-ab/steps/1/variant", body: `{"subscriber_id":" "}`},
		{name: "email is not opaque", target: "/sequences/seq-ab/steps/1/variant", body: `{"subscriber_id":"a@x.com"}`},
		{name: "unknown field", target: "/sequences/seq-ab/steps/1/variant", body: `{"subscriber_id":"subscriber_a","subscriber_email":"a@x.com"}`},
		{name: "query identity rejected", target: "/sequences/seq-ab/steps/1/variant?subscriber_email=a@x.com", body: `{"subscriber_id":"subscriber_a"}`},
		{name: "bad position", target: "/sequences/seq-ab/steps/abc/variant", body: `{"subscriber_id":"subscriber_a"}`},
		{name: "zero position", target: "/sequences/seq-ab/steps/0/variant", body: `{"subscriber_id":"subscriber_a"}`},
		{name: "oversized position", target: "/sequences/seq-ab/steps/10001/variant", body: `{"subscriber_id":"subscriber_a"}`},
	} {
		if rec := postVariant(h, tc.target, "tenant-1", tc.body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", tc.name, rec.Code, rec.Body.String())
		}
	}
}

func TestLegacyVariantGETWithEmailQueryIsNotAccepted(t *testing.T) {
	h := newVariantTestHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/sequences/seq-ab/steps/1/variant?subscriber_email=a@x.com", nil)
	req.Header.Set("X-Tenant-ID", "tenant-1")
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("legacy GET status = %d, want 405: %s", rec.Code, rec.Body.String())
	}
}

func TestAssignStepVariantNotFoundCases(t *testing.T) {
	h := newVariantTestHandler(t)
	for name, target := range map[string]string{
		"unknown sequence":    "/sequences/nope/steps/1/variant",
		"delay step":          "/sequences/seq-ab/steps/2/variant",
		"past the end":        "/sequences/seq-ab/steps/9/variant",
		"email sans variants": "/sequences/seq-ab/steps/3/variant",
	} {
		if rec := postVariant(h, target, "tenant-1", `{"subscriber_id":"subscriber_a"}`); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestAssignStepVariantDeterministicAndMatchesAssign(t *testing.T) {
	h := newVariantTestHandler(t)
	variants := []generation.EmailVariant{
		{Key: "A", Subject: "Subject A", Body: "Body A", WeightBP: 5000},
		{Key: "B", Subject: "Subject B", Body: "Body B", BodyHTML: "<p>B</p>", WeightBP: 5000},
	}
	want, err := generation.AssignVariant("seq-ab", 1, "subscriber_alice", variants)
	if err != nil {
		t.Fatalf("AssignVariant: %v", err)
	}
	var first variantAssignmentResponse
	for i := 0; i < 3; i++ {
		rec := postVariant(h, "/sequences/seq-ab/steps/1/variant", "tenant-1", `{"subscriber_id":"subscriber_alice"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d: status = %d: %s", i, rec.Code, rec.Body.String())
		}
		var got variantAssignmentResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.VariantKey != want.Key || got.Subject != want.Subject ||
			got.Body != want.Body || got.BodyHTML != want.BodyHTML || got.WeightBP != want.WeightBP {
			t.Fatalf("call %d: response %+v does not match AssignVariant %+v", i, got, want)
		}
		if i == 0 {
			first = got
		} else if got != first {
			t.Fatalf("call %d: non-deterministic: %+v vs %+v", i, got, first)
		}
	}
	// Surrounding JSON value whitespace is normalized, while the opaque ID's
	// case remains part of its stable identity.
	rec := postVariant(h, "/sequences/seq-ab/steps/1/variant", "tenant-1", `{"subscriber_id":"  subscriber_alice  "}`)
	var got variantAssignmentResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got != first {
		t.Fatalf("trimmed opaque identifier reassigned: %+v vs %+v", got, first)
	}
}

func TestPatchSequenceValidatesVariants(t *testing.T) {
	for name, variants := range map[string]string{
		"single variant": `[{"key":"A","subject":"s","body":"b","weight_bp":10000}]`,
		"bad weight sum": `[{"key":"A","subject":"s","body":"b","weight_bp":5000},
		                    {"key":"B","subject":"s","body":"b","weight_bp":4000}]`,
		"duplicate keys": `[{"key":"A","subject":"s","body":"b","weight_bp":5000},
		                    {"key":"a","subject":"s","body":"b","weight_bp":5000}]`,
		"missing subject": `[{"key":"A","body":"b","weight_bp":5000},
		                     {"key":"B","subject":"s","body":"b","weight_bp":5000}]`,
	} {
		h := newVariantDraftTestHandler(t)
		body := `{"steps":[{"type":"email","position":1,"email":{"subject":"s","body":"b","variants":` + variants + `}}]}`
		rec := patchSequence(h, "seq-ab", body, "tenant-1")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestPatchSequencePersistsValidVariants(t *testing.T) {
	h := newVariantDraftTestHandler(t)
	body := `{"steps":[{"type":"email","position":1,"email":{"subject":"s","body":"b","variants":[
		{"key":"A","subject":"sa","body":"ba","weight_bp":7000},
		{"key":"B","subject":"sb","body":"bb","weight_bp":3000}
	]}}]}`
	rec := patchSequence(h, "seq-ab", body, "tenant-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	saved, err := h.gen.Sequences.Get(context.Background(), "tenant-1", "seq-ab")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got := saved.Steps[0].Email.Variants
	if len(got) != 2 || got[0].Key != "A" || got[0].WeightBP != 7000 || got[1].WeightBP != 3000 {
		t.Fatalf("variants = %+v", got)
	}
}
