// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/fidelity"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/quota"
	"github.com/postwave/postwave/services/voice/internal/regression"
)

var regressionTestRuntime = RegressionRuntimeIdentity{
	Provider:            "test-provider",
	ModelID:             "test-model-v2",
	PromptPolicyVersion: regression.PromptPolicyVersion,
}

type stubLLM struct {
	resp  string
	err   error
	calls int
}

func (s *stubLLM) Generate(_ context.Context, _, _, _ string) (json.RawMessage, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return json.RawMessage(s.resp), nil
}

func (s *stubLLM) GenerateStream(_ context.Context, _, _, _ string, _ func(string) error) (string, error) {
	return s.resp, s.err
}

type recordingQuota struct {
	calls int
	cost  int
	err   error
}

type zeroReceiptEvaluator struct{}

func (zeroReceiptEvaluator) Score(
	context.Context,
	string,
	profile.VoiceProfile,
) (float64, fidelity.FidelityBreakdown, error) {
	return 0, fidelity.FidelityBreakdown{}, nil
}

func (q *recordingQuota) CheckAndConsume(_ context.Context, _, _ string, cost int) error {
	q.calls++
	q.cost = cost
	return q.err
}

func (q *recordingQuota) Limits(context.Context, string) (quota.Limits, error) {
	return quota.Limits{DailyTotal: 100}, nil
}

func newRegressionTestHandler(t *testing.T, chat ChatStreamer) *Handler {
	t.Helper()
	store := NewMemoryStore()
	if err := store.SaveProfile(context.Background(), profile.VoiceProfile{
		TenantID:              "tenant-1",
		SemanticModel:         "test-embedding-v1",
		RepresentativeSamples: []profile.Sample{{Text: "Clear, useful, concise writing."}},
	}); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	return &Handler{
		TenantFromRequest:   func(r *http.Request) string { return r.Header.Get("X-Tenant-ID") },
		Chat:                chat,
		Store:               store,
		RegressionEvaluator: fidelity.NewEmbeddingEvaluator(&fidelity.MockEmbeddingClient{}),
		RegressionRuntime:   regressionTestRuntime,
	}
}

func replayBody(t *testing.T, examples []replayBatchExample) string {
	t.Helper()
	warnThreshold := regression.DefaultWarnThreshold
	raw, err := json.Marshal(replayBatchRequest{
		ExpectedRuntime: regressionTestRuntime,
		WarnThreshold:   &warnThreshold,
		Examples:        examples,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func runReplayRequest(h *Handler, body, accept string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/voice/regression/replay-batch", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Tenant-ID", "tenant-1")
	if accept != "" {
		request.Header.Set("Accept", accept)
	}
	h.replayBatch(recorder, request)
	return recorder
}

func oneExample() []replayBatchExample {
	return []replayBatchExample{{
		ID:             "gx-1",
		SurfaceKind:    "campaign_draft",
		Brief:          "Re-engage quiet readers",
		ApprovedOutput: "We would love to welcome you back.",
	}}
}

func TestReplayBatchMissingTenant401(t *testing.T) {
	h := newRegressionTestHandler(t, &stubLLM{resp: `{"body":"hi"}`})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/voice/regression/replay-batch", strings.NewReader(replayBody(t, oneExample())))
	request.Header.Set("Content-Type", "application/json")
	h.replayBatch(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestReplayBatchRejectsEmptyStrictAndTenantOverrideBodies(t *testing.T) {
	h := newRegressionTestHandler(t, &stubLLM{resp: `{"body":"hi"}`})
	empty := runReplayRequest(h, replayBody(t, nil), "")
	if empty.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty status = %d, want 422: %s", empty.Code, empty.Body.String())
	}
	for _, body := range []string{
		`{"expected_runtime":{"provider":"test-provider","model_id":"test-model-v2","prompt_policy_version":"voice-regression-replay-v2"},"examples":[{"id":"gx-1","surface_kind":"campaign_draft","brief":"brief"}],"tenant_id":"tenant-2"}`,
		`{"expected_runtime":{"provider":"test-provider","model_id":"test-model-v2","prompt_policy_version":"voice-regression-replay-v2"},"examples":[{"id":"gx-1","surface_kind":"campaign_draft","brief":"brief"}],"surprise":true}`,
	} {
		recorder := runReplayRequest(h, body, "")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("strict status = %d, want 400: %s", recorder.Code, recorder.Body.String())
		}
	}
}

func TestReplayBatchValidatesIdentityDuplicatesSurfaceAndBounds(t *testing.T) {
	h := newRegressionTestHandler(t, &stubLLM{resp: `{"body":"hi"}`})
	warnThreshold := regression.DefaultWarnThreshold
	invalidThreshold := 101.0
	cases := []replayBatchRequest{
		{ExpectedRuntime: RegressionRuntimeIdentity{Provider: "test-provider", ModelID: "other", PromptPolicyVersion: regression.PromptPolicyVersion}, WarnThreshold: &warnThreshold, Examples: oneExample()},
		{ExpectedRuntime: regressionTestRuntime, WarnThreshold: &warnThreshold, Examples: []replayBatchExample{{ID: "gx-1", SurfaceKind: "campaign_draft", Brief: "a", ApprovedOutput: "approved a"}, {ID: "gx-1", SurfaceKind: "subject_line", Brief: "b", ApprovedOutput: "approved b"}}},
		{ExpectedRuntime: regressionTestRuntime, WarnThreshold: &warnThreshold, Examples: []replayBatchExample{{ID: "gx-1", SurfaceKind: "unknown", Brief: "a", ApprovedOutput: "approved"}}},
		{ExpectedRuntime: regressionTestRuntime, WarnThreshold: &warnThreshold, Examples: []replayBatchExample{{ID: " gx-1", SurfaceKind: "subject_line", Brief: "a", ApprovedOutput: "approved"}}},
		{ExpectedRuntime: regressionTestRuntime, WarnThreshold: &invalidThreshold, Examples: oneExample()},
		{ExpectedRuntime: regressionTestRuntime, WarnThreshold: &warnThreshold, Examples: []replayBatchExample{{ID: "gx-1", SurfaceKind: "subject_line", Brief: "a"}}},
		{ExpectedRuntime: regressionTestRuntime, WarnThreshold: nil, Examples: oneExample()},
	}
	for index, input := range cases {
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		recorder := runReplayRequest(h, string(raw), "")
		want := http.StatusUnprocessableEntity
		if index == 0 {
			want = http.StatusConflict
		}
		if recorder.Code != want {
			t.Fatalf("case %d status = %d, want %d: %s", index, recorder.Code, want, recorder.Body.String())
		}
	}
}

func TestValidRegressionRuntimeRejectsAmbiguousOrUnboundedIdentity(t *testing.T) {
	tests := []RegressionRuntimeIdentity{
		{},
		{Provider: " test-provider", ModelID: "model", PromptPolicyVersion: "policy"},
		{Provider: "test\nprovider", ModelID: "model", PromptPolicyVersion: "policy"},
		{Provider: strings.Repeat("p", 65), ModelID: "model", PromptPolicyVersion: "policy"},
		{Provider: "provider", ModelID: strings.Repeat("m", 161), PromptPolicyVersion: "policy"},
		{Provider: "provider", ModelID: "model", PromptPolicyVersion: strings.Repeat("v", 161)},
	}
	for index, runtime := range tests {
		if validRegressionRuntime(runtime) {
			t.Fatalf("case %d accepted invalid runtime: %+v", index, runtime)
		}
	}
	if !validRegressionRuntime(regressionTestRuntime) {
		t.Fatalf("valid runtime rejected: %+v", regressionTestRuntime)
	}
}

func TestValidateReplayBatchUsesCharacterBoundsForUnicodeReferences(t *testing.T) {
	t.Parallel()
	warnThreshold := regression.DefaultWarnThreshold
	request := replayBatchRequest{
		ExpectedRuntime: regressionTestRuntime,
		WarnThreshold:   &warnThreshold,
		Examples: []replayBatchExample{{
			ID:             "gx-unicode",
			SurfaceKind:    "campaign_draft",
			Brief:          strings.Repeat("界", replayMaxBriefRunes),
			ApprovedOutput: strings.Repeat("é", replayMaxApprovedOutputRunes),
		}},
	}
	if message := validateReplayBatch(request); message != "" {
		t.Fatalf("valid multibyte character bounds rejected: %s", message)
	}
	request.Examples[0].Brief += "界"
	if message := validateReplayBatch(request); message == "" {
		t.Fatal("brief over the character bound was accepted")
	}
}

func TestReplayBatchScoresQualifiedExampleAndReceiptsRuntime(t *testing.T) {
	llm := &stubLLM{resp: `{"subject":"S","body":"<p>Clear, useful, concise writing.</p>"}`}
	h := newRegressionTestHandler(t, llm)
	recorder := runReplayRequest(h, replayBody(t, oneExample()), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var response replayBatchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.SchemaVersion != replaySchemaVersion || response.Runtime != regressionTestRuntime {
		t.Fatalf("runtime receipt = %+v", response)
	}
	if response.ExpectedExamples != 1 || response.Aggregate.Total != 1 || response.Aggregate.Scored != 1 {
		t.Fatalf("aggregate = %+v", response.Aggregate)
	}
	if response.Aggregate.Results[0].FidelityScore == nil {
		t.Fatal("qualified result did not contain a score")
	}
}

func TestReplayBatchHonorsExplicitZeroWarnThreshold(t *testing.T) {
	h := newRegressionTestHandler(t, &stubLLM{resp: `{"body":"bounded output"}`})
	h.RegressionEvaluator = zeroReceiptEvaluator{}
	zero := 0.0
	raw, err := json.Marshal(replayBatchRequest{
		ExpectedRuntime: regressionTestRuntime,
		WarnThreshold:   &zero,
		Examples:        oneExample(),
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := runReplayRequest(h, string(raw), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var response replayBatchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Aggregate.Passed != 1 || len(response.Aggregate.Results) != 1 ||
		response.Aggregate.Results[0].Severity != "ok" ||
		response.Aggregate.Results[0].FidelityScore == nil ||
		*response.Aggregate.Results[0].FidelityScore != 0 {
		t.Fatalf("zero-threshold receipt = %+v", response.Aggregate)
	}
}

func TestReplayBatchChargesWholeBatchBeforeModelCalls(t *testing.T) {
	llm := &stubLLM{resp: `"subject"`}
	h := newRegressionTestHandler(t, llm)
	quotaRecorder := &recordingQuota{}
	h.Quota = quotaRecorder
	examples := []replayBatchExample{
		{ID: "gx-1", SurfaceKind: "subject_line", Brief: "a", ApprovedOutput: "approved a"},
		{ID: "gx-2", SurfaceKind: "subject_line", Brief: "b", ApprovedOutput: "approved b"},
	}
	recorder := runReplayRequest(h, replayBody(t, examples), "")
	if recorder.Code != http.StatusOK || quotaRecorder.calls != 1 || quotaRecorder.cost != quota.CostMilliCredits("ai_regression", 2) || llm.calls != 2 {
		t.Fatalf("receipt status=%d quota=%+v model_calls=%d", recorder.Code, quotaRecorder, llm.calls)
	}

	llm.calls = 0
	quotaRecorder.err = quota.ErrOverQuota
	recorder = runReplayRequest(h, replayBody(t, examples), "")
	if recorder.Code != http.StatusTooManyRequests || llm.calls != 0 {
		t.Fatalf("over-quota status=%d model_calls=%d", recorder.Code, llm.calls)
	}
}

func TestReplayBatchFailsClosedWithoutProfileEvaluatorOrRuntime(t *testing.T) {
	llm := &stubLLM{resp: `"subject"`}
	h := newRegressionTestHandler(t, llm)
	checks := []func(){
		func() { h.RegressionEvaluator = nil },
		func() { h.RegressionEvaluator = fidelity.NewEmbeddingEvaluator(nil) },
		func() {
			h.RegressionEvaluator = fidelity.NewEmbeddingEvaluator(&fidelity.MockEmbeddingClient{})
			h.RegressionRuntime = RegressionRuntimeIdentity{}
		},
	}
	for index, mutate := range checks {
		mutate()
		recorder := runReplayRequest(h, replayBody(t, oneExample()), "")
		if recorder.Code != http.StatusServiceUnavailable || llm.calls != 0 {
			t.Fatalf("case %d status=%d calls=%d", index, recorder.Code, llm.calls)
		}
	}
}

func TestReplayBatchNDJSONHasOrderedResultsAndExactlyOneCompletion(t *testing.T) {
	h := newRegressionTestHandler(t, &stubLLM{resp: `"A useful subject"`})
	examples := []replayBatchExample{
		{ID: "gx-1", SurfaceKind: "subject_line", Brief: "sale", ApprovedOutput: "Sale starts today"},
		{ID: "gx-2", SurfaceKind: "subject_line", Brief: "news", ApprovedOutput: "A useful update"},
	}
	recorder := runReplayRequest(h, replayBody(t, examples), "application/x-ndjson")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Header().Get("Content-Type"), "ndjson") {
		t.Fatalf("status=%d content-type=%q body=%s", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.String())
	}
	var envelopes []replayStreamEnvelope
	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	for scanner.Scan() {
		var envelope replayStreamEnvelope
		if err := json.Unmarshal(scanner.Bytes(), &envelope); err != nil {
			t.Fatalf("bad NDJSON: %v", err)
		}
		envelopes = append(envelopes, envelope)
	}
	if len(envelopes) != 3 {
		t.Fatalf("envelopes = %d, want 3", len(envelopes))
	}
	for index := 0; index < 2; index++ {
		if envelopes[index].Type != "result" || envelopes[index].Sequence != index+1 || envelopes[index].Result == nil || envelopes[index].Complete != nil {
			t.Fatalf("result envelope %d = %+v", index, envelopes[index])
		}
	}
	last := envelopes[2]
	if last.Type != "complete" || last.Sequence != 3 || last.Complete == nil || last.Result != nil || last.Complete.ExpectedExamples != 2 || last.Complete.Runtime != regressionTestRuntime {
		t.Fatalf("completion = %+v", last)
	}
}

func TestReplayBatchProviderErrorsAreCodedNotReflected(t *testing.T) {
	h := newRegressionTestHandler(t, &stubLLM{err: errors.New("provider secret token: abc")})
	recorder := runReplayRequest(h, replayBody(t, oneExample()), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "secret token") || !strings.Contains(recorder.Body.String(), "generation_unavailable") {
		t.Fatalf("unsafe error receipt: %s", recorder.Body.String())
	}
	var response replayBatchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Aggregate.Scored != 0 || response.Aggregate.MeanScore != nil || response.Aggregate.P25Score != nil {
		t.Fatalf("all-error batch fabricated score: %+v", response.Aggregate)
	}
}

type failingResponseWriter struct {
	header http.Header
	status int
}

func (w *failingResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *failingResponseWriter) WriteHeader(status int) { w.status = status }
func (w *failingResponseWriter) Write([]byte) (int, error) {
	return 0, errors.New("connection closed")
}

func TestReplayBatchStopsModelWorkAfterStreamWriteFailure(t *testing.T) {
	llm := &stubLLM{resp: `"subject"`}
	h := newRegressionTestHandler(t, llm)
	examples := []replayBatchExample{
		{ID: "gx-1", SurfaceKind: "subject_line", Brief: "a", ApprovedOutput: "approved a"},
		{ID: "gx-2", SurfaceKind: "subject_line", Brief: "b", ApprovedOutput: "approved b"},
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/voice/regression/replay-batch", strings.NewReader(replayBody(t, examples)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/x-ndjson")
	request.Header.Set("X-Tenant-ID", "tenant-1")
	h.replayBatch(&failingResponseWriter{}, request)
	if llm.calls != 1 {
		t.Fatalf("model calls = %d, want 1 before first write failure", llm.calls)
	}
}
