package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

func newSequenceValidationHandler(t *testing.T) (*Handler, *MemorySequenceStore) {
	t.Helper()
	store := NewMemorySequenceStore()
	if err := store.Save(context.Background(), generation.Sequence{
		ID: "seq-validation", TenantID: "tenant-1", Name: "Draft", Status: "draft",
		Steps: []generation.Step{{
			Type: generation.StepTypeEmail, Position: 1,
			Email: &generation.EmailConfig{Subject: "Before", Body: "Before body"},
		}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
		Engine: &generation.Engine{}, Templates: templates.NewMemoryStore(), Sequences: store,
	})
	return h, store
}

func TestSequencePatchRejectsUnknownNoopAndMalformedShapesWithoutVersionBump(t *testing.T) {
	tooDeep := `{"steps":[{"type":"condition","position":1,"condition":{"predicate":"opened_previous","yes_branch":[{"type":"condition","position":1,"condition":{"predicate":"clicked_any","yes_branch":[{"type":"condition","position":1,"condition":{"predicate":"opened_previous","yes_branch":[{"type":"exit","position":1}],"no_branch":[]}}],"no_branch":[]}}],"no_branch":[]}}]}`
	tests := map[string]string{
		"empty object":              `{}`,
		"unknown field":             `{"naem":"Typo"}`,
		"semantic no-op":            `{"name":" Draft "}`,
		"empty ops":                 `{"ops":[]}`,
		"op with extra payload":     `{"ops":[{"op":"delete","step_id":1,"step":{"type":"exit","position":1}}]}`,
		"op identifier above bound": `{"ops":[{"op":"delete","step_id":10001}]}`,
		"mismatched step payload":   `{"steps":[{"type":"email","position":1,"email":{"subject":"Hi","body":"Body"},"delay":{"seconds":60}}]}`,
		"exit with payload":         `{"steps":[{"type":"exit","position":1,"tag":{"tag":"unexpected"}}]}`,
		"unsupported predicate":     `{"steps":[{"type":"condition","position":1,"condition":{"predicate":"arbitrary_sql","yes_branch":[],"no_branch":[]}}]}`,
		"unbounded delay":           `{"steps":[{"type":"delay","position":1,"delay":{"seconds":31536001}}]}`,
		"excessive nesting":         tooDeep,
		"subject newline":           `{"steps":[{"type":"email","position":1,"email":{"subject":"hello\nBcc: x@example.test","body":"Body"}}]}`,
		"unknown nested step field": `{"steps":[{"type":"exit","position":1,"mystery":true}]}`,
	}

	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			h, store := newSequenceValidationHandler(t)
			rec := patchSequence(h, "seq-validation", body, "tenant-1")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
			}
			stored, err := store.Get(context.Background(), "tenant-1", "seq-validation")
			if err != nil {
				t.Fatalf("get: %v", err)
			}
			if stored.Version != 1 || stored.Name != "Draft" || stored.Steps[0].Email.Subject != "Before" {
				t.Fatalf("rejected patch changed row: %+v", stored)
			}
		})
	}
}

func TestValidateStepsBoundsTotalNodesAndText(t *testing.T) {
	steps := make([]generation.Step, sequenceMaxNodes+1)
	for i := range steps {
		steps[i] = generation.Step{Type: generation.StepTypeExit, Position: i + 1}
	}
	if err := validateSteps(steps); err == nil || !strings.Contains(err.Error(), "maximum") {
		t.Fatalf("expected total-node bound, got %v", err)
	}

	steps = []generation.Step{{
		Type: generation.StepTypeEmail, Position: 1,
		Email: &generation.EmailConfig{
			Subject: "Subject",
			Body:    strings.Repeat("x", sequenceMaxBodyRunes+1),
		},
	}}
	if err := validateSteps(steps); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected body bound, got %v", err)
	}
}

func FuzzValidateSequenceStepsNeverPanics(f *testing.F) {
	f.Add(`[{"type":"email","position":1,"email":{"subject":"Hi","body":"Body"}}]`)
	f.Add(`[{"type":"condition","position":1,"condition":{"predicate":"tag_present","value":"vip","yes_branch":[],"no_branch":[]}}]`)
	f.Fuzz(func(t *testing.T, raw string) {
		if len(raw) > 64*1024 {
			t.Skip()
		}
		var steps []generation.Step
		if err := json.Unmarshal([]byte(raw), &steps); err != nil || len(steps) == 0 {
			return
		}
		_ = validateSteps(steps)
	})
}
