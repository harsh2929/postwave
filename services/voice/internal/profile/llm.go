package profile

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// LLMClient is the interface profile.Build uses to enrich a profile with
// LLM-derived signals (Tonal, Persona, Vocabulary.MetaphorPatterns) AND
// the interface generation.Engine uses for structured generation.
//
// The profile package owns this interface so the import-graph stays
// generation -> profile rather than the other way around.
type LLMClient interface {
	AnalyzeTonal(ctx context.Context, samples []string) (Tonal, Persona, []string, error)
	// Generate runs a single Gemini generateContent API call with the
	// supplied system + user content. If schemaHint is non-empty it is
	// appended to the system instruction (and responseMimeType is set to
	// application/json) to push Gemini toward structured-JSON output.
	// Returns the model's text content as raw JSON bytes — callers are
	// responsible for json.Unmarshal into their target shape.
	Generate(ctx context.Context, system, user, schemaHint string) (json.RawMessage, error)
}

// LLMStreamer is implemented by clients that can stream the generateContent
// API over SSE. The chat handler uses this to forward live deltas to the
// browser; profile-build / sequence-gen still use the synchronous Generate
// path because they need a fully-formed JSON document to parse.
//
// onText is called once per text delta from Gemini (each chunk arrives
// inside a `candidates[0].content.parts[].text` field on a streamed
// GenerateContentResponse). The method blocks until Gemini finishes
// streaming or ctx is cancelled. The aggregated text is also returned
// for callers that want it (e.g. to parse a structured draft).
//
// Implementations must respect ctx.Done() — the handler relies on aborting
// the upstream connection promptly when the browser disconnects.
type LLMStreamer interface {
	GenerateStream(ctx context.Context, system, user, schemaHint string, onText func(string) error) (string, error)
}

// GeminiClient is the production LLM client. It speaks the Gemini
// generateContent API directly via net/http; hand-rolled to avoid the
// google.golang.org/genai dependency for a small surface area.
type GeminiClient struct {
	APIKey  string
	Model   string // default "gemini-3-flash-preview"
	HTTP    *http.Client
	BaseURL string // default "https://generativelanguage.googleapis.com"
	// MaxTokens caps generateContent output. Defaults to 4096.
	MaxTokens int
	// Retries controls 429/5xx exponential-backoff retries (3 by default,
	// 1s/2s/4s sleeps).
	Retries int
}

// NewGeminiClient returns a client using Flash 3 by default.
// defaultMaxOutputTokens is the cap applied when a caller leaves
// GeminiClient.MaxTokens unset. It was the bare literal 4096 written out
// separately in Generate and GenerateStream, so the two paths could drift
// apart with nothing to notice — a streaming call and a non-streaming call
// would then truncate at different lengths for the same request.
const defaultMaxOutputTokens = 4096

func NewGeminiClient(apiKey string) *GeminiClient {
	return &GeminiClient{
		APIKey:    apiKey,
		Model:     "gemini-3-flash-preview",
		HTTP:      &http.Client{Timeout: 120 * time.Second},
		MaxTokens: 4096,
		Retries:   3,
	}
}

const (
	geminiStreamDefaultTimeout    = 5 * time.Minute
	geminiStreamHTTPClientTimeout = geminiStreamDefaultTimeout + 30*time.Second
	geminiMaxResponseBodyBytes    = 1 << 20
)

// ClaudeClient is the deprecated name for GeminiClient.
//
// Deprecated: ClaudeClient is the old name for GeminiClient retained as
// a type alias so any unmigrated callers in tests still compile. Will be
// removed in v0.3. Use GeminiClient directly.
type ClaudeClient = GeminiClient

// NewClaudeClient is the deprecated constructor for the old ClaudeClient
// type. It is preserved as a thin alias for NewGeminiClient so existing
// test code keeps building during the migration window.
//
// Deprecated: use NewGeminiClient.
var NewClaudeClient = NewGeminiClient

const analyzePrompt = `You are analyzing a writer's voice from representative passages.
Score each tonal axis on 0..1 and identify themes/metaphor patterns.
Respond with ONLY a JSON object with this exact shape (no prose, no markdown):
{
  "tonal": {
    "humor": number,
    "optimism": number,
    "personal_vs_observational": number,
    "directness": number
  },
  "persona": {
    "self_disclosure_rate": number,
    "recurring_themes": [string]
  },
  "metaphor_patterns": [string]
}`

type analyzeResp struct {
	Tonal struct {
		Humor                   float64 `json:"humor"`
		Optimism                float64 `json:"optimism"`
		PersonalVsObservational float64 `json:"personal_vs_observational"`
		Directness              float64 `json:"directness"`
	} `json:"tonal"`
	Persona struct {
		SelfDisclosureRate float64  `json:"self_disclosure_rate"`
		RecurringThemes    []string `json:"recurring_themes"`
	} `json:"persona"`
	MetaphorPatterns []string `json:"metaphor_patterns"`
}

// AnalyzeTonal sends the prompt + samples to Gemini and decodes the JSON
// response.
func (c *GeminiClient) AnalyzeTonal(ctx context.Context, samples []string) (Tonal, Persona, []string, error) {
	if c.APIKey == "" {
		return Tonal{}, Persona{}, nil, ErrLLMNotWired
	}
	user := "Passages:\n\n" + joinSamples(samples)
	raw, err := c.Generate(ctx, analyzePrompt, user, "")
	if err != nil {
		return Tonal{}, Persona{}, nil, err
	}
	var ar analyzeResp
	if err := json.Unmarshal(raw, &ar); err != nil {
		return Tonal{}, Persona{}, nil, fmt.Errorf("gemini: decode tonal: %w", err)
	}
	return Tonal{
			Humor:                   ar.Tonal.Humor,
			Optimism:                ar.Tonal.Optimism,
			PersonalVsObservational: ar.Tonal.PersonalVsObservational,
			Directness:              ar.Tonal.Directness,
		}, Persona{
			PronounUsage:       map[string]float64{},
			SelfDisclosureRate: ar.Persona.SelfDisclosureRate,
			RecurringThemes:    ar.Persona.RecurringThemes,
		}, ar.MetaphorPatterns, nil
}

// Generate runs a Gemini generateContent API call. schemaHint, if
// non-empty, is appended to the system instruction as a final reminder
// of the JSON shape AND triggers responseMimeType=application/json on
// the generationConfig.
func (c *GeminiClient) Generate(ctx context.Context, system, user, schemaHint string) (json.RawMessage, error) {
	if c.APIKey == "" {
		return nil, ErrLLMNotWired
	}
	base := c.BaseURL
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	model := c.Model
	if model == "" {
		model = "gemini-3-flash-preview"
	}
	maxTokens := c.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxOutputTokens
	}
	if schemaHint != "" {
		system = system + "\n\n" + schemaHint
	}

	generationConfig := map[string]any{
		// Per Gemini 3 docs, lower temperatures can cause "looping or
		// degraded performance" on reasoning models. Keep default of 1.0.
		"temperature":     1.0,
		"maxOutputTokens": maxTokens,
	}
	if schemaHint != "" {
		generationConfig["responseMimeType"] = "application/json"
	}

	body := map[string]any{
		"contents": []map[string]any{
			{"role": "user", "parts": []map[string]any{{"text": user}}},
		},
		"systemInstruction": map[string]any{
			"parts": []map[string]any{{"text": system}},
		},
		"generationConfig": generationConfig,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	url, err := geminiEndpoint(base, model, "generateContent", "")
	if err != nil {
		return nil, err
	}

	retries := c.Retries
	if retries <= 0 {
		retries = 3
	}
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		raw, retryable, err := c.doOnce(ctx, url, buf)
		if err == nil {
			return raw, nil
		}
		lastErr = err
		if !retryable || attempt == retries {
			break
		}
		// Exponential backoff: 1s, 2s, 4s.
		sleep := time.Duration(1<<attempt) * time.Second
		// Jitter ±20% so concurrent retries don't lockstep.
		jitter := time.Duration(float64(sleep) * (0.8 + 0.4*rand.Float64()))
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(jitter):
		}
	}
	return nil, lastErr
}

// doOnce makes a single attempt against generateContent. retryable is
// true on 429 / 5xx / network errors.
func (c *GeminiClient) doOnce(ctx context.Context, url string, buf []byte) (json.RawMessage, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	req.Header.Set("content-type", "application/json")

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("gemini: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := readResponseBodyLimited(resp.Body, geminiMaxResponseBodyBytes)
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode/100 == 5 {
		if readErr != nil {
			return nil, true, fmt.Errorf("gemini: status %d: %w", resp.StatusCode, readErr)
		}
		return nil, true, fmt.Errorf("gemini: status %d: %s", resp.StatusCode, string(raw))
	}
	if resp.StatusCode/100 != 2 {
		if readErr != nil {
			return nil, false, fmt.Errorf("gemini: status %d: %w", resp.StatusCode, readErr)
		}
		return nil, false, fmt.Errorf("gemini: status %d: %s", resp.StatusCode, string(raw))
	}
	if readErr != nil {
		return nil, false, fmt.Errorf("gemini: %w", readErr)
	}

	// The generateContent response is:
	//   { "candidates": [ { "content": { "parts": [ {"text":"..."} ] } } ] }
	// We concatenate all text parts of the first candidate.
	var env struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
				Role string `json:"role"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, false, fmt.Errorf("gemini: decode envelope: %w", err)
	}
	if len(env.Candidates) == 0 {
		return nil, false, errors.New("gemini: no candidates in response")
	}
	var sb strings.Builder
	for _, p := range env.Candidates[0].Content.Parts {
		sb.WriteString(p.Text)
	}
	out := sb.String()
	if out == "" {
		return nil, false, errors.New("gemini: no text content in response")
	}
	return json.RawMessage(stripJSONFence(out)), false, nil
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return raw, nil
}

func geminiEndpoint(baseRaw, model, action, rawQuery string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid Gemini base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported Gemini base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe Gemini base URL")
	}
	if action != "generateContent" && action != "streamGenerateContent" {
		return "", fmt.Errorf("unsupported Gemini action")
	}
	model = strings.TrimSpace(model)
	if model == "" {
		return "", fmt.Errorf("Gemini model required")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/v1beta/models/" + url.PathEscape(model) + ":" + action
	base.RawQuery = rawQuery
	return base.String(), nil
}

// stripJSONFence removes a leading/trailing ```json fence if Gemini
// emitted one despite the responseMimeType instruction.
func stripJSONFence(s string) string {
	s = trimAll(s)
	if len(s) >= 7 && s[:7] == "```json" {
		s = s[7:]
	} else if len(s) >= 3 && s[:3] == "```" {
		s = s[3:]
	}
	s = trimAll(s)
	if len(s) >= 3 && s[len(s)-3:] == "```" {
		s = s[:len(s)-3]
	}
	return trimAll(s)
}

func trimAll(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\n' || s[0] == '\r' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

func joinSamples(samples []string) string {
	out := ""
	for i, s := range samples {
		out += fmt.Sprintf("--- sample %d ---\n%s\n\n", i+1, s)
	}
	return out
}

// GenerateStream calls the streamGenerateContent endpoint (alt=sse) and
// forwards each text delta to onText. It returns the full concatenated
// text on success so callers can parse a structured draft after the
// stream ends.
//
// Wire format: standard Gemini SSE — every `data:` frame is a
// GenerateContentResponse chunk. We extract text from
// candidates[0].content.parts[].text and forward via onText.
//
// Retry semantics: only the initial connection is retried (same 429/5xx
// rules as Generate). Once the stream begins, a mid-stream failure
// returns immediately with whatever text we collected so far — partial
// output is preferable to silent restart-from-zero for chat UX.
func (c *GeminiClient) GenerateStream(ctx context.Context, system, user, schemaHint string, onText func(string) error) (string, error) {
	if c.APIKey == "" {
		return "", ErrLLMNotWired
	}
	ctx, cancel := withDefaultStreamDeadline(ctx)
	defer cancel()

	base := c.BaseURL
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	model := c.Model
	if model == "" {
		model = "gemini-3-flash-preview"
	}
	maxTokens := c.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxOutputTokens
	}
	if schemaHint != "" {
		system = system + "\n\n" + schemaHint
	}

	generationConfig := map[string]any{
		"temperature":     1.0,
		"maxOutputTokens": maxTokens,
	}
	if schemaHint != "" {
		generationConfig["responseMimeType"] = "application/json"
	}

	body := map[string]any{
		"contents": []map[string]any{
			{"role": "user", "parts": []map[string]any{{"text": user}}},
		},
		"systemInstruction": map[string]any{
			"parts": []map[string]any{{"text": system}},
		},
		"generationConfig": generationConfig,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return "", err
	}

	url, err := geminiEndpoint(base, model, "streamGenerateContent", "alt=sse")
	if err != nil {
		return "", err
	}

	retries := c.Retries
	if retries <= 0 {
		retries = 3
	}
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		full, retryable, err := c.streamOnce(ctx, url, buf, onText)
		if err == nil {
			return full, nil
		}
		// If we already started receiving text, don't retry — return what
		// we have rather than restarting from zero (browser would see two
		// streams of deltas).
		if full != "" {
			return full, err
		}
		lastErr = err
		if !retryable || attempt == retries {
			break
		}
		sleep := time.Duration(1<<attempt) * time.Second
		jitter := time.Duration(float64(sleep) * (0.8 + 0.4*rand.Float64()))
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(jitter):
		}
	}
	return "", lastErr
}

func withDefaultStreamDeadline(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, geminiStreamDefaultTimeout)
}

func (c *GeminiClient) streamOnce(ctx context.Context, url string, buf []byte, onText func(string) error) (string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "text/event-stream")

	// Override the default 120s timeout — streaming responses run as long
	// as Gemini is producing tokens, easily exceeding 2 minutes for long
	// drafts. The request context remains the primary deadline; the client
	// timeout is only a final backstop if callers construct a bare client.
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: geminiStreamHTTPClientTimeout}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", true, fmt.Errorf("gemini: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode/100 == 5 {
		errBody, err := readResponseBodyLimited(resp.Body, geminiMaxResponseBodyBytes)
		if err != nil {
			return "", true, fmt.Errorf("gemini: status %d: %w", resp.StatusCode, err)
		}
		return "", true, fmt.Errorf("gemini: status %d: %s", resp.StatusCode, string(errBody))
	}
	if resp.StatusCode/100 != 2 {
		errBody, err := readResponseBodyLimited(resp.Body, geminiMaxResponseBodyBytes)
		if err != nil {
			return "", false, fmt.Errorf("gemini: status %d: %w", resp.StatusCode, err)
		}
		return "", false, fmt.Errorf("gemini: status %d: %s", resp.StatusCode, string(errBody))
	}

	// Parse SSE: blank-line-delimited messages of `data:` lines. Gemini
	// has no `event:` tags — every data frame is a GenerateContentResponse
	// chunk of the same shape.
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var dataLines []string
	var full strings.Builder

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flushGeminiSSE(&dataLines, &full, onText); err != nil {
				return full.String(), false, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // SSE comment / keepalive
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimSpace(line[len("data:"):]), " "))
			continue
		}
		// Ignore any other field (event:, id:, retry:) — Gemini doesn't
		// use them but we stay tolerant.
	}
	if err := scanner.Err(); err != nil {
		return full.String(), false, fmt.Errorf("gemini: stream read: %w", err)
	}
	// Flush any trailing message that wasn't terminated by a blank line.
	if err := flushGeminiSSE(&dataLines, &full, onText); err != nil {
		return full.String(), false, err
	}
	return full.String(), false, nil
}

// flushGeminiSSE drains the captured dataLines into text deltas
// (forwarded to onText). The buffer is zeroed in place so the caller
// can keep collecting the next message. Malformed JSON frames are
// tolerated (skipped) so a single bad chunk can't kill the stream.
func flushGeminiSSE(dataLines *[]string, full *strings.Builder, onText func(string) error) error {
	if len(*dataLines) == 0 {
		return nil
	}
	joined := strings.Join(*dataLines, "\n")
	*dataLines = nil

	// Some servers send a literal "[DONE]" sentinel; Gemini doesn't
	// generally, but be tolerant.
	if strings.TrimSpace(joined) == "[DONE]" {
		return nil
	}

	var env struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
				Role string `json:"role"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(joined), &env); err != nil {
		// Tolerate malformed events.
		return nil
	}
	if env.Error != nil && env.Error.Message != "" {
		return errors.New(env.Error.Message)
	}
	if len(env.Candidates) == 0 {
		return nil
	}
	for _, p := range env.Candidates[0].Content.Parts {
		if p.Text == "" {
			continue
		}
		full.WriteString(p.Text)
		if onText != nil {
			if err := onText(p.Text); err != nil {
				return err
			}
		}
	}
	return nil
}

// ErrLLMNotWired indicates GEMINI_API_KEY is unset.
var ErrLLMNotWired = errors.New("profile: LLM client not wired (set GEMINI_API_KEY)")

// MockLLMClient returns canned values for tests.
type MockLLMClient struct {
	T   Tonal
	P   Persona
	Met []string
	Err error
	// GenerateMock, if set, is invoked by Generate. Otherwise GenerateJSON is returned.
	GenerateMock func(ctx context.Context, system, user, schemaHint string) (json.RawMessage, error)
	GenerateJSON json.RawMessage
}

// AnalyzeTonal implements LLMClient.
func (m *MockLLMClient) AnalyzeTonal(_ context.Context, _ []string) (Tonal, Persona, []string, error) {
	return m.T, m.P, m.Met, m.Err
}

// Generate implements LLMClient.
func (m *MockLLMClient) Generate(ctx context.Context, system, user, schemaHint string) (json.RawMessage, error) {
	if m.GenerateMock != nil {
		return m.GenerateMock(ctx, system, user, schemaHint)
	}
	if m.Err != nil {
		return nil, m.Err
	}
	return m.GenerateJSON, nil
}

// GenerateStream implements LLMStreamer for tests. Replays GenerateJSON
// (or GenerateMock's output) as a single delta so the chat handler's
// streaming path can be exercised in tests without a Gemini key.
func (m *MockLLMClient) GenerateStream(ctx context.Context, system, user, schemaHint string, onText func(string) error) (string, error) {
	raw, err := m.Generate(ctx, system, user, schemaHint)
	if err != nil {
		return "", err
	}
	out := string(raw)
	if onText != nil && out != "" {
		if err := onText(out); err != nil {
			return out, err
		}
	}
	return out, nil
}
