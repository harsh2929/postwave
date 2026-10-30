// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"strings"
	"sync"
	"testing"
)

func ptr(s string) *string { return &s }

func TestQueryJSONPath_DotPath(t *testing.T) {
	payload := map[string]any{
		"event_type": "checkout_completed",
		"user":       map[string]any{"email": "alice@example.com"},
	}
	v, ok := QueryJSONPath(payload, "$.event_type")
	if !ok || v != "checkout_completed" {
		t.Fatalf("got (%v,%v) want (checkout_completed,true)", v, ok)
	}
	v, ok = QueryJSONPath(payload, "$.user.email")
	if !ok || v != "alice@example.com" {
		t.Fatalf("got (%v,%v)", v, ok)
	}
	_, ok = QueryJSONPath(payload, "$.user.missing")
	if ok {
		t.Fatalf("missing path should not resolve")
	}
}

func TestQueryJSONPath_ArrayIndex(t *testing.T) {
	payload := map[string]any{
		"items": []any{
			map[string]any{"sku": "A"},
			map[string]any{"sku": "B"},
		},
	}
	v, ok := QueryJSONPath(payload, "$.items[0].sku")
	if !ok || v != "A" {
		t.Fatalf("got (%v,%v)", v, ok)
	}
	v, ok = QueryJSONPath(payload, "$.items[*].sku")
	if !ok || v != "A" {
		t.Fatalf("glob got (%v,%v)", v, ok)
	}
	_, ok = QueryJSONPath(payload, "$.items[5].sku")
	if ok {
		t.Fatalf("oob index should not resolve")
	}
}

func TestQueryJSONPath_RootAndBadInput(t *testing.T) {
	if _, ok := QueryJSONPath(map[string]any{"x": 1}, ""); ok {
		t.Fatalf("empty path should not resolve")
	}
	if _, ok := QueryJSONPath(map[string]any{"x": 1}, "x"); ok {
		t.Fatalf("path without $ should not resolve")
	}
	v, ok := QueryJSONPath(map[string]any{"x": 1}, "$")
	if !ok {
		t.Fatalf("$ should resolve to root")
	}
	if _, isMap := v.(map[string]any); !isMap {
		t.Fatalf("root not returned")
	}
}

func TestOperatorMatches_Equals(t *testing.T) {
	if !operatorMatches(OpEquals, "checkout_completed", true, ptr("checkout_completed")) {
		t.Fatal("equals should match")
	}
	if operatorMatches(OpEquals, "x", true, ptr("y")) {
		t.Fatal("equals should not match different")
	}
	if operatorMatches(OpEquals, "x", true, nil) {
		t.Fatal("nil expected should not match")
	}
}

func TestOperatorMatches_Contains(t *testing.T) {
	if !operatorMatches(OpContains, "user.created", true, ptr("created")) {
		t.Fatal("contains should match")
	}
	if operatorMatches(OpContains, "user.deleted", true, ptr("created")) {
		t.Fatal("contains should not match")
	}
}

func TestOperatorMatches_Exists(t *testing.T) {
	if !operatorMatches(OpExists, "anything", true, nil) {
		t.Fatal("exists should match when found")
	}
	if operatorMatches(OpExists, nil, false, nil) {
		t.Fatal("exists should not match when not found")
	}
}

func TestOperatorMatches_Regex(t *testing.T) {
	if !operatorMatches(OpRegex, "evt-1234", true, ptr(`^evt-\d+$`)) {
		t.Fatal("regex should match")
	}
	if operatorMatches(OpRegex, "evt-abc", true, ptr(`^evt-\d+$`)) {
		t.Fatal("regex should not match")
	}
	if operatorMatches(OpRegex, "x", true, ptr(`[`)) {
		t.Fatal("invalid regex should not match")
	}
}

// --- EvaluateTriggers integration with mocks ---

type fakeStore struct {
	mu       sync.Mutex
	triggers []Trigger
	fired    []string
}

func (s *fakeStore) ListActive(_ context.Context, _, webhookID string) ([]Trigger, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Trigger, 0, len(s.triggers))
	for _, t := range s.triggers {
		if t.WebhookID == webhookID && t.Active {
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *fakeStore) RecordFire(_ context.Context, _, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fired = append(s.fired, id)
	return nil
}

type fakeExec struct {
	mu      sync.Mutex
	addsSeq []string
	addsTag []string
}

func (e *fakeExec) AddToSequence(_ context.Context, _, seqID, email string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.addsSeq = append(e.addsSeq, seqID+":"+email)
	return nil
}
func (e *fakeExec) AddTag(_ context.Context, _, tag, email string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.addsTag = append(e.addsTag, tag+":"+email)
	return nil
}
func (e *fakeExec) RemoveTag(_ context.Context, _, _, _ string) error       { return nil }
func (e *fakeExec) StartAutomation(_ context.Context, _, _, _ string) error { return nil }

func TestEvaluateTriggers_HappyPath(t *testing.T) {
	store := &fakeStore{
		triggers: []Trigger{
			{
				ID:             "t1",
				TenantID:       "tenant",
				WebhookID:      "wh1",
				Name:           "VIP signups",
				Active:         true,
				MatchJSONPath:  "$.event_type",
				MatchOperator:  OpEquals,
				MatchValue:     ptr("user.created"),
				EmailJSONPath:  "$.user.email",
				ActionType:     ActionAddToSequence,
				ActionTargetID: "seq-vip",
			},
		},
	}
	exec := &fakeExec{}
	matches, err := EvaluateTriggers(context.Background(), store, exec, "tenant", "wh1",
		[]byte(`{"event_type":"user.created","user":{"email":"vip@example.com"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("got %d matches, want 1", len(matches))
	}
	if !matches[0].Executed {
		t.Fatalf("expected executed: %+v", matches[0])
	}
	if len(exec.addsSeq) != 1 || exec.addsSeq[0] != "seq-vip:vip@example.com" {
		t.Fatalf("seq enrollment missing: %+v", exec.addsSeq)
	}
	if len(store.fired) != 1 || store.fired[0] != "t1" {
		t.Fatalf("fire record missing: %+v", store.fired)
	}
}

func TestEvaluateTriggers_NoMatch(t *testing.T) {
	store := &fakeStore{
		triggers: []Trigger{
			{
				ID:             "t1",
				TenantID:       "tenant",
				WebhookID:      "wh1",
				Active:         true,
				MatchJSONPath:  "$.event_type",
				MatchOperator:  OpEquals,
				MatchValue:     ptr("user.created"),
				EmailJSONPath:  "$.email",
				ActionType:     ActionAddTag,
				ActionTargetID: "vip",
			},
		},
	}
	matches, err := EvaluateTriggers(context.Background(), store, &fakeExec{}, "tenant", "wh1",
		[]byte(`{"event_type":"order.placed","email":"x@example.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected 0 matches, got %d", len(matches))
	}
	if len(store.fired) != 0 {
		t.Fatalf("non-match should not record fire")
	}
}

func TestEvaluateTriggers_MissingEmailPath(t *testing.T) {
	store := &fakeStore{
		triggers: []Trigger{
			{
				ID:             "t1",
				TenantID:       "tenant",
				WebhookID:      "wh1",
				Active:         true,
				MatchJSONPath:  "$.event",
				MatchOperator:  OpExists,
				EmailJSONPath:  "$.user.email",
				ActionType:     ActionAddTag,
				ActionTargetID: "vip",
			},
		},
	}
	matches, err := EvaluateTriggers(context.Background(), store, &fakeExec{}, "tenant", "wh1",
		[]byte(`{"event":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].Error == "" {
		t.Fatalf("expected match with error, got %+v", matches)
	}
	if matches[0].Executed {
		t.Fatalf("should not execute when email is missing")
	}
}

func TestEvaluateTriggers_NonJSONPayload(t *testing.T) {
	store := &fakeStore{
		triggers: []Trigger{{ID: "t1", WebhookID: "wh1", Active: true}},
	}
	matches, err := EvaluateTriggers(context.Background(), store, &fakeExec{}, "tenant", "wh1",
		[]byte(`not json`))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("non-json should produce 0 matches")
	}
}

func TestEvaluateTriggers_NilExecutorLogsOnly(t *testing.T) {
	// Test-fire mode: nil executor returns matches without running
	// the side-effect.
	store := &fakeStore{
		triggers: []Trigger{
			{
				ID:             "t1",
				TenantID:       "tenant",
				WebhookID:      "wh1",
				Active:         true,
				MatchJSONPath:  "$.event_type",
				MatchOperator:  OpContains,
				MatchValue:     ptr("created"),
				EmailJSONPath:  "$.user.email",
				ActionType:     ActionAddTag,
				ActionTargetID: "vip",
			},
		},
	}
	matches, err := EvaluateTriggers(context.Background(), store, nil, "tenant", "wh1",
		[]byte(`{"event_type":"user.created","user":{"email":"a@b.com"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].Executed {
		t.Fatalf("nil exec should match but not execute, got %+v", matches)
	}
}

func TestValidateOperator(t *testing.T) {
	for _, op := range []string{OpEquals, OpContains, OpExists, OpRegex} {
		if err := ValidateOperator(op); err != nil {
			t.Errorf("%s rejected: %v", op, err)
		}
	}
	if err := ValidateOperator("wat"); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Errorf("unknown should error, got %v", err)
	}
}

func TestValidateAction(t *testing.T) {
	for _, a := range []string{ActionAddToSequence, ActionAddTag, ActionRemoveTag, ActionStartAutomation} {
		if err := ValidateAction(a); err != nil {
			t.Errorf("%s rejected: %v", a, err)
		}
	}
	if err := ValidateAction("delete_universe"); err == nil {
		t.Errorf("unknown should error")
	}
}
