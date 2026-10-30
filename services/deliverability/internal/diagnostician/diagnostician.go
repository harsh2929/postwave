// Package diagnostician is Layer 5 — the AI Diagnostician. It takes structured
// signals from layers 1-4 and asks Gemini Pro to produce a Diagnosis with
// ranked fixes. The system prompt lives next to this file so changes ship
// with the binary; LLM calls go through an LLMClient interface so tests run
// without network and so we can swap providers later.
//
// V1 prompt assembly: the rubric (`system.md`) is concatenated with a
// worked-examples block (`few_shot.md`) before being sent as the system
// message. After the model returns, a post-response validator re-checks
// the JSON against the four hard constraints (action enum, impact sum cap,
// per-fix cap, no-invented-numbers); on violation the diagnostician sends
// a single targeted retry asking the model to regenerate.
package diagnostician

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Model is the Gemini model id we target for the Diagnostician
// (deep reasoning on spam-cause analysis).
const Model = "gemini-3.1-pro-preview"

const (
	maxDiagnosticianPromptFileBytes int64 = 256 << 10
	geminiMaxResponseBodyBytes      int64 = 1 << 20
)

// ModelFlash is the Gemini model id used by the Pre-Send Predictor's
// hot path (fast placement classification).
const ModelFlash = "gemini-3-flash-preview"

// ErrLLMNotWired is returned when the Diagnostician has no LLM client
// configured (missing GEMINI_API_KEY in production, no StubLLMClient in
// tests). Handlers translate this into a 503 so the UI can fall back to
// "diagnostician unavailable" rather than 500.
var ErrLLMNotWired = errors.New("diagnostician: LLM not wired (set GEMINI_API_KEY)")

// Stub fallback prompts used when no env path is set (self-host mode without
// custom prompts). Functional but uncalibrated.
const stubSystemPrompt = `You are a deliverability assistant. Given structured signals about an email campaign, return a JSON object with fields: diagnosis (one sentence), fixes (array of {title, action, detail, estimated_impact}), and predicted_impact (number 0..1). action must be one of: dns_record, copy_change, image_swap, resend. Return JSON only.`

const stubFewShotPrompt = `Example: if SPF check fails, return a fix with action "dns_record" and a detail explaining the missing record.`

var (
	promptCache struct {
		sync.RWMutex
		system  string
		fewShot string
		loaded  bool
	}
)

// findProprietary walks up from cwd looking for an in-repo proprietary
// mirror containing subPath. Used as a fallback when the env path isn't
// set (typical for tests run from a service subdirectory). Verifies that
// sentinel exists in the candidate directory before accepting it.
func findProprietary(subPath, sentinel string) string {
	cloud := filepath.Join("/etc/postwave/proprietary", subPath)
	if _, err := os.Stat(filepath.Join(cloud, sentinel)); err == nil {
		return cloud
	}
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	dir := cwd
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "proprietary", subPath)
		if _, err := os.Stat(filepath.Join(candidate, sentinel)); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// loadPrompts reads the Diagnostician system prompt + few-shot block from
// disk paths set via env, falling back to bundled stubs when missing. Result
// is cached for the process lifetime.
func loadPrompts() (system, fewShot string) {
	promptCache.RLock()
	if promptCache.loaded {
		s, f := promptCache.system, promptCache.fewShot
		promptCache.RUnlock()
		return s, f
	}
	promptCache.RUnlock()

	promptCache.Lock()
	defer promptCache.Unlock()
	if promptCache.loaded {
		return promptCache.system, promptCache.fewShot
	}

	dir := os.Getenv("DIAGNOSTICIAN_PROMPTS_PATH")
	if dir == "" {
		dir = findProprietary("prompts/diagnostician", "system.md")
	}

	system = stubSystemPrompt
	fewShot = stubFewShotPrompt
	if dir != "" {
		if b, err := readPromptFile(filepath.Join(dir, "system.md")); err == nil {
			system = string(b)
		}
		if b, err := readPromptFile(filepath.Join(dir, "few_shot.md")); err == nil {
			fewShot = string(b)
		}
	} else {
		slog.Warn("DIAGNOSTICIAN_PROMPTS_PATH not set, using stub prompts (uncalibrated)")
	}

	promptCache.system = system
	promptCache.fewShot = fewShot
	promptCache.loaded = true
	return system, fewShot
}

// ValidatePromptPack checks that production is using an explicit, non-stub
// prompt pack. It intentionally does not mutate the process prompt cache.
func ValidatePromptPack(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return errors.New("DIAGNOSTICIAN_PROMPTS_PATH is required")
	}
	systemPath := filepath.Join(dir, "system.md")
	fewShotPath := filepath.Join(dir, "few_shot.md")
	system, err := readPromptFile(systemPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", systemPath, err)
	}
	fewShot, err := readPromptFile(fewShotPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", fewShotPath, err)
	}
	systemText := strings.TrimSpace(string(system))
	fewShotText := strings.TrimSpace(string(fewShot))
	if systemText == "" || fewShotText == "" {
		return errors.New("prompt pack system.md and few_shot.md must both be non-empty")
	}
	if systemText == stubSystemPrompt || fewShotText == stubFewShotPrompt {
		return errors.New("prompt pack resolves to bundled stub prompts")
	}
	return nil
}

func readPromptFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	b, err := io.ReadAll(io.LimitReader(f, maxDiagnosticianPromptFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxDiagnosticianPromptFileBytes {
		return nil, fmt.Errorf("prompt file exceeds %d bytes", maxDiagnosticianPromptFileBytes)
	}
	return b, nil
}

// SystemPrompt returns the rubric concatenated with the worked-examples
// block. Loaded from DIAGNOSTICIAN_PROMPTS_PATH (or proprietary mirror or
// stub). Order is rubric → few-shot, matching in-context learning pattern.
func SystemPrompt() string {
	system, fewShot := loadPrompts()
	return system + "\n\n" + fewShot
}

// FewShotPrompt returns just the worked-examples block. Exposed for tests.
func FewShotPrompt() string {
	_, fewShot := loadPrompts()
	return fewShot
}

// Signals is the full Layer 1-4 payload handed to the Diagnostician.
type Signals struct {
	CampaignID string                `json:"campaign_id"`
	Domain     string                `json:"domain"`
	IP         string                `json:"ip"`
	Auth       domain.AuthCheck      `json:"auth"`
	Reputation domain.Reputation     `json:"reputation"`
	Content    domain.ContentScan    `json:"content"`
	Seedlist   domain.CampaignReport `json:"seedlist"`
}

// HasEvidence rejects campaign-id-only requests. A campaign identifier is a
// lookup key, not deliverability evidence; asking an LLM to infer placement,
// authentication, reputation, or content from that key produces fabricated
// certainty. Callers must supply at least one actual signal family.
func (s Signals) HasEvidence() bool {
	return strings.TrimSpace(s.Domain) != "" ||
		strings.TrimSpace(s.IP) != "" ||
		strings.TrimSpace(s.Auth.Domain) != "" ||
		s.Reputation.DataAvailable ||
		len(s.Reputation.BlacklistHits) > 0 ||
		len(s.Reputation.SourcesSucceeded) > 0 ||
		len(s.Reputation.SourcesFailed) > 0 ||
		strings.TrimSpace(s.Content.Model.Name) != "" ||
		len(s.Content.SpamReasons) > 0 ||
		len(s.Content.HTMLIssues) > 0 ||
		strings.TrimSpace(s.Seedlist.CampaignID) != "" ||
		len(s.Seedlist.Providers) > 0 ||
		len(s.Seedlist.Reports) > 0
}

// LLMClient abstracts the Gemini HTTP call. Implemented in production by an
// in-tree REST wrapper; mocked in tests. The interface is intentionally
// minimal: a single Complete call returning the raw model output.
type LLMClient interface {
	// Complete sends a system+user message pair and returns the assistant text.
	Complete(ctx context.Context, system, user, model string) (string, error)
}

// Diagnostician runs the diagnose pipeline.
type Diagnostician struct {
	LLM   LLMClient
	Model string
	TTL   time.Duration

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	at  time.Time
	dia domain.Diagnosis
}

// New returns a Diagnostician with a 24h cache TTL.
func New(llm LLMClient) *Diagnostician {
	return &Diagnostician{
		LLM:   llm,
		Model: Model,
		TTL:   24 * time.Hour,
		cache: make(map[string]cacheEntry),
	}
}

// Diagnose serializes Signals to JSON, calls Gemini, parses the JSON
// response into a Diagnosis, and validates it against the rubric's hard
// constraints. On constraint violation it retries once with an explicit
// "you violated constraint X — regenerate" prompt.
func (d *Diagnostician) Diagnose(ctx context.Context, sig Signals, contentFingerprint string) (domain.Diagnosis, error) {
	if d.LLM == nil {
		return domain.Diagnosis{}, ErrLLMNotWired
	}
	key := fingerprint(sig, contentFingerprint)
	d.mu.Lock()
	if e, ok := d.cache[key]; ok && time.Since(e.at) < d.TTL {
		d.mu.Unlock()
		return e.dia, nil
	}
	d.mu.Unlock()

	user, err := json.Marshal(sig)
	if err != nil {
		return domain.Diagnosis{}, fmt.Errorf("marshal signals: %w", err)
	}
	system := SystemPrompt()

	dia, parseErr, validateErr := d.callOnce(ctx, system, string(user))
	if parseErr != nil {
		return domain.Diagnosis{}, parseErr
	}
	if validateErr != nil {
		// One targeted retry with the violation called out explicitly.
		retryUser := string(user) + "\n\nYour previous response violated constraint: " +
			validateErr.Error() + ". Regenerate a fully valid JSON object honouring every constraint."
		dia2, parseErr2, validateErr2 := d.callOnce(ctx, system, retryUser)
		if parseErr2 != nil {
			return domain.Diagnosis{}, parseErr2
		}
		if validateErr2 == nil {
			dia = dia2
		}
		// If retry still violates, return the latest dia anyway — caller can decide.
		// We do not error on validation alone so partial output remains usable.
		if validateErr2 != nil {
			dia = dia2
		}
	}
	if dia.CampaignID == "" {
		dia.CampaignID = sig.CampaignID
	}
	dia.GeneratedAt = time.Now()

	d.mu.Lock()
	d.cache[key] = cacheEntry{at: time.Now(), dia: dia}
	d.mu.Unlock()
	return dia, nil
}

// callOnce performs a single LLM call + parse + validate. Returns the
// parsed Diagnosis (zero on parse error), the parse error, and the
// validation error (which may be non-nil even when the JSON parsed).
func (d *Diagnostician) callOnce(ctx context.Context, system, user string) (domain.Diagnosis, error, error) {
	raw, err := d.LLM.Complete(ctx, system, user, d.Model)
	if err != nil {
		return domain.Diagnosis{}, fmt.Errorf("llm: %w", err), nil
	}
	var dia domain.Diagnosis
	if jerr := json.Unmarshal([]byte(raw), &dia); jerr != nil {
		return domain.Diagnosis{}, fmt.Errorf("parse llm output: %w (raw=%q)", jerr, raw), nil
	}
	verr := ValidateDiagnosis(dia)
	return dia, nil, verr
}

// ValidateDiagnosis enforces the four hard constraints from the rubric:
//
//  1. fix.action ∈ {dns_record, copy_change, image_swap, resend}
//  2. sum of estimated_impact ≤ 0.85
//  3. no single fix's estimated_impact > 0.40
//  4. predicted_impact map values are 0..1
//
// Returns nil when valid, otherwise an error naming the violated constraint.
func ValidateDiagnosis(dia domain.Diagnosis) error {
	allowed := map[domain.FixAction]bool{
		domain.FixActionDNSRecord:  true,
		domain.FixActionCopyChange: true,
		domain.FixActionImageSwap:  true,
		domain.FixActionResend:     true,
	}
	sum := 0.0
	for i, f := range dia.Fixes {
		if !allowed[f.Action] {
			return fmt.Errorf("fix[%d].action=%q is not in {dns_record, copy_change, image_swap, resend}", i, f.Action)
		}
		if f.EstimatedImpact < 0 || f.EstimatedImpact > 0.40 {
			return fmt.Errorf("fix[%d].estimated_impact=%.2f exceeds the 0.40 per-fix cap", i, f.EstimatedImpact)
		}
		sum += f.EstimatedImpact
	}
	if sum > 0.85+1e-9 {
		return fmt.Errorf("sum of estimated_impact=%.2f exceeds the 0.85 cap", sum)
	}
	for k, v := range dia.PredictedImpact {
		if v < 0 || v > 1 {
			return fmt.Errorf("predicted_impact[%q]=%.2f is outside [0,1]", k, v)
		}
	}
	return nil
}

func fingerprint(sig Signals, content string) string {
	h := sha256.New()
	b, _ := json.Marshal(sig)
	h.Write(b)
	h.Write([]byte("|"))
	h.Write([]byte(content))
	return hex.EncodeToString(h.Sum(nil))
}

// --- Real Gemini-backed client (hand-rolled HTTP).

// GeminiClient is the production LLMClient. We removed the official
// anthropic-sdk-go dependency since Gemini's REST surface is small
// enough to maintain in-tree — a single POST against
// generativelanguage.googleapis.com with retry-with-jitter on 429/5xx.
// Returns ErrLLMNotWired when no API key is configured so handlers can
// 503 cleanly.
type GeminiClient struct {
	APIKey     string
	BaseURL    string // optional override; empty == default Google endpoint
	MaxTokens  int
	MaxRetries int
	HTTP       *http.Client
	// Now is overridable for tests. Defaults to time.Now.
	Now func() time.Time
}

// NewGeminiClient reads GEMINI_API_KEY by default. Returns nil when
// the env is unset so callers can substitute a Nop/Mock with a warning.
//
// Backwards compat: also accepts ANTHROPIC_API_KEY with a one-shot
// deprecation warn — gives operators a one-deploy migration window.
func NewGeminiClient() *GeminiClient {
	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		if legacy := os.Getenv("ANTHROPIC_API_KEY"); legacy != "" {
			slog.Warn("diagnostician: ANTHROPIC_API_KEY is deprecated; rename to GEMINI_API_KEY")
			key = legacy
		}
	}
	if key == "" {
		return nil
	}
	return &GeminiClient{APIKey: key, MaxTokens: 4096, MaxRetries: 3}
}

func (c *GeminiClient) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 120 * time.Second}
}

func (c *GeminiClient) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return "https://generativelanguage.googleapis.com"
}

// Complete sends {system, user} to Gemini and returns the raw text.
// Retries on 429/5xx with exponential backoff (1s, 2s, 4s) plus jitter.
//
// The `model` parameter accepts the new Gemini model strings; if the
// caller passes a Claude string (e.g. "claude-sonnet-4-6") we map it
// to the equivalent Gemini model with a one-shot deprecation warning:
//
//	claude-sonnet-4-6 / claude-opus-4-7  -> gemini-3.1-pro-preview
//	claude-haiku-4-5* / claude-haiku-3*  -> gemini-3-flash-preview
func (c *GeminiClient) Complete(ctx context.Context, system, user, model string) (string, error) {
	if c == nil || c.APIKey == "" {
		return "", ErrLLMNotWired
	}
	if c.MaxTokens == 0 {
		c.MaxTokens = 4096
	}
	if c.MaxRetries == 0 {
		c.MaxRetries = 3
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	model = remapModel(model)

	body := map[string]any{
		"contents": []map[string]any{
			{"role": "user", "parts": []map[string]any{{"text": user}}},
		},
		"systemInstruction": map[string]any{
			"parts": []map[string]any{{"text": system}},
		},
		"generationConfig": map[string]any{
			"temperature":     1.0,
			"maxOutputTokens": c.MaxTokens,
		},
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("gemini: marshal request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= c.MaxRetries; attempt++ {
		if attempt > 0 {
			base := time.Duration(1<<(attempt-1)) * time.Second
			// jitter +/- 25%
			jitter := time.Duration(rand.Int63n(int64(base / 2)))
			wait := base/2 + jitter
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(wait):
			}
		}
		text, retryable, err := c.doOnce(ctx, model, buf)
		if err == nil {
			return text, nil
		}
		lastErr = err
		if !retryable {
			return "", fmt.Errorf("%w: %v", ErrLLMNotWired, err)
		}
	}
	return "", fmt.Errorf("%w: retries exhausted: %v", ErrLLMNotWired, lastErr)
}

// doOnce performs a single HTTP call. Returns (text, retryable, error).
// retryable=true only when the caller should retry on the same payload
// (429 / 5xx / transport error).
func (c *GeminiClient) doOnce(ctx context.Context, model string, buf []byte) (string, bool, error) {
	endpoint, err := geminiEndpoint(c.baseURL(), model)
	if err != nil {
		return "", false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	req.Header.Set("content-type", "application/json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", true, fmt.Errorf("gemini: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := readResponseBodyLimited(resp.Body, geminiMaxResponseBodyBytes)

	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode/100 == 5 {
		if readErr != nil {
			return "", true, fmt.Errorf("gemini: status %d: %w", resp.StatusCode, readErr)
		}
		return "", true, fmt.Errorf("gemini: status %d: %s", resp.StatusCode, string(raw))
	}
	if resp.StatusCode/100 != 2 {
		if readErr != nil {
			return "", false, fmt.Errorf("gemini: status %d: %w", resp.StatusCode, readErr)
		}
		return "", false, fmt.Errorf("gemini: status %d: %s", resp.StatusCode, string(raw))
	}
	if readErr != nil {
		return "", false, fmt.Errorf("gemini: %w", readErr)
	}

	var env struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", false, fmt.Errorf("gemini: decode: %w", err)
	}
	if len(env.Candidates) == 0 || len(env.Candidates[0].Content.Parts) == 0 {
		return "", false, errors.New("gemini: empty response")
	}
	var sb strings.Builder
	for _, p := range env.Candidates[0].Content.Parts {
		sb.WriteString(p.Text)
	}
	return stripJSONFence(sb.String()), false, nil
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

func geminiEndpoint(baseRaw, model string) (string, error) {
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
	model = strings.TrimSpace(model)
	if model == "" {
		return "", fmt.Errorf("Gemini model required")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/v1beta/models/" + url.PathEscape(model) + ":generateContent"
	return base.String(), nil
}

// remapModel translates legacy Claude model ids to their Gemini
// equivalents during the migration window. Unknown / already-Gemini
// strings pass through; an empty string falls back to the package
// default.
func remapModel(model string) string {
	switch {
	case model == "":
		return Model
	case strings.HasPrefix(model, "claude-haiku-"):
		slog.Warn("diagnostician: claude-haiku-* deprecated; using gemini-3-flash-preview", "requested", model)
		return ModelFlash
	case strings.HasPrefix(model, "claude-"):
		slog.Warn("diagnostician: claude-* deprecated; using gemini-3.1-pro-preview", "requested", model)
		return Model
	default:
		return model
	}
}

// stripJSONFence removes a leading/trailing ```json fence if Gemini
// emitted one despite the system-prompt instruction. Mirrors the
// helper from services/voice/internal/profile/llm.go — small enough
// to duplicate rather than thread an import.
func stripJSONFence(s string) string {
	s = trimASCIIWS(s)
	if len(s) >= 7 && s[:7] == "```json" {
		s = s[7:]
	} else if len(s) >= 3 && s[:3] == "```" {
		s = s[3:]
	}
	s = trimASCIIWS(s)
	if len(s) >= 3 && s[len(s)-3:] == "```" {
		s = s[:len(s)-3]
	}
	return trimASCIIWS(s)
}

func trimASCIIWS(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\n' || s[0] == '\r' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

// StubLLMClient is a deterministic test double. Given a fingerprint of the
// signals payload it returns one of three canned responses matching the
// starter eval cases.
type StubLLMClient struct{}

// Complete returns a deterministic Diagnosis JSON for the three starter
// eval cases. Falls through to a generic "needs review" response.
func (StubLLMClient) Complete(_ context.Context, _ string, user string, _ string) (string, error) {
	switch {
	case strings.Contains(user, "cmp_eval_01"):
		return `{"campaign_id":"cmp_eval_01","diagnosis":"Strong primary inbox placement across providers; auth posture is clean.","fixes":[],"predicted_impact":{"primary":1.0}}`, nil
	case strings.Contains(user, "cmp_eval_02"):
		return `{"campaign_id":"cmp_eval_02","diagnosis":"SPF record exceeds the 10 DNS-lookup limit, causing permerrors at receivers.","fixes":[{"title":"Flatten SPF record","detail":"Reduce includes below 10 lookups","action":"dns_record","dns_record":{"type":"TXT","name":"@","value":"v=spf1 include:_spf.flat.example.com -all"},"estimated_impact":0.25}],"predicted_impact":{"primary":0.85}}`, nil
	case strings.Contains(user, "cmp_eval_03"):
		return `{"campaign_id":"cmp_eval_03","diagnosis":"Image-heavy promotional content is being routed to Promotions; image-to-text ratio exceeds threshold.","fixes":[{"title":"Add plain-text body content","detail":"Increase visible text to balance image weight","action":"copy_change","estimated_impact":0.20}],"predicted_impact":{"primary":0.55,"promotions":0.40}}`, nil
	default:
		return `{"campaign_id":"unknown","diagnosis":"Insufficient signals; manual review recommended.","fixes":[],"predicted_impact":{}}`, nil
	}
}
