package diagnostician

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// MockLLMClient records the most recent system+user prompt and returns a
// canned JSON Diagnosis.
type MockLLMClient struct {
	Response  string
	GotSystem string
	GotUser   string
	GotModel  string
	Err       error
}

func (m *MockLLMClient) Complete(_ context.Context, system, user, model string) (string, error) {
	m.GotSystem = system
	m.GotUser = user
	m.GotModel = model
	if m.Err != nil {
		return "", m.Err
	}
	return m.Response, nil
}

// The prompt loader resolves DIAGNOSTICIAN_PROMPTS_PATH, then the private
// pack at /etc/postwave/proprietary, then a proprietary/ directory found by
// walking up from the working directory, then the bundled stubs — and caches
// the answer for the life of the process. proprietary/ is export-ignored
// (.gitattributes, LICENSE-BOUNDARY.md), so a `git archive` source export,
// which is what CI checks out, never contains the private pack. A test that
// reads SystemPrompt therefore pins the pack it expects rather than
// inheriting whatever the checkout, or an earlier test's cache, supplies.

const (
	fixtureRubric  = "# Diagnostician rubric (test pack)\n\nReturn JSON only. Never invent statistics.\n"
	fixtureFewShot = "# Worked examples (test pack)\n\n## Example 1 — SPF missing\n\nRecommend a dns_record fix.\n"
)

// privatePackMarkers are the sections the calibrated private pack must
// carry: the rubric, the worked examples from Example 1 through Example 5,
// and the closing self-check.
var privatePackMarkers = []string{
	"Moosewave Deliverability Diagnostician",
	"Worked Examples",
	"Example 1 — Authentication failure",
	"Example 5",
	"Final self-check",
}

func resetPromptCache() {
	promptCache.Lock()
	promptCache.system, promptCache.fewShot, promptCache.loaded = "", "", false
	promptCache.Unlock()
}

// usePromptPack writes a two-file prompt pack under t.TempDir(), points
// DIAGNOSTICIAN_PROMPTS_PATH at it, and drops the process-wide prompt cache
// before and after the test.
func usePromptPack(t *testing.T, system, fewShot string) {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{"system.md": system, "few_shot.md": fewShot} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	t.Setenv("DIAGNOSTICIAN_PROMPTS_PATH", dir)
	resetPromptCache()
	t.Cleanup(resetPromptCache)
}

// privatePackPresent reports whether the calibrated pack exists at one of
// the places the loader searches: the host install path, or the repository's
// proprietary/ directory four levels above this package
// (services/deliverability/internal/diagnostician). It stats the files
// itself rather than asking findProprietary, so a broken walk-up cannot
// steer TestSystemPrompt_DefaultResolution onto the stub branch.
func privatePackPresent() bool {
	for _, dir := range []string{
		"/etc/postwave/proprietary/prompts/diagnostician",
		filepath.Join("..", "..", "..", "..", "proprietary", "prompts", "diagnostician"),
	} {
		if _, err := os.Stat(filepath.Join(dir, "system.md")); err == nil {
			return true
		}
	}
	return false
}

func TestDiagnose_PromptShape(t *testing.T) {
	usePromptPack(t, fixtureRubric, fixtureFewShot)
	canned := domain.Diagnosis{
		CampaignID: "cmp_1",
		Diagnosis:  "All seedlist inboxes show primary placement.",
		Fixes:      []domain.Fix{},
	}
	b, _ := json.Marshal(canned)
	mock := &MockLLMClient{Response: string(b)}
	d := New(mock)

	sig := Signals{
		CampaignID: "cmp_1",
		Domain:     "example.com",
	}
	dia, err := d.Diagnose(context.Background(), sig, "fp-test")
	if err != nil {
		t.Fatalf("Diagnose: %v", err)
	}
	if dia.CampaignID != "cmp_1" {
		t.Fatalf("campaign id=%q", dia.CampaignID)
	}
	if mock.GotModel != Model {
		t.Fatalf("model=%q want %q", mock.GotModel, Model)
	}
	if !strings.HasPrefix(mock.GotSystem, fixtureRubric) {
		t.Fatalf("system prompt missing rubric header; got %d bytes: %q", len(mock.GotSystem), mock.GotSystem)
	}
	if want := fixtureRubric + "\n\n" + fixtureFewShot; mock.GotSystem != want {
		t.Fatalf("system prompt is not the configured rubric followed by its worked examples; got %q want %q", mock.GotSystem, want)
	}
	if !strings.Contains(mock.GotUser, `"campaign_id":"cmp_1"`) {
		t.Fatalf("user payload missing campaign id; got %q", mock.GotUser)
	}
}

// SystemPrompt serves the configured pack's rubric, a blank line, then its
// worked examples; FewShotPrompt serves the worked examples alone.
func TestSystemPrompt_IncludesFewShot(t *testing.T) {
	usePromptPack(t, fixtureRubric, fixtureFewShot)
	if got, want := SystemPrompt(), fixtureRubric+"\n\n"+fixtureFewShot; got != want {
		t.Fatalf("SystemPrompt = %q, want rubric then worked examples %q", got, want)
	}
	if got := FewShotPrompt(); got != fixtureFewShot {
		t.Errorf("FewShotPrompt = %q, want %q", got, fixtureFewShot)
	}
}

// TestSystemPrompt_DefaultResolution pins what SystemPrompt serves with no
// DIAGNOSTICIAN_PROMPTS_PATH. Where the calibrated private pack is present,
// the loader must find it by walking up from this package and serve its
// rubric, all five worked examples, and the final self-check. Where it is
// absent by design — a source export — the loader must fall back to the
// bundled stubs rather than fail or serve an empty prompt.
func TestSystemPrompt_DefaultResolution(t *testing.T) {
	t.Setenv("DIAGNOSTICIAN_PROMPTS_PATH", "")
	resetPromptCache()
	t.Cleanup(resetPromptCache)

	got := SystemPrompt()
	if privatePackPresent() {
		for _, want := range privatePackMarkers {
			if !strings.Contains(got, want) {
				t.Errorf("private pack present, but SystemPrompt (%d bytes) is missing %q", len(got), want)
			}
		}
		return
	}
	if want := stubSystemPrompt + "\n\n" + stubFewShotPrompt; got != want {
		t.Fatalf("no private pack present: SystemPrompt = %q, want the bundled stubs %q", got, want)
	}
}

func TestReadPromptFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "system.md")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create prompt: %v", err)
	}
	if err = f.Truncate(maxDiagnosticianPromptFileBytes + 1); err != nil {
		_ = f.Close()
		t.Fatalf("truncate prompt: %v", err)
	}
	if err = f.Close(); err != nil {
		t.Fatalf("close prompt: %v", err)
	}

	_, err = readPromptFile(path)
	if err == nil || !strings.Contains(err.Error(), "prompt file exceeds") {
		t.Fatalf("expected oversized prompt error, got %v", err)
	}
}

func TestValidateDiagnosis(t *testing.T) {
	good := domain.Diagnosis{
		Fixes: []domain.Fix{
			{Action: domain.FixActionDNSRecord, EstimatedImpact: 0.30},
			{Action: domain.FixActionCopyChange, EstimatedImpact: 0.15},
		},
		PredictedImpact: map[string]float64{"gmail": 0.9},
	}
	if err := ValidateDiagnosis(good); err != nil {
		t.Fatalf("good diagnosis failed validation: %v", err)
	}
	badAction := domain.Diagnosis{Fixes: []domain.Fix{{Action: "send_email", EstimatedImpact: 0.10}}}
	if err := ValidateDiagnosis(badAction); err == nil || !strings.Contains(err.Error(), "action") {
		t.Errorf("expected action error, got %v", err)
	}
	overCap := domain.Diagnosis{Fixes: []domain.Fix{{Action: domain.FixActionDNSRecord, EstimatedImpact: 0.50}}}
	if err := ValidateDiagnosis(overCap); err == nil || !strings.Contains(err.Error(), "0.40") {
		t.Errorf("expected per-fix cap error, got %v", err)
	}
	overSum := domain.Diagnosis{Fixes: []domain.Fix{
		{Action: domain.FixActionDNSRecord, EstimatedImpact: 0.40},
		{Action: domain.FixActionCopyChange, EstimatedImpact: 0.40},
		{Action: domain.FixActionImageSwap, EstimatedImpact: 0.20},
	}}
	if err := ValidateDiagnosis(overSum); err == nil || !strings.Contains(err.Error(), "0.85") {
		t.Errorf("expected sum cap error, got %v", err)
	}
	badImpact := domain.Diagnosis{PredictedImpact: map[string]float64{"gmail": 1.5}}
	if err := ValidateDiagnosis(badImpact); err == nil {
		t.Errorf("expected predicted_impact range error")
	}
}

func TestSignalsHasEvidenceRejectsCampaignIDOnly(t *testing.T) {
	if (Signals{CampaignID: "campaign-1"}).HasEvidence() {
		t.Fatal("campaign id alone must not be treated as deliverability evidence")
	}
	if !(Signals{Domain: "mail.example.com"}).HasEvidence() {
		t.Fatal("resolved sending domain should count as evidence")
	}
	if !(Signals{Seedlist: domain.CampaignReport{CampaignID: "campaign-1"}}).HasEvidence() {
		t.Fatal("campaign placement report should count as evidence")
	}
}

// retryLLMClient returns a violating response on the first call and a
// valid one on the second — verifies the diagnostician's single retry.
type retryLLMClient struct {
	calls int
}

func (r *retryLLMClient) Complete(_ context.Context, _ string, _ string, _ string) (string, error) {
	r.calls++
	if r.calls == 1 {
		return `{"campaign_id":"x","diagnosis":"bad","fixes":[{"title":"x","detail":"y","action":"send_email","estimated_impact":0.10}],"predicted_impact":{}}`, nil
	}
	return `{"campaign_id":"x","diagnosis":"ok","fixes":[{"title":"x","detail":"y","action":"copy_change","estimated_impact":0.10}],"predicted_impact":{}}`, nil
}

func TestDiagnose_RetriesOnConstraintViolation(t *testing.T) {
	client := &retryLLMClient{}
	d := New(client)
	dia, err := d.Diagnose(context.Background(), Signals{CampaignID: "x"}, "fp-retry")
	if err != nil {
		t.Fatalf("Diagnose: %v", err)
	}
	if client.calls != 2 {
		t.Errorf("expected 2 LLM calls (initial + retry), got %d", client.calls)
	}
	if len(dia.Fixes) != 1 || dia.Fixes[0].Action != domain.FixActionCopyChange {
		t.Errorf("retry output not used: %+v", dia.Fixes)
	}
}

func TestDiagnose_CachesByFingerprint(t *testing.T) {
	canned, _ := json.Marshal(domain.Diagnosis{CampaignID: "x"})
	mock := &MockLLMClient{Response: string(canned)}
	d := New(mock)
	sig := Signals{CampaignID: "x"}
	if _, err := d.Diagnose(context.Background(), sig, "fp-1"); err != nil {
		t.Fatal(err)
	}
	mock.Response = `{"campaign_id":"changed"}`
	dia, err := d.Diagnose(context.Background(), sig, "fp-1")
	if err != nil {
		t.Fatal(err)
	}
	if dia.CampaignID != "x" {
		t.Fatalf("expected cache hit, got %q", dia.CampaignID)
	}
}

// --- GeminiClient tests ---

func TestGeminiEndpointPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	got, err := geminiEndpoint("https://gemini.example.test/proxy/", "gemini-3.1-pro-preview")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://gemini.example.test/proxy/v1beta/models/gemini-3.1-pro-preview:generateContent" {
		t.Fatalf("geminiEndpoint = %q", got)
	}
	for _, base := range []string{
		"https://user:pass@gemini.example.test",
		"https://gemini.example.test?token=x",
		"https://gemini.example.test#frag",
		"file:///tmp/gemini",
	} {
		if _, err := geminiEndpoint(base, "gemini-3.1-pro-preview"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
}

// geminiSuccessBody returns a canned Gemini generateContent response
// whose candidates[0].content.parts[0].text is `text`.
func geminiSuccessBody(t *testing.T, text string) []byte {
	t.Helper()
	resp := map[string]any{
		"candidates": []map[string]any{
			{
				"content": map[string]any{
					"role": "model",
					"parts": []map[string]any{
						{"text": text},
					},
				},
				"finishReason": "STOP",
			},
		},
	}
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal canned gemini response: %v", err)
	}
	return b
}

func TestGeminiComplete_HappyPath(t *testing.T) {
	var gotPath, gotMethod, gotAPIKey, gotCT string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotAPIKey = r.Header.Get("x-goog-api-key")
		gotCT = r.Header.Get("content-type")
		gotBody, _ = io.ReadAll(io.LimitReader(r.Body, 1<<20))
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(geminiSuccessBody(t, "{\"campaign_id\":\"x\",\"diagnosis\":\"ok\"}"))
	}))
	defer srv.Close()

	c := &GeminiClient{APIKey: "test-key", BaseURL: srv.URL, MaxTokens: 1024, MaxRetries: 0}
	out, err := c.Complete(context.Background(), "sys-prompt", "user-payload", "gemini-3.1-pro-preview")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if out != `{"campaign_id":"x","diagnosis":"ok"}` {
		t.Errorf("unexpected output: %q", out)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method=%q want POST", gotMethod)
	}
	if gotAPIKey != "test-key" {
		t.Errorf("api key header=%q", gotAPIKey)
	}
	if !strings.Contains(gotCT, "application/json") {
		t.Errorf("content-type=%q", gotCT)
	}
	if !strings.HasSuffix(gotPath, "/v1beta/models/gemini-3.1-pro-preview:generateContent") {
		t.Errorf("path=%q does not match generateContent endpoint", gotPath)
	}

	var sent struct {
		Contents []struct {
			Role  string `json:"role"`
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"contents"`
		SystemInstruction struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"systemInstruction"`
		GenerationConfig struct {
			MaxOutputTokens int     `json:"maxOutputTokens"`
			Temperature     float64 `json:"temperature"`
		} `json:"generationConfig"`
	}
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode outbound body: %v\n%s", err, string(gotBody))
	}
	if len(sent.Contents) != 1 || sent.Contents[0].Role != "user" ||
		len(sent.Contents[0].Parts) != 1 || sent.Contents[0].Parts[0].Text != "user-payload" {
		t.Errorf("contents shape unexpected: %+v", sent.Contents)
	}
	if len(sent.SystemInstruction.Parts) != 1 || sent.SystemInstruction.Parts[0].Text != "sys-prompt" {
		t.Errorf("systemInstruction shape unexpected: %+v", sent.SystemInstruction)
	}
	if sent.GenerationConfig.MaxOutputTokens != 1024 {
		t.Errorf("maxOutputTokens=%d want 1024", sent.GenerationConfig.MaxOutputTokens)
	}
}

func TestGeminiComplete_StripsJSONFence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(geminiSuccessBody(t, "```json\n{\"a\":1}\n```"))
	}))
	defer srv.Close()

	c := &GeminiClient{APIKey: "k", BaseURL: srv.URL, MaxRetries: 0}
	out, err := c.Complete(context.Background(), "s", "u", "")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if out != `{"a":1}` {
		t.Errorf("fence not stripped: %q", out)
	}
}

func TestGeminiComplete_CapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(geminiMaxResponseBodyBytes)+1)))
	}))
	defer srv.Close()

	c := &GeminiClient{APIKey: "k", BaseURL: srv.URL, MaxRetries: 0}
	_, err := c.Complete(context.Background(), "s", "u", "gemini-3.1-pro-preview")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("Complete err = %v, want response body too large", err)
	}
}

func TestGeminiComplete_429Retry(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			http.Error(w, `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}`, http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write(geminiSuccessBody(t, "ok"))
	}))
	defer srv.Close()

	c := &GeminiClient{APIKey: "k", BaseURL: srv.URL, MaxRetries: 3}
	out, err := c.Complete(context.Background(), "s", "u", "gemini-3.1-pro-preview")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if out != "ok" {
		t.Errorf("output=%q", out)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("calls=%d want 2 (1 retry after 429)", got)
	}
}

func TestGeminiComplete_NonRetryable4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := &GeminiClient{APIKey: "k", BaseURL: srv.URL, MaxRetries: 3}
	_, err := c.Complete(context.Background(), "s", "u", "gemini-3.1-pro-preview")
	if err == nil {
		t.Fatal("expected error on 401")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("calls=%d want 1 (no retry on 401)", got)
	}
}

func TestGeminiComplete_ModelRemap(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write(geminiSuccessBody(t, "ok"))
	}))
	defer srv.Close()

	// Legacy claude-sonnet-* should be remapped to gemini-3.1-pro-preview.
	c := &GeminiClient{APIKey: "k", BaseURL: srv.URL, MaxRetries: 0}
	if _, err := c.Complete(context.Background(), "s", "u", "claude-sonnet-4-6"); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.Contains(gotPath, "gemini-3.1-pro-preview:generateContent") {
		t.Errorf("claude-sonnet remap path=%q, expected gemini-3.1-pro-preview", gotPath)
	}

	// Legacy claude-haiku-* should be remapped to gemini-3-flash-preview.
	if _, err := c.Complete(context.Background(), "s", "u", "claude-haiku-4-5-20251001"); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.Contains(gotPath, "gemini-3-flash-preview:generateContent") {
		t.Errorf("claude-haiku remap path=%q, expected gemini-3-flash-preview", gotPath)
	}

	// Empty model falls back to package default.
	if _, err := c.Complete(context.Background(), "s", "u", ""); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if !strings.Contains(gotPath, Model+":generateContent") {
		t.Errorf("empty-model fallback path=%q, expected %s", gotPath, Model)
	}
}

func TestGeminiComplete_EmptyResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"candidates":[]}`))
	}))
	defer srv.Close()
	c := &GeminiClient{APIKey: "k", BaseURL: srv.URL, MaxRetries: 0}
	_, err := c.Complete(context.Background(), "s", "u", "gemini-3.1-pro-preview")
	if err == nil {
		t.Fatal("expected error on empty candidates")
	}
}

func TestNewGeminiClient_LegacyEnvFallback(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "legacy-key")
	c := NewGeminiClient()
	if c == nil {
		t.Fatal("NewGeminiClient returned nil with legacy env set")
	}
	if c.APIKey != "legacy-key" {
		t.Errorf("APIKey=%q want legacy-key", c.APIKey)
	}
}

func TestNewGeminiClient_PrefersGeminiEnv(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "primary-key")
	t.Setenv("ANTHROPIC_API_KEY", "legacy-key")
	c := NewGeminiClient()
	if c == nil {
		t.Fatal("NewGeminiClient returned nil")
	}
	if c.APIKey != "primary-key" {
		t.Errorf("APIKey=%q want primary-key (GEMINI_API_KEY takes precedence)", c.APIKey)
	}
}

func TestNewGeminiClient_NoKey(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	if c := NewGeminiClient(); c != nil {
		t.Fatalf("expected nil client when both envs unset, got %+v", c)
	}
}

func TestStripJSONFence(t *testing.T) {
	cases := []struct{ in, want string }{
		{"{\"a\":1}", `{"a":1}`},
		{"```json\n{\"a\":1}\n```", `{"a":1}`},
		{"```\n{\"a\":1}\n```", `{"a":1}`},
		{"   ```json\n{\"a\":1}\n```   ", `{"a":1}`},
	}
	for _, c := range cases {
		if got := stripJSONFence(c.in); got != c.want {
			t.Errorf("stripJSONFence(%q)=%q want %q", c.in, got, c.want)
		}
	}
}
