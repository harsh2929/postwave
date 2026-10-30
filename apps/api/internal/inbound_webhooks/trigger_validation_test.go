// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func validTriggerConfiguration() Trigger {
	value := "paid"
	return Trigger{
		Name:           "Tag paid customer",
		Active:         true,
		MatchJSONPath:  "$.status",
		MatchOperator:  OpEquals,
		MatchValue:     &value,
		EmailJSONPath:  "$.customer.email",
		ActionType:     ActionAddTag,
		ActionTargetID: "paid",
	}
}

func TestTriggerJSONPathValidationMatchesEvaluatorSubset(t *testing.T) {
	valid := []string{
		"$",
		"$.event_type",
		"$.user.email",
		"$.items[0].sku",
		"$.items[*].sku",
		`$['event.type']`,
		`$["customer email"]`,
		`$['literal*key']`,
	}
	for _, path := range valid {
		t.Run("valid_"+path, func(t *testing.T) {
			if err := validateTriggerJSONPath("match_jsonpath", path); err != nil {
				t.Fatalf("valid path %q rejected: %v", path, err)
			}
		})
	}

	invalid := []string{
		"",
		"user.email",
		"$user.email",
		"$.",
		"$.user.",
		"$.user..email",
		"$.user[",
		"$.items[]",
		"$.items[-1]",
		"$.items[abc]",
		"$.items[0]trailing",
		"$.foo]bar",
		"$.a*b",
		"$.*",
		`$.a\b`,
		`$['unterminated]`,
		`$['escaped\'key']`,
		strings.Repeat("x", maxTriggerJSONPathBytes+1),
	}
	for _, path := range invalid {
		t.Run("invalid_"+path, func(t *testing.T) {
			if err := validateTriggerJSONPath("match_jsonpath", path); !errors.Is(err, ErrInvalidTrigger) {
				t.Fatalf("invalid path %q error = %v, want ErrInvalidTrigger", path, err)
			}
		})
	}

	payload := map[string]any{"user": "must not resolve from a partial expression"}
	if value, ok := QueryJSONPath(payload, "$.user["); ok {
		t.Fatalf("malformed path resolved partial value %v", value)
	}
}

func TestTriggerConfigurationValidationPreflightsOperatorAndActionSemantics(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Trigger)
	}{
		{
			name: "equals requires match value",
			mutate: func(in *Trigger) {
				in.MatchValue = nil
			},
		},
		{
			name: "contains rejects empty operand",
			mutate: func(in *Trigger) {
				in.MatchOperator = OpContains
				empty := ""
				in.MatchValue = &empty
			},
		},
		{
			name: "regex is compiled before persistence",
			mutate: func(in *Trigger) {
				in.MatchOperator = OpRegex
				invalid := "["
				in.MatchValue = &invalid
			},
		},
		{
			name: "regex is bounded before compile",
			mutate: func(in *Trigger) {
				in.MatchOperator = OpRegex
				oversized := strings.Repeat("a", maxTriggerRegexBytes+1)
				in.MatchValue = &oversized
			},
		},
		{
			name: "match JSONPath must be supported",
			mutate: func(in *Trigger) {
				in.MatchJSONPath = "$.status["
			},
		},
		{
			name: "email JSONPath must be supported",
			mutate: func(in *Trigger) {
				in.EmailJSONPath = "$.customer..email"
			},
		},
		{
			name: "sequence target must be UUID",
			mutate: func(in *Trigger) {
				in.ActionType = ActionAddToSequence
				in.ActionTargetID = "seq_not_a_uuid"
			},
		},
		{
			name: "automation target must be UUID",
			mutate: func(in *Trigger) {
				in.ActionType = ActionStartAutomation
				in.ActionTargetID = "automation-not-a-uuid"
			},
		},
		{
			name: "tag target follows catalog contract",
			mutate: func(in *Trigger) {
				in.ActionTargetID = strings.Repeat("t", maxTriggerTagRunes+1)
			},
		},
		{
			name: "tag target rejects control characters",
			mutate: func(in *Trigger) {
				in.ActionTargetID = "paid\ncustomer"
			},
		},
		{
			name: "name is bounded",
			mutate: func(in *Trigger) {
				in.Name = strings.Repeat("n", maxTriggerNameBytes+1)
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := validTriggerConfiguration()
			tt.mutate(&in)
			if _, err := normalizeAndValidateTrigger(in); !errors.Is(err, ErrInvalidTrigger) {
				t.Fatalf("error = %v, want ErrInvalidTrigger", err)
			}
		})
	}
}

func TestTriggerConfigurationValidationCanonicalizesStoredValues(t *testing.T) {
	in := validTriggerConfiguration()
	in.Name = "  Paid customer  "
	in.MatchJSONPath = "  $.status  "
	in.EmailJSONPath = " $.email "
	in.MatchOperator = OpExists
	stale := "ignored"
	in.MatchValue = &stale
	in.ActionType = ActionAddToSequence
	in.ActionTargetID = " {11111111-1111-4111-8111-111111111111} "

	got, err := normalizeAndValidateTrigger(in)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Paid customer" ||
		got.MatchJSONPath != "$.status" ||
		got.EmailJSONPath != "$.email" {
		t.Fatalf("trimmed fields = %#v", got)
	}
	if got.MatchValue != nil {
		t.Fatalf("exists match_value = %q, want nil", *got.MatchValue)
	}
	if got.ActionTargetID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("canonical target = %q", got.ActionTargetID)
	}
}

func TestTriggerCreateHandlerRejectsInvalidConfigurationBeforeRepository(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "malformed JSONPath",
			body: `{"name":"bad path","match_jsonpath":"$.status[","match_operator":"exists",` +
				`"email_jsonpath":"$.email","action_type":"add_tag","action_target_id":"paid"}`,
		},
		{
			name: "invalid regex",
			body: `{"name":"bad regex","match_jsonpath":"$.status","match_operator":"regex",` +
				`"match_value":"[","email_jsonpath":"$.email","action_type":"add_tag","action_target_id":"paid"}`,
		},
		{
			name: "missing comparison operand",
			body: `{"name":"missing value","match_jsonpath":"$.status","match_operator":"equals",` +
				`"email_jsonpath":"$.email","action_type":"add_tag","action_target_id":"paid"}`,
		},
		{
			name: "malformed id target",
			body: `{"name":"bad target","match_jsonpath":"$.status","match_operator":"exists",` +
				`"email_jsonpath":"$.email","action_type":"start_automation","action_target_id":"not-a-uuid"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &recordingTriggerAdminRepository{}
			deps := &Deps{triggerAdminRepo: repo}
			rec := httptest.NewRecorder()
			req := triggerHandlerRequest(http.MethodPost, "/api/v1/inbound-webhooks/webhook-parent/triggers", tt.body)

			deps.CreateTrigger(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if repo.operation != "" {
				t.Fatalf("repository operation = %q; invalid input reached persistence", repo.operation)
			}
			if !strings.Contains(rec.Body.String(), `"code":"validation_failed"`) {
				t.Fatalf("body = %s, want validation_failed", rec.Body.String())
			}
		})
	}
}

func TestTriggerHandlersMapRepositoryValidationToBadRequest(t *testing.T) {
	repo := &recordingTriggerAdminRepository{
		updateErr: fmt.Errorf("%w: resulting operator/value combination is invalid", ErrInvalidTrigger),
	}
	deps := &Deps{triggerAdminRepo: repo}
	rec := httptest.NewRecorder()
	req := triggerHandlerRequest(
		http.MethodPatch,
		"/api/v1/inbound-webhooks/webhook-parent/triggers/trigger-child",
		`{"active":false}`,
	)

	deps.UpdateTrigger(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"validation_failed"`) {
		t.Fatalf("body = %s, want validation_failed", rec.Body.String())
	}
}

func TestTriggerRepositoryRejectsInvalidConfigurationBeforeDatabaseUse(t *testing.T) {
	repo := &Repo{}
	parentID := "11111111-1111-4111-8111-111111111111"
	triggerID := "22222222-2222-4222-8222-222222222222"

	in := validTriggerConfiguration()
	in.MatchOperator = OpRegex
	invalidRegex := "["
	in.MatchValue = &invalidRegex
	if _, err := repo.CreateTrigger(t.Context(), "tenant", parentID, in); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("CreateTrigger error = %v, want ErrInvalidTrigger before DB use", err)
	}

	invalidPath := "$.status["
	if _, err := repo.UpdateTrigger(
		t.Context(),
		"tenant",
		parentID,
		triggerID,
		TriggerPatch{MatchJSONPath: &invalidPath},
	); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("UpdateTrigger error = %v, want ErrInvalidTrigger before DB use", err)
	}
}

func TestTriggerPatchMergeValidatesResultingCombination(t *testing.T) {
	current := validTriggerConfiguration()

	regex := OpRegex
	invalidRegex := "["
	merged := applyTriggerPatch(current, TriggerPatch{
		MatchOperator: &regex,
		MatchValue:    &invalidRegex,
	})
	if _, err := normalizeAndValidateTrigger(merged); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("invalid merged regex error = %v, want ErrInvalidTrigger", err)
	}

	startAutomation := ActionStartAutomation
	merged = applyTriggerPatch(current, TriggerPatch{ActionType: &startAutomation})
	if _, err := normalizeAndValidateTrigger(merged); !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("invalid merged action target error = %v, want ErrInvalidTrigger", err)
	}
}
