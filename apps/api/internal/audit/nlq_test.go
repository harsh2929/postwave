// SPDX-License-Identifier: AGPL-3.0-only
package audit

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeLLM is a fake LLMClient that returns canned responses.
type fakeLLM struct {
	resp    string
	err     error
	pin     int
	pout    int
	calls   int32
	gotSys  string
	gotUser string
}

func (f *fakeLLM) Complete(_ context.Context, system, user string) (string, int, int, error) {
	atomic.AddInt32(&f.calls, 1)
	f.gotSys = system
	f.gotUser = user
	if f.err != nil {
		return "", 0, 0, f.err
	}
	return f.resp, f.pin, f.pout, nil
}

func TestTranslateQueryToFiltersBasicFilters(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		query     string
		expActor  string
		expAction string
		expRes    string
	}{
		{
			name:      "actor_type and action",
			raw:       `{"filters": {"actor_type": "human", "action": "subscriber.delete"}, "reasoning": "human-driven deletions"}`,
			query:     "show me subscriber deletes by users",
			expActor:  "human",
			expAction: "subscriber.delete",
		},
		{
			name:   "resource_type only",
			raw:    `{"filters": {"resource_type": "campaign"}, "reasoning": "campaign-scoped"}`,
			query:  "anything touching campaigns",
			expRes: "campaign",
		},
		{
			name:      "with markdown fence",
			raw:       "```json\n{\"filters\": {\"action\": \"login\"}, \"reasoning\": \"auth events\"}\n```",
			query:     "login activity",
			expAction: "login",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			llm := &fakeLLM{resp: c.raw, pin: 100, pout: 50}
			res, err := TranslateQueryToFilters(context.Background(), llm, c.query, 90)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if c.expActor != "" && res.Filters.ActorType != c.expActor {
				t.Errorf("actor_type: got %q want %q", res.Filters.ActorType, c.expActor)
			}
			if c.expAction != "" && res.Filters.Action != c.expAction {
				t.Errorf("action: got %q want %q", res.Filters.Action, c.expAction)
			}
			if c.expRes != "" && res.Filters.ResourceType != c.expRes {
				t.Errorf("resource_type: got %q want %q", res.Filters.ResourceType, c.expRes)
			}
			if res.PromptTokens != 100 || res.ResponseTokens != 50 {
				t.Errorf("tokens: got %d/%d want 100/50", res.PromptTokens, res.ResponseTokens)
			}
		})
	}
}

func TestNLQPromptUsesCanonicalAuditActorVocabulary(t *testing.T) {
	system, _ := nlqPromptForQuery("show me human activity", 90)
	for _, actorType := range []string{"human", "agent", "system", "platform_operator"} {
		if !strings.Contains(system, actorType) {
			t.Fatalf("prompt does not include canonical actor type %q", actorType)
		}
	}
	if strings.Contains(system, "one of: user") || strings.Contains(system, "api_key, agent") {
		t.Fatalf("prompt advertises a legacy audit actor vocabulary: %s", system)
	}
}

func TestTranslateQueryToFiltersInvalidFields(t *testing.T) {
	llm := &fakeLLM{
		resp: `{"filters": {"priority": "high", "severity": "P0", "action": "delete"}, "reasoning": "tried priority"}`,
	}
	res, err := TranslateQueryToFilters(context.Background(), llm, "high priority deletes", 90)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Filters.Action != "delete" {
		t.Errorf("valid action should pass through, got %q", res.Filters.Action)
	}
	if len(res.InvalidFields) != 2 {
		t.Errorf("expected 2 invalid fields, got %v", res.InvalidFields)
	}
}

func TestTranslateQueryToFiltersRejectsUnknownActorType(t *testing.T) {
	llm := &fakeLLM{
		resp: `{"filters": {"actor_type": "api_key"}, "reasoning": "legacy category"}`,
	}
	res, err := TranslateQueryToFilters(context.Background(), llm, "API key activity", 90)
	if err == nil {
		t.Fatal("expected an invalid actor type to fail closed")
	}
	if res == nil || len(res.InvalidFields) != 1 || res.InvalidFields[0] != "actor_type" {
		t.Fatalf("invalid fields = %#v, want actor_type", res)
	}
	if res.Filters.ActorType != "" {
		t.Fatalf("invalid actor type leaked into executable filters: %q", res.Filters.ActorType)
	}
	code, status := TranslateLLMError(err)
	if code != "nlq_bad_translation" || status != 502 {
		t.Fatalf("error contract = %s/%d, want nlq_bad_translation/502", code, status)
	}
}

func TestTranslateQueryToFiltersSQLInjection(t *testing.T) {
	llm := &fakeLLM{
		resp: `{"filters": {"action": "delete'; DROP TABLE audit_log; --", "resource_id": "abc' OR 1=1 --"}, "reasoning": "injection attempt"}`,
	}
	res, err := TranslateQueryToFilters(context.Background(), llm, "drop the audit table", 90)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(res.Filters.Action, "'") || strings.Contains(res.Filters.Action, ";") || strings.Contains(res.Filters.Action, "--") {
		t.Errorf("action should be sanitised, got %q", res.Filters.Action)
	}
	if strings.Contains(res.Filters.ResourceID, "'") || strings.Contains(res.Filters.ResourceID, "--") {
		t.Errorf("resource_id should be sanitised, got %q", res.Filters.ResourceID)
	}
}

func TestTranslateQueryToFiltersEmptyQuery(t *testing.T) {
	llm := &fakeLLM{resp: `{"filters": {}}`}
	if _, err := TranslateQueryToFilters(context.Background(), llm, "", 90); err == nil {
		t.Fatal("expected error for empty query")
	}
	if _, err := TranslateQueryToFilters(context.Background(), llm, "   ", 90); err == nil {
		t.Fatal("expected error for whitespace-only query")
	}
}

func TestTranslateQueryToFiltersMalformedJSON(t *testing.T) {
	llm := &fakeLLM{resp: `this is not json at all`}
	res, err := TranslateQueryToFilters(context.Background(), llm, "hi", 90)
	if err == nil {
		t.Fatal("expected malformed JSON error")
	}
	if res == nil || res.RawLLMResponse == "" {
		t.Error("expected raw response to be surfaced for debugging")
	}
	code, status := TranslateLLMError(err)
	if code != "nlq_bad_translation" || status != 502 {
		t.Errorf("expected bad translation 502, got %s %d", code, status)
	}
}

func TestSummarizeAuditResultsEmpty(t *testing.T) {
	llm := &fakeLLM{resp: "No events match this query.", pin: 50, pout: 12}
	res, err := SummarizeAuditResults(context.Background(), llm, "anything deleted today", nil, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(res.Summary, "No events") {
		t.Errorf("summary should reflect empty result, got %q", res.Summary)
	}
}

func TestSummarizeAuditResultsBoundedRows(t *testing.T) {
	rows := make([]AuditRowForSummary, 100)
	for i := range rows {
		rows[i] = AuditRowForSummary{At: "2026-06-01T00:00:00Z", Action: "subscriber.delete"}
	}
	llm := &fakeLLM{resp: "100 deletions today."}
	_, err := SummarizeAuditResults(context.Background(), llm, "deletions", rows, 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Ensure the prompt only feeds SummaryMaxRows rows.
	if !strings.Contains(llm.gotUser, "Sample (up to 25") {
		t.Errorf("summary prompt should be capped at SummaryMaxRows; got user=%q", llm.gotUser)
	}
}

func TestNLQCostCapEnforcement(t *testing.T) {
	tr := NewDailyCostTracker(1000)
	used, rem, exc := tr.Add("tenant-a", 400)
	if exc {
		t.Fatal("400/1000 should not exceed")
	}
	if used != 400 || rem != 600 {
		t.Errorf("after 400: used=%d rem=%d", used, rem)
	}
	used, rem, exc = tr.Add("tenant-a", 700)
	if !exc {
		t.Fatal("1100/1000 should exceed")
	}
	// Used should be unchanged on exceed (refund).
	if used != 400 {
		t.Errorf("on exceed, used should refund to 400, got %d", used)
	}
	if rem != 600 {
		t.Errorf("on exceed, rem should still be 600, got %d", rem)
	}
	// Tenant-b is independent.
	used, _, _ = tr.Add("tenant-b", 100)
	if used != 100 {
		t.Errorf("tenant-b: %d", used)
	}
}

func TestNLQCostTrackerUnlimited(t *testing.T) {
	tr := NewDailyCostTracker(0)
	for i := 0; i < 10; i++ {
		_, _, exc := tr.Add("tenant", 999999)
		if exc {
			t.Fatalf("unlimited tracker should never exceed (iter %d)", i)
		}
	}
}

func TestNLQCacheHitMiss(t *testing.T) {
	c := NewNLQCache(time.Hour)
	k := NewNLQCacheKey("tenant-a", "show me logins")
	if got := c.Get(k); got != nil {
		t.Fatal("empty cache should return nil")
	}
	c.Put(k, &TranslationResult{Filters: StructuredFilters{Action: "login"}})
	got := c.Get(k)
	if got == nil {
		t.Fatal("after Put, Get should hit")
	}
	if !got.CacheHit {
		t.Error("returned entry should be marked CacheHit=true")
	}
	if got.Filters.Action != "login" {
		t.Errorf("cached filter mismatch: %q", got.Filters.Action)
	}
	// Case + whitespace insensitive.
	got2 := c.Get(NewNLQCacheKey("tenant-a", "  SHOW ME LOGINS  "))
	if got2 == nil {
		t.Error("cache key should normalise case + whitespace")
	}
	// Different tenant is isolated.
	if c.Get(NewNLQCacheKey("tenant-b", "show me logins")) != nil {
		t.Error("cross-tenant cache hit — isolation broken")
	}
}

func TestNLQCacheExpiry(t *testing.T) {
	c := NewNLQCache(50 * time.Millisecond)
	k := NewNLQCacheKey("t", "q")
	c.Put(k, &TranslationResult{Filters: StructuredFilters{Action: "x"}})
	if c.Get(k) == nil {
		t.Fatal("fresh entry should hit")
	}
	time.Sleep(120 * time.Millisecond)
	if c.Get(k) != nil {
		t.Fatal("expired entry should miss")
	}
	if c.Size() != 0 {
		t.Errorf("expected expired entry to be evicted, Size=%d", c.Size())
	}
}

func TestTranslateLLMErrorCodes(t *testing.T) {
	cases := []struct {
		err    error
		code   string
		status int
	}{
		{errors.New("anthropic NLQ client not configured"), "nlq_unavailable", 503},
		{errors.New("anthropic NLQ HTTP 429: rate_limit: try later"), "nlq_llm_rate_limited", 429},
		{errors.New("anthropic NLQ HTTP 401: auth: bad key"), "nlq_llm_auth", 503},
		{errors.New("nlq: malformed LLM JSON: invalid char"), "nlq_bad_translation", 502},
		{errors.New("context deadline exceeded"), "nlq_timeout", 504},
		{errors.New("some random network error"), "nlq_llm_error", 502},
	}
	for _, c := range cases {
		code, status := TranslateLLMError(c.err)
		if code != c.code || status != c.status {
			t.Errorf("err %v: got %s/%d want %s/%d", c.err, code, status, c.code, c.status)
		}
	}
}

func TestTranslateQueryToFiltersHonoursRetentionInPrompt(t *testing.T) {
	llm := &fakeLLM{resp: `{"filters": {}, "reasoning": "ok"}`}
	_, _ = TranslateQueryToFilters(context.Background(), llm, "anything", 30)
	if !strings.Contains(llm.gotSys, "30 days") {
		t.Errorf("system prompt should mention 30-day retention; got: %s", llm.gotSys)
	}
}

func TestTranslateQueryToFiltersLimitClamped(t *testing.T) {
	llm := &fakeLLM{resp: `{"filters": {"limit": 9999}, "reasoning": "huge"}`}
	res, err := TranslateQueryToFilters(context.Background(), llm, "everything", 90)
	if err != nil {
		t.Fatal(err)
	}
	if res.Filters.Limit != 500 {
		t.Errorf("limit should clamp to 500, got %d", res.Filters.Limit)
	}
}

func TestTranslateQueryToFiltersInvalidSince(t *testing.T) {
	llm := &fakeLLM{resp: `{"filters": {"since": "yesterday"}, "reasoning": ""}`}
	res, err := TranslateQueryToFilters(context.Background(), llm, "yesterday's events", 90)
	if err != nil {
		t.Fatal(err)
	}
	if res.Filters.Since != "" {
		t.Errorf("invalid since should be dropped, got %q", res.Filters.Since)
	}
	found := false
	for _, f := range res.InvalidFields {
		if f == "since" {
			found = true
		}
	}
	if !found {
		t.Error("invalid since should be flagged in invalid_fields")
	}
}
