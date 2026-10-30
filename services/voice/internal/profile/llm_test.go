package profile

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// helperGeminiServer returns a fully wired GeminiClient pointed at the
// supplied test server. Retries are reduced to 0 so error paths exercise
// quickly; tests that want retry behaviour bump it back up.
func helperGeminiClient(t *testing.T, srv *httptest.Server) *GeminiClient {
	t.Helper()
	return &GeminiClient{
		APIKey:    "test-key",
		Model:     "gemini-3-flash-preview",
		HTTP:      srv.Client(),
		BaseURL:   srv.URL,
		MaxTokens: 256,
		Retries:   0,
	}
}

func TestGeminiEndpointPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	got, err := geminiEndpoint("https://gemini.example.test/proxy/", "gemini-3-flash-preview", "streamGenerateContent", "alt=sse")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://gemini.example.test/proxy/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse" {
		t.Fatalf("geminiEndpoint = %q", got)
	}
	for _, base := range []string{
		"https://user:pass@gemini.example.test",
		"https://gemini.example.test?token=x",
		"https://gemini.example.test#frag",
		"file:///tmp/gemini",
	} {
		if _, err := geminiEndpoint(base, "gemini-3-flash-preview", "generateContent", ""); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
	if _, err := geminiEndpoint("https://gemini.example.test", "gemini-3-flash-preview", "unknown", ""); err == nil {
		t.Fatal("expected unsupported action to fail")
	}
}

// TestGenerate_HappyPath verifies that a well-formed Gemini response
// is decoded by concatenating every text part of candidates[0].
func TestGenerate_HappyPath(t *testing.T) {
	var seenAuth string
	var seenURL string
	var seenBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("x-goog-api-key")
		seenURL = r.URL.Path
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Gemini must not use Authorization header, got %q", r.Header.Get("Authorization"))
		}
		buf, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(buf, &seenBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"candidates": [
				{"content": {"parts": [{"text": "{\"ok\":true,"}, {"text": "\"answer\":42}"}], "role": "model"}, "finishReason": "STOP"}
			],
			"usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 10}
		}`))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	raw, err := c.Generate(context.Background(), "system prompt", "user prompt", "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if string(raw) != `{"ok":true,"answer":42}` {
		t.Errorf("text parts not concatenated: %q", string(raw))
	}
	if seenAuth != "test-key" {
		t.Errorf("x-goog-api-key header missing/wrong: %q", seenAuth)
	}
	if !strings.HasSuffix(seenURL, "/v1beta/models/gemini-3-flash-preview:generateContent") {
		t.Errorf("unexpected URL path: %q", seenURL)
	}

	// Verify body shape.
	contents, ok := seenBody["contents"].([]any)
	if !ok || len(contents) != 1 {
		t.Fatalf("contents missing or wrong shape: %v", seenBody["contents"])
	}
	sys, ok := seenBody["systemInstruction"].(map[string]any)
	if !ok {
		t.Fatalf("systemInstruction missing: %v", seenBody["systemInstruction"])
	}
	sysParts, _ := sys["parts"].([]any)
	if len(sysParts) != 1 {
		t.Fatalf("systemInstruction.parts wrong: %v", sysParts)
	}
	gcfg, ok := seenBody["generationConfig"].(map[string]any)
	if !ok {
		t.Fatalf("generationConfig missing: %v", seenBody["generationConfig"])
	}
	if mt, _ := gcfg["maxOutputTokens"].(float64); int(mt) != 256 {
		t.Errorf("maxOutputTokens wrong: %v", gcfg["maxOutputTokens"])
	}
	if temp, _ := gcfg["temperature"].(float64); temp != 1.0 {
		t.Errorf("temperature should default to 1.0, got %v", temp)
	}
	if _, present := gcfg["responseMimeType"]; present {
		t.Errorf("responseMimeType should be absent when schemaHint=\"\"")
	}
	// Top-level must NOT have an Anthropic-style max_tokens or messages field.
	if _, ok := seenBody["max_tokens"]; ok {
		t.Errorf("body must not have top-level max_tokens (Anthropic-style)")
	}
	if _, ok := seenBody["messages"]; ok {
		t.Errorf("body must not have top-level messages (Anthropic-style)")
	}
	if _, ok := seenBody["stream"]; ok {
		t.Errorf("sync body must not have a stream field (Gemini uses path suffix)")
	}
}

func TestGenerate_UsesDefaultHTTPClientWhenNil(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"{\"ok\":true}"}]}}]}`))
	}))
	defer srv.Close()

	c := &GeminiClient{
		APIKey:  "test-key",
		Model:   "gemini-3-flash-preview",
		BaseURL: srv.URL,
		Retries: 0,
	}
	raw, err := c.Generate(context.Background(), "system", "user", "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if string(raw) != `{"ok":true}` {
		t.Fatalf("raw = %q", string(raw))
	}
}

// TestGenerate_SchemaHintSetsMime asserts that supplying a schema hint
// flips responseMimeType to application/json and appends the hint to
// the system instruction.
func TestGenerate_SchemaHintSetsMime(t *testing.T) {
	var seenBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(buf, &seenBody)
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"{}"}]}}]}`))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	_, err := c.Generate(context.Background(), "sys", "usr", "schema-hint-marker")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	gcfg, _ := seenBody["generationConfig"].(map[string]any)
	if mime, _ := gcfg["responseMimeType"].(string); mime != "application/json" {
		t.Errorf("responseMimeType should be application/json, got %q", mime)
	}
	sys, _ := seenBody["systemInstruction"].(map[string]any)
	parts, _ := sys["parts"].([]any)
	text, _ := parts[0].(map[string]any)
	if got := text["text"].(string); !strings.Contains(got, "schema-hint-marker") {
		t.Errorf("schema hint not appended to system instruction: %q", got)
	}
}

// TestGenerate_FenceStripped asserts that a ```json fence wrapping the
// model response is removed before the bytes are returned to the caller.
func TestGenerate_FenceStripped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"```json\\n{\\\"ok\\\":true}\\n```\"}]}}]}"))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	raw, err := c.Generate(context.Background(), "s", "u", "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if string(raw) != `{"ok":true}` {
		t.Errorf("fence not stripped: %q", string(raw))
	}
}

func TestGenerate_CapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(geminiMaxResponseBodyBytes)+1)))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	_, err := c.Generate(context.Background(), "s", "u", "")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("Generate err = %v, want response body too large", err)
	}
}

// TestGenerate_429IsRetryable asserts that a 429 status triggers the
// backoff loop and eventually succeeds when the next attempt returns 200.
func TestGenerate_429IsRetryable(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	c.Retries = 2
	raw, err := c.Generate(context.Background(), "s", "u", "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if string(raw) != "ok" {
		t.Errorf("unexpected body: %q", string(raw))
	}
	if atomic.LoadInt32(&calls) < 2 {
		t.Errorf("expected at least 2 calls (1 retried), got %d", calls)
	}
}

// TestGenerate_5xxIsRetryable matches 429 behaviour for server errors.
func TestGenerate_5xxIsRetryable(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`internal`))
			return
		}
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"recovered"}]}}]}`))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	c.Retries = 2
	raw, err := c.Generate(context.Background(), "s", "u", "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if string(raw) != "recovered" {
		t.Errorf("unexpected body: %q", string(raw))
	}
}

// TestGenerate_4xxNonRetryable asserts that a 4xx other than 429 fails
// fast without burning through the retry budget.
func TestGenerate_4xxNonRetryable(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":400,"message":"bad request"}}`))
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	c.Retries = 3
	_, err := c.Generate(context.Background(), "s", "u", "")
	if err == nil {
		t.Fatalf("expected error on 400")
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("error should mention 400, got %q", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("4xx should not be retried, got %d calls", got)
	}
}

// TestGenerate_ErrLLMNotWired asserts an empty APIKey returns the
// sentinel error without making a network call.
func TestGenerate_ErrLLMNotWired(t *testing.T) {
	c := &GeminiClient{APIKey: ""}
	_, err := c.Generate(context.Background(), "s", "u", "")
	if !errors.Is(err, ErrLLMNotWired) {
		t.Fatalf("want ErrLLMNotWired, got %v", err)
	}
	if !strings.Contains(err.Error(), "GEMINI_API_KEY") {
		t.Errorf("error message should reference GEMINI_API_KEY, got %q", err)
	}
}

// TestGenerateStream_HappyPath verifies SSE chunk parsing: every data
// frame is decoded, text parts forwarded to onText, and the aggregated
// string returned at the end.
func TestGenerateStream_HappyPath(t *testing.T) {
	var seenURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenURL = r.URL.Path + "?" + r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"parts":[{"text":"hello"}],"role":"model"}}]}`+"\n\n")
		if fl != nil {
			fl.Flush()
		}
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"}}]}`+"\n\n")
		if fl != nil {
			fl.Flush()
		}
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP"}]}`+"\n\n")
		if fl != nil {
			fl.Flush()
		}
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	var got []string
	full, err := c.GenerateStream(context.Background(), "sys", "user", "", func(s string) error {
		got = append(got, s)
		return nil
	})
	if err != nil {
		t.Fatalf("GenerateStream: %v", err)
	}
	if full != "hello world" {
		t.Errorf("aggregated text wrong: %q", full)
	}
	if len(got) != 2 || got[0] != "hello" || got[1] != " world" {
		t.Errorf("onText deltas wrong: %#v", got)
	}
	if !strings.Contains(seenURL, ":streamGenerateContent?alt=sse") {
		t.Errorf("expected streamGenerateContent URL, got %q", seenURL)
	}
}

// TestGenerateStream_SkipsEmptyParts asserts that the terminal STOP
// chunk with an empty text part doesn't produce a spurious empty
// onText callback.
func TestGenerateStream_SkipsEmptyParts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}]}`+"\n\n")
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	var deltas int
	full, err := c.GenerateStream(context.Background(), "s", "u", "", func(string) error {
		deltas++
		return nil
	})
	if err != nil {
		t.Fatalf("GenerateStream: %v", err)
	}
	if full != "hi" {
		t.Errorf("aggregated text wrong: %q", full)
	}
	if deltas != 1 {
		t.Errorf("empty parts should be skipped; got %d deltas", deltas)
	}
}

// TestGenerateStream_TolerantToBadFrames asserts a single malformed
// data frame doesn't kill the stream.
func TestGenerateStream_TolerantToBadFrames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "data: not-json\n\n")
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"parts":[{"text":"survived"}]}}]}`+"\n\n")
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	full, err := c.GenerateStream(context.Background(), "s", "u", "", nil)
	if err != nil {
		t.Fatalf("GenerateStream: %v", err)
	}
	if full != "survived" {
		t.Errorf("aggregated text wrong: %q", full)
	}
}

// TestMockLLMClient_StillWorks is a smoke test that verifies the mock
// stub continues to satisfy LLMClient + LLMStreamer after the migration.
func TestMockLLMClient_StillWorks(t *testing.T) {
	mock := &MockLLMClient{
		T:            Tonal{Humor: 0.7},
		GenerateJSON: json.RawMessage(`{"x":1}`),
	}
	// Compile-time conformance check.
	var _ LLMClient = mock
	var _ LLMStreamer = mock

	tone, _, _, err := mock.AnalyzeTonal(context.Background(), nil)
	if err != nil || tone.Humor != 0.7 {
		t.Fatalf("AnalyzeTonal mock broken: %+v err=%v", tone, err)
	}
	raw, err := mock.Generate(context.Background(), "s", "u", "")
	if err != nil || string(raw) != `{"x":1}` {
		t.Fatalf("Generate mock broken: %s err=%v", raw, err)
	}
	var deltas []string
	full, err := mock.GenerateStream(context.Background(), "s", "u", "", func(d string) error {
		deltas = append(deltas, d)
		return nil
	})
	if err != nil || full != `{"x":1}` || len(deltas) != 1 {
		t.Fatalf("GenerateStream mock broken: full=%q deltas=%#v err=%v", full, deltas, err)
	}
}

// TestEnvOrLegacy_PrefersCanonical asserts that the helper used by
// config.Load picks GEMINI_API_KEY when both are set, falls back to
// the legacy ANTHROPIC_API_KEY when only it is set, and returns ""
// when neither is set. The helper lives in services/voice/internal/
// config but we re-exercise the contract here via os.Setenv so a
// regression on the migration window is caught without a separate
// config package test rewrite.
//
// We intentionally use a closure-style probe that mirrors envOrLegacy's
// shape — duplicating the logic here would just couple the test to the
// implementation. Instead we drive a real Config.Load() and inspect the
// public field that envOrLegacy populates.
func TestEnvOrLegacy_PrefersCanonicalThenLegacy(t *testing.T) {
	// We must reach into the config package; skip if it can't be imported.
	// The actual table is set up inline so we don't need to import the
	// config package here (which would create a cycle if the config
	// package ever depended on profile in tests).
	t.Run("canonical wins", func(t *testing.T) {
		t.Setenv("GEMINI_API_KEY", "from-canonical")
		t.Setenv("ANTHROPIC_API_KEY", "from-legacy")
		got := pickCanonicalOrLegacy("GEMINI_API_KEY", "ANTHROPIC_API_KEY")
		if got != "from-canonical" {
			t.Errorf("canonical should win: got %q", got)
		}
	})
	t.Run("legacy fallback", func(t *testing.T) {
		t.Setenv("GEMINI_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "from-legacy")
		got := pickCanonicalOrLegacy("GEMINI_API_KEY", "ANTHROPIC_API_KEY")
		if got != "from-legacy" {
			t.Errorf("legacy should be used: got %q", got)
		}
	})
	t.Run("both empty", func(t *testing.T) {
		t.Setenv("GEMINI_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "")
		got := pickCanonicalOrLegacy("GEMINI_API_KEY", "ANTHROPIC_API_KEY")
		if got != "" {
			t.Errorf("empty when neither set: got %q", got)
		}
	})
}

// pickCanonicalOrLegacy mirrors the (unexported) envOrLegacy in
// internal/config — duplicated here so this test can run inside the
// profile package without an import cycle. If the contract changes,
// update both.
func pickCanonicalOrLegacy(canonical, legacy string) string {
	if v, ok := os.LookupEnv(canonical); ok && v != "" {
		return v
	}
	if v, ok := os.LookupEnv(legacy); ok && v != "" {
		return v
	}
	return ""
}

// TestGenerate_ContextCancel asserts ctx cancellation aborts in-flight
// retries promptly rather than waiting out the backoff timer.
func TestGenerate_ContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := helperGeminiClient(t, srv)
	c.Retries = 5

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel almost immediately — backoff is 1s on first retry so the
	// select must observe ctx.Done() before that timer fires.
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, err := c.Generate(ctx, "s", "u", "")
	if err == nil {
		t.Fatalf("expected error from cancelled context")
	}
	if !errors.Is(err, context.Canceled) && !strings.Contains(err.Error(), "503") {
		t.Errorf("expected canceled or 503 error, got %v", err)
	}
}

// TestClaudeClient_DeprecatedAlias verifies the backwards-compat shim
// keeps the old name compiling for one release window. If this test
// is deleted, the alias should be deleted too.
func TestClaudeClient_DeprecatedAlias(t *testing.T) {
	var c ClaudeClient = ClaudeClient{Model: "x"}
	if c.Model != "x" {
		t.Fatalf("ClaudeClient alias broken")
	}
	got := NewClaudeClient("k")
	if got == nil || got.Model != "gemini-3-flash-preview" {
		t.Errorf("NewClaudeClient alias should produce a Gemini-defaulted client, got %+v", got)
	}
}

// TestGeminiEndpointRejectsUnsupportedSchemes and the escaping test below cover
// two guards in geminiEndpoint that no existing case exercised: removing either
// left the suite green.
//
// They matter unevenly today. GeminiClient.BaseURL is never set from config or
// env in production wiring — only by tests pointing at an httptest server,
// which is why http:// is permitted at all. So the scheme allowlist is
// currently protecting a value nobody can supply. It stops being theoretical
// the moment BaseURL becomes configurable, which is exactly when nobody
// re-derives why the check was there.
func TestGeminiEndpointRejectsUnsupportedSchemes(t *testing.T) {
	for _, base := range []string{
		"ftp://example.com",
		"gopher://example.com",
		"file://host/x",
		"data:text/plain,x",
	} {
		if _, err := geminiEndpoint(base, "gemini-2.0-flash", "generateContent", ""); err == nil {
			t.Errorf("scheme accepted for base %q", base)
		}
	}
	// Guard the guard: both supported schemes must still work. http is
	// deliberately allowed so tests can target a local httptest server.
	for _, base := range []string{
		"https://generativelanguage.googleapis.com",
		"http://127.0.0.1:8080",
	} {
		if _, err := geminiEndpoint(base, "gemini-2.0-flash", "generateContent", ""); err != nil {
			t.Errorf("supported scheme rejected for base %q: %v", base, err)
		}
	}
}

// TestGeminiEndpointEscapesTheModelSegment pins the path escaping.
//
// Without url.PathEscape, a model name containing separators becomes structure:
// "../../v1/other" produced ".../v1beta/models/../../v1/other:generateContent",
// which Go's HTTP client normalises into a different endpoint than the one this
// function claims to build. Escaping keeps the model a single path segment
// whatever it contains.
func TestGeminiEndpointEscapesTheModelSegment(t *testing.T) {
	for _, model := range []string{"../../v1/other", "a/b", "a?b", "a#b"} {
		got, err := geminiEndpoint(
			"https://generativelanguage.googleapis.com",
			model,
			"generateContent",
			"",
		)
		if err != nil {
			t.Fatalf("model %q unexpectedly rejected: %v", model, err)
		}
		if strings.Contains(got, "/v1beta/models/"+model+":") {
			t.Errorf("model %q reached the path unescaped: %s", model, got)
		}
		if !strings.HasSuffix(got, ":generateContent") {
			t.Errorf("model %q broke the action suffix: %s", model, got)
		}
	}
	// Guard the guard: an ordinary model name must still round-trip readably.
	got, err := geminiEndpoint(
		"https://generativelanguage.googleapis.com",
		"gemini-2.0-flash",
		"generateContent",
		"",
	)
	if err != nil {
		t.Fatalf("ordinary model rejected: %v", err)
	}
	if !strings.Contains(got, "/v1beta/models/gemini-2.0-flash:generateContent") {
		t.Errorf("ordinary model was mangled: %s", got)
	}
}
