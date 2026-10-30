// SPDX-License-Identifier: AGPL-3.0-only
package segments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type disclosureTestProvider struct {
	metadata AIProviderMetadata
}

func (p disclosureTestProvider) Complete(context.Context, string, string) (string, error) {
	return `{}`, nil
}

func (p disclosureTestProvider) AIProcessingMetadata() AIProviderMetadata {
	return p.metadata
}

type undisclosedTestProvider struct{}

func (undisclosedTestProvider) Complete(context.Context, string, string) (string, error) {
	return `{}`, nil
}

func TestSegmentUpdateValidationResolverSeesProposedIndirectCycle(t *testing.T) {
	base := &fakeSegmentResolver{asts: map[string]string{
		"segment-a": `{"op":"condition","field":"email","comparator":"contains","value":"old"}`,
		"segment-b": `{"op":"condition","field":"segment_id","comparator":"in_segment","value":"segment-a"}`,
	}}
	proposed := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"segment-b"}`)
	resolver := segmentUpdateValidationResolver(base, "tenant-1", "segment-a", proposed)

	if _, _, err := CompileASTWithResolver(context.Background(), proposed, "tenant-1", resolver); err == nil || !strings.Contains(err.Error(), "reference cycle") {
		t.Fatalf("proposed A -> B -> A cycle should be rejected before persistence, got %v", err)
	}
}

func TestCompileFromTextRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"text":"` + strings.Repeat("x", int(segmentJSONMaxBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/compile-from-text", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CompileFromText(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCompileFromTextRejectsMoreThan4096Characters(t *testing.T) {
	deps := &Deps{}
	body := `{"text":"` + strings.Repeat("界", 4097) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/compile-from-text", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CompileFromText(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "text_too_long") {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestCompileFromTextRulesEngineSuccess asserts engine=rules (the
// default) compiles a known phrase to the canonical AST envelope without
// touching the DB or AI provider.
func TestCompileFromTextRulesEngineSuccess(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/segments/compile-from-text",
		strings.NewReader(`{"text":"premium subscribers"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CompileFromText(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		EngineUsed    string         `json:"engine_used"`
		AST           map[string]any `json:"ast"`
		Rationale     string         `json:"rationale"`
		SuggestedName string         `json:"suggested_name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v; body=%s", err, rec.Body.String())
	}
	if out.EngineUsed != "rules" {
		t.Fatalf("engine_used = %q, want rules", out.EngineUsed)
	}
	if out.AST["field"] != "custom.tier" {
		t.Fatalf("ast.field = %v, want custom.tier", out.AST["field"])
	}
	if out.Rationale == "" || out.SuggestedName == "" {
		t.Fatalf("rationale/suggested_name should be populated: %+v", out)
	}
}

// TestCompileFromTextRulesEngineUnsupported asserts an unmatched phrase
// returns 422 unsupported_text (the desktop's signal to retry engine=ai).
func TestCompileFromTextRulesEngineUnsupported(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/segments/compile-from-text",
		strings.NewReader(`{"text":"people who like jazz on tuesdays"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CompileFromText(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unsupported_text") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestCompileFromTextBadEngine asserts an unknown engine token 400s.
func TestCompileFromTextBadEngine(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/segments/compile-from-text?engine=quantum",
		strings.NewReader(`{"text":"premium subscribers"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CompileFromText(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_engine") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCompileFromTextAIRequiresPerRequestProcessingAcknowledgement(t *testing.T) {
	deps := &Deps{AIProvider: undisclosedTestProvider{}}
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/segments/compile-from-text?engine=ai",
		strings.NewReader(`{"text":"private.person@example.test"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CompileFromText(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "ai_processing_acknowledgement_required") {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAICompileDisclosureIsAvailableBeforeProviderUse(t *testing.T) {
	deps := &Deps{AIProvider: disclosureTestProvider{metadata: AIProviderMetadata{
		Provider: "anthropic",
		Model:    "claude-test",
	}}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/compile-from-text", nil)
	rec := httptest.NewRecorder()

	deps.AICompileDisclosure(rec, req)

	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache=%q body=%s", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
	}
	var body struct {
		Available    bool                   `json:"available"`
		AIProcessing AIProcessingDisclosure `json:"ai_processing"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Available || body.AIProcessing.Provider != "anthropic" || body.AIProcessing.Model != "claude-test" {
		t.Fatalf("unexpected disclosure: %+v", body)
	}
}

func TestAICompileDisclosureReportsUnavailableWithoutInventingProvider(t *testing.T) {
	deps := &Deps{}
	rec := httptest.NewRecorder()
	deps.AICompileDisclosure(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	var body struct {
		Available    bool                   `json:"available"`
		AIProcessing AIProcessingDisclosure `json:"ai_processing"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Available || body.AIProcessing.Provider != "" || body.AIProcessing.Model != "" {
		t.Fatalf("unexpected unavailable disclosure: %+v", body)
	}
}

func TestAICompileCostLimiterOnlyWrapsAIEngine(t *testing.T) {
	limitedCalls := 0
	deps := &Deps{
		AICompileMiddleware: func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				limitedCalls++
				next.ServeHTTP(w, r)
			})
		},
	}
	handler := deps.compileFromTextRouteHandler()

	rules := httptest.NewRecorder()
	rulesRequest := httptest.NewRequest(http.MethodPost, "/api/v1/segments/compile-from-text", strings.NewReader(`{"text":"premium subscribers"}`))
	rulesRequest.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(rules, rulesRequest)
	if rules.Code != http.StatusOK || limitedCalls != 0 {
		t.Fatalf("rules status=%d limited calls=%d", rules.Code, limitedCalls)
	}

	ai := httptest.NewRecorder()
	aiRequest := httptest.NewRequest(http.MethodPost, "/api/v1/segments/compile-from-text?engine=AI", strings.NewReader(`{"text":"anything","ai_processing_acknowledged":true}`))
	aiRequest.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(ai, aiRequest)
	if limitedCalls != 1 {
		t.Fatalf("AI limited calls=%d, want 1", limitedCalls)
	}
}

func TestAICompileAuditMetadataNeverContainsTheOperatorPrompt(t *testing.T) {
	prompt := "target private.person@example.test and enterprise buyers"
	metadata := aiCompileAuditMetadata(
		disclosureTestProvider{metadata: AIProviderMetadata{Provider: "anthropic", Model: "claude-test"}},
		prompt,
		"success",
		125*time.Millisecond,
		2,
		1,
	)
	raw, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	if strings.Contains(string(raw), prompt) || strings.Contains(string(raw), "private.person@example.test") {
		t.Fatalf("audit metadata leaked operator text: %s", raw)
	}
	if metadata["prompt_characters"] != len([]rune(prompt)) || metadata["outcome"] != "success" || metadata["provider"] != "anthropic" {
		t.Fatalf("unexpected safe metadata: %#v", metadata)
	}
}

func TestAIProcessingDisclosureUsesOnlyExposedProviderFacts(t *testing.T) {
	got := aiProcessingDisclosure(disclosureTestProvider{metadata: AIProviderMetadata{
		Provider: "  anthropic ",
		Model:    " claude-test ",
	}})
	if got.Provider != "anthropic" || got.Model != "claude-test" {
		t.Fatalf("provider metadata = %+v", got)
	}
	if got.Retention != "not_declared" || got.Residency != "not_declared" {
		t.Fatalf("provider policy must remain undeclared: %+v", got)
	}
	wantCategories := []string{
		"operator_supplied_segment_description",
		"segment_predicate_catalog",
	}
	if len(got.DataCategories) != len(wantCategories) {
		t.Fatalf("data categories = %#v", got.DataCategories)
	}
	for i := range wantCategories {
		if got.DataCategories[i] != wantCategories[i] {
			t.Fatalf("data categories = %#v, want %#v", got.DataCategories, wantCategories)
		}
	}
}

func TestAIProcessingDisclosureDoesNotInventProviderMetadata(t *testing.T) {
	got := aiProcessingDisclosure(undisclosedTestProvider{})
	if got.Provider != "" || got.Model != "" {
		t.Fatalf("unexposed provider metadata must stay empty: %+v", got)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"provider"`) || strings.Contains(string(raw), `"model"`) {
		t.Fatalf("unknown provider/model leaked into response: %s", raw)
	}
}

func TestPreviewScopeIsActiveOnlyByDefault(t *testing.T) {
	const fragment = "subscribers.status = $1"
	if got := previewAudienceFragment(fragment, false); got != "("+fragment+") AND subscribers.archived_at IS NULL" {
		t.Fatalf("active-only fragment = %q", got)
	}
	if got := previewAudienceFragment(fragment, true); got != fragment {
		t.Fatalf("including-archived fragment = %q", got)
	}
	if got := previewArchiveScope(false); got != "active_only" {
		t.Fatalf("default archive scope = %q", got)
	}
	if got := previewArchiveScope(true); got != "including_archived" {
		t.Fatalf("expanded archive scope = %q", got)
	}
	if got := previewAppliedExclusions(false, " Email "); len(got) != 3 ||
		got[0] != "archived_subscribers" || got[1] != "non_enabled_subscribers" || got[2] != "missing_email_marketing_consent" {
		t.Fatalf("default exclusions = %#v", got)
	}
	if got := previewAppliedExclusions(true, ""); len(got) != 0 {
		t.Fatalf("expanded exclusions = %#v, want empty", got)
	}
}

func TestPreviewResponseIsAggregateOnlyAndNeverSerializesSQL(t *testing.T) {
	raw, err := json.Marshal(PreviewResponse{
		Count:               2,
		WorkspaceTotal:      8,
		WorkspacePercentage: 25,
		GeneratedAt:         time.Date(2026, time.July, 18, 12, 0, 0, 0, time.UTC),
		ArchiveScope:        "active_only",
		AppliedExclusions:   []string{"archived_subscribers"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"count", "workspace_total", "workspace_percentage", "generated_at",
		"archive_scope", "applied_exclusions",
	} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("response missing aggregate field %q: %s", key, raw)
		}
	}
	if _, ok := fields["sql"]; ok || strings.Contains(strings.ToLower(string(raw)), "where ") {
		t.Fatalf("preview exposed compiled SQL: %s", raw)
	}
}

func TestPreviewRejectsBadTargetChannelBeforeCounting(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost,
		"/api/v1/segments/preview",
		strings.NewReader(`{"queryAst":{"op":"condition","field":"status","comparator":"equals","value":"enabled"},"target_channel":"carrier_pigeon"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.Preview(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_target_channel") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
	}
}
