// SPDX-License-Identifier: AGPL-3.0-only
//
// voice_client.go — production VoiceClient that talks to the voice
// service over internal HTTP, mirroring aicompose.HTTPVoiceClient
// (same X-Tenant-ID header convention, same bounded-body decode
// posture). Three calls:
//
//	POST /v1/voice/generate          kind=campaign_draft → CampaignDraft
//	POST /v1/voice/sequences/draft   brief → SequenceDraft
//	POST /v1/voice/sequences         persist manual draft → sequence id
//
// The voice service enforces its own per-tenant AI quotas
// (tenant_ai_usage) on the first two calls, so routine runs share the
// same daily LLM budget as the interactive compose surfaces.
package agent_routines

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

// ErrVoiceUnavailable mirrors aicompose.ErrVoiceUnavailable: the voice
// service refused the request (usually no LLM key configured upstream).
var ErrVoiceUnavailable = errors.New("agent_routines: voice service unavailable")

// ErrStrictPIIGatewayUnavailable means routine generation was blocked before
// model egress because the tenant-scoped privacy sanitizer was unavailable.
var ErrStrictPIIGatewayUnavailable = errors.New("agent_routines: strict PII gateway unavailable")

// ErrVoiceAuthenticationUnavailable blocks an internal request when the
// shared bearer credential is absent. Production startup requires this
// secret, but the transport also enforces the invariant so a future wiring
// regression cannot silently downgrade to an unauthenticated call.
var ErrVoiceAuthenticationUnavailable = errors.New("agent_routines: internal voice authentication unavailable")

// ErrVoiceInvalidResponse is intentionally detail-free. A malformed or
// over-limit sidecar response must not copy provider/model output into the run
// receipt or application logs.
var ErrVoiceInvalidResponse = errors.New("agent_routines: voice service returned an invalid response")

const (
	voiceResponseMaxBytes       int64 = 256 << 10 // 256 KiB, matches aicompose
	voiceRestoredDraftMaxBytes        = 512 << 10
	voicePIITokenMaxOccurrences       = 64
	voiceNameMaxRunes                 = 200
	voiceSubjectMaxRunes              = 255
	voicePreviewMaxRunes              = 500
	voiceRationaleMaxRunes            = 8_000
	voiceBodyMaxRunes                 = 200_000
	voiceSequenceMaxSteps             = 10
	voiceSequenceMaxDelayHours        = 365 * 24
	voiceSequenceIDMaxRunes           = 128
)

// HTTPVoiceClient is the production VoiceClient. BaseURL must NOT
// include the /v1/voice prefix — the client appends it.
type HTTPVoiceClient struct {
	BaseURL          string
	InternalAPIToken string
	PIIFactory       StrictTextSanitizerFactory
	HTTP             *http.Client
}

// StrictTextSanitizerFactory constructs a sanitizer from the exact routine
// prompt/context that would otherwise leave the API process.
type StrictTextSanitizerFactory interface {
	SanitizerForText(
		ctx context.Context,
		tenantID, salt, prompt, contextText string,
	) (pii_gateway.Sanitizer, error)
}

type StrictTextSanitizerFactoryFunc func(
	ctx context.Context,
	tenantID, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error)

func (f StrictTextSanitizerFactoryFunc) SanitizerForText(
	ctx context.Context,
	tenantID, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error) {
	if f == nil {
		return nil, ErrStrictPIIGatewayUnavailable
	}
	return f(ctx, tenantID, salt, prompt, contextText)
}

// NewHTTPVoiceClient constructs an authenticated client with a 90s timeout
// (LLM drafting runs are long; matches aicompose).
func NewHTTPVoiceClient(
	baseURL,
	internalAPIToken string,
	piiFactory StrictTextSanitizerFactory,
) *HTTPVoiceClient {
	return &HTTPVoiceClient{
		BaseURL:          strings.TrimRight(baseURL, "/"),
		InternalAPIToken: strings.TrimSpace(internalAPIToken),
		PIIFactory:       piiFactory,
		HTTP: &http.Client{
			Timeout: 90 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// GenerateCampaignDraft implements VoiceClient via POST /v1/voice/generate.
func (c *HTTPVoiceClient) GenerateCampaignDraft(ctx context.Context, tenantID, prompt, contextText string) (CampaignDraft, error) {
	sanitizer, sanitizedPrompt, sanitizedContext, err := c.sanitizeModelText(
		ctx,
		tenantID,
		prompt,
		contextText,
	)
	if err != nil {
		return CampaignDraft{}, err
	}
	body := map[string]any{
		"prompt": sanitizedPrompt,
		"kind":   "campaign_draft",
	}
	if sanitizedContext != "" {
		body["context_text"] = sanitizedContext
	}
	var out struct {
		Text  string         `json:"text"`
		Draft *CampaignDraft `json:"draft,omitempty"`
	}
	if err := c.post(ctx, tenantID, "/v1/voice/generate", body, &out); err != nil {
		return CampaignDraft{}, err
	}
	if out.Draft == nil {
		// Voice service answered but without structured JSON — synthesize
		// a minimal draft from the text (aicompose does the same).
		if piiTokenOccurrences(out.Text) > voicePIITokenMaxOccurrences {
			return CampaignDraft{}, ErrVoiceInvalidResponse
		}
		text := strings.TrimSpace(sanitizer.Restore(out.Text))
		if text == "" {
			return CampaignDraft{}, ErrVoiceInvalidResponse
		}
		draft := CampaignDraft{Subject: firstLine(text), Body: text}
		if err := normalizeAndValidateCampaignDraft(&draft); err != nil {
			return CampaignDraft{}, err
		}
		return draft, nil
	}
	draft := *out.Draft
	if campaignPIITokenOccurrences(draft) > voicePIITokenMaxOccurrences {
		return CampaignDraft{}, ErrVoiceInvalidResponse
	}
	draft.Name = sanitizer.Restore(draft.Name)
	draft.Subject = sanitizer.Restore(draft.Subject)
	draft.Body = sanitizer.Restore(draft.Body)
	draft.PreviewText = sanitizer.Restore(draft.PreviewText)
	draft.Rationale = sanitizer.Restore(draft.Rationale)
	if err := normalizeAndValidateCampaignDraft(&draft); err != nil {
		return CampaignDraft{}, err
	}
	return draft, nil
}

// DraftSequence implements VoiceClient via POST /v1/voice/sequences/draft.
func (c *HTTPVoiceClient) DraftSequence(ctx context.Context, tenantID, brief string) (SequenceDraft, error) {
	sanitizer, sanitizedBrief, _, err := c.sanitizeModelText(
		ctx,
		tenantID,
		brief,
		"",
	)
	if err != nil {
		return SequenceDraft{}, err
	}
	var out SequenceDraft
	if err := c.post(ctx, tenantID, "/v1/voice/sequences/draft", map[string]any{"brief": sanitizedBrief}, &out); err != nil {
		return SequenceDraft{}, err
	}
	if sequencePIITokenOccurrences(out) > voicePIITokenMaxOccurrences {
		return SequenceDraft{}, ErrVoiceInvalidResponse
	}
	out.Name = sanitizer.Restore(out.Name)
	out.Rationale = sanitizer.Restore(out.Rationale)
	for index := range out.Steps {
		out.Steps[index].Subject = sanitizer.Restore(out.Steps[index].Subject)
		out.Steps[index].Body = sanitizer.Restore(out.Steps[index].Body)
	}
	if err := normalizeAndValidateSequenceDraft(&out); err != nil {
		return SequenceDraft{}, err
	}
	return out, nil
}

func (c *HTTPVoiceClient) sanitizeModelText(
	ctx context.Context,
	tenantID,
	prompt,
	contextText string,
) (pii_gateway.Sanitizer, string, string, error) {
	if c == nil || c.PIIFactory == nil || strings.TrimSpace(tenantID) == "" ||
		!utf8.ValidString(prompt) || !utf8.ValidString(contextText) ||
		len(prompt)+len(contextText) > pii_gateway.StrictTextMaxBytes {
		return nil, "", "", ErrStrictPIIGatewayUnavailable
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, "", "", ErrStrictPIIGatewayUnavailable
	}
	sanitizer, err := c.PIIFactory.SanitizerForText(
		ctx,
		tenantID,
		hex.EncodeToString(random[:]),
		prompt,
		contextText,
	)
	if err != nil || sanitizer == nil {
		return nil, "", "", ErrStrictPIIGatewayUnavailable
	}
	return sanitizer, sanitizer.Sanitize(prompt), sanitizer.Sanitize(contextText), nil
}

// CreateDraftSequence implements VoiceClient via POST /v1/voice/sequences
// (the no-template manual-draft path: persists status='draft' without
// spending AI quota).
func (c *HTTPVoiceClient) CreateDraftSequence(ctx context.Context, tenantID string, draft SequenceDraft) (string, error) {
	if err := normalizeAndValidateSequenceDraft(&draft); err != nil {
		return "", err
	}
	steps := make([]map[string]any, 0, len(draft.Steps))
	for i, s := range draft.Steps {
		pos := s.Position
		if pos < 1 {
			pos = i + 1
		}
		steps = append(steps, map[string]any{
			"type":     "email",
			"position": pos,
			"email": map[string]any{
				"subject":       s.Subject,
				"body":          s.Body,
				"delay_seconds": s.DelayHours * 3600,
			},
		})
	}
	body := map[string]any{
		"name":   draft.Name,
		"status": "draft",
		"steps":  steps,
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := c.post(ctx, tenantID, "/v1/voice/sequences", body, &out); err != nil {
		return "", err
	}
	out.ID = strings.TrimSpace(out.ID)
	if err := validateSingleLine(out.ID, voiceSequenceIDMaxRunes, true); err != nil {
		return "", ErrVoiceInvalidResponse
	}
	if _, err := uuid.Parse(out.ID); err != nil {
		return "", ErrVoiceInvalidResponse
	}
	return out.ID, nil
}

// post is the shared bounded JSON round-trip.
func (c *HTTPVoiceClient) post(ctx context.Context, tenantID, path string, body any, out any) error {
	if c == nil || c.BaseURL == "" {
		return ErrVoiceUnavailable
	}
	token := strings.TrimSpace(c.InternalAPIToken)
	if token == "" || strings.IndexFunc(token, unicode.IsSpace) >= 0 ||
		strings.IndexFunc(token, unicode.IsControl) >= 0 {
		return ErrVoiceAuthenticationUnavailable
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return errors.New("agent_routines: voice request could not be encoded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(buf))
	if err != nil {
		return ErrVoiceUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Tenant-ID", tenantID)
	req.Header.Set("Authorization", "Bearer "+token)

	httpC := c.HTTP
	if httpC == nil {
		httpC = http.DefaultClient
	}
	// Copy instead of mutating the injected/shared client. This makes the
	// credential boundary unconditional even when tests or future production
	// composition supply a client whose CheckRedirect is nil.
	noRedirectClient := *httpC
	if noRedirectClient.Timeout <= 0 || noRedirectClient.Timeout > 90*time.Second {
		noRedirectClient.Timeout = 90 * time.Second
	}
	noRedirectClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := noRedirectClient.Do(req)
	if err != nil {
		return fmt.Errorf("%w: request failed", ErrVoiceUnavailable)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusServiceUnavailable {
		return ErrVoiceUnavailable
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("%w: HTTP %d", ErrVoiceUnavailable, resp.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, voiceResponseMaxBytes+1))
	if err != nil || int64(len(payload)) > voiceResponseMaxBytes || len(payload) == 0 || !utf8.Valid(payload) {
		return ErrVoiceInvalidResponse
	}
	// json.Unmarshal rejects trailing non-whitespace and a second JSON value;
	// Decoder.Decode alone would silently accept both.
	if err := json.Unmarshal(payload, out); err != nil {
		return ErrVoiceInvalidResponse
	}
	return nil
}

func normalizeAndValidateCampaignDraft(draft *CampaignDraft) error {
	if draft == nil {
		return ErrVoiceInvalidResponse
	}
	draft.Name = strings.TrimSpace(draft.Name)
	draft.Subject = strings.TrimSpace(draft.Subject)
	draft.PreviewText = strings.TrimSpace(draft.PreviewText)
	draft.Rationale = strings.TrimSpace(draft.Rationale)
	if err := validateSingleLine(draft.Name, voiceNameMaxRunes, false); err != nil {
		return ErrVoiceInvalidResponse
	}
	if err := validateSingleLine(draft.Subject, voiceSubjectMaxRunes, false); err != nil {
		return ErrVoiceInvalidResponse
	}
	if err := validateSingleLine(draft.PreviewText, voicePreviewMaxRunes, false); err != nil {
		return ErrVoiceInvalidResponse
	}
	if err := validateText(draft.Rationale, voiceRationaleMaxRunes, false); err != nil {
		return ErrVoiceInvalidResponse
	}
	if err := validateText(draft.Body, voiceBodyMaxRunes, true); err != nil {
		return ErrVoiceInvalidResponse
	}
	if campaignDraftBytes(*draft) > voiceRestoredDraftMaxBytes {
		return ErrVoiceInvalidResponse
	}
	return nil
}

func normalizeAndValidateSequenceDraft(draft *SequenceDraft) error {
	if draft == nil || len(draft.Steps) == 0 || len(draft.Steps) > voiceSequenceMaxSteps {
		return ErrVoiceInvalidResponse
	}
	draft.Name = strings.TrimSpace(draft.Name)
	draft.Rationale = strings.TrimSpace(draft.Rationale)
	if err := validateSingleLine(draft.Name, voiceNameMaxRunes, false); err != nil {
		return ErrVoiceInvalidResponse
	}
	if err := validateText(draft.Rationale, voiceRationaleMaxRunes, false); err != nil {
		return ErrVoiceInvalidResponse
	}
	for index := range draft.Steps {
		step := &draft.Steps[index]
		step.Subject = strings.TrimSpace(step.Subject)
		step.Body = strings.TrimSpace(step.Body)
		if step.Position != index+1 || step.DelayHours < 0 || step.DelayHours > voiceSequenceMaxDelayHours {
			return ErrVoiceInvalidResponse
		}
		if index == 0 && step.DelayHours != 0 {
			return ErrVoiceInvalidResponse
		}
		if err := validateSingleLine(step.Subject, voiceSubjectMaxRunes, true); err != nil {
			return ErrVoiceInvalidResponse
		}
		if err := validateText(step.Body, voiceBodyMaxRunes, true); err != nil {
			return ErrVoiceInvalidResponse
		}
	}
	if sequenceDraftBytes(*draft) > voiceRestoredDraftMaxBytes {
		return ErrVoiceInvalidResponse
	}
	return nil
}

func validateSingleLine(value string, maxRunes int, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return ErrVoiceInvalidResponse
	}
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return ErrVoiceInvalidResponse
	}
	for _, r := range value {
		if r == '\r' || r == '\n' || r == 0 || unicode.IsControl(r) {
			return ErrVoiceInvalidResponse
		}
	}
	return nil
}

func validateText(value string, maxRunes int, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return ErrVoiceInvalidResponse
	}
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return ErrVoiceInvalidResponse
	}
	for _, r := range value {
		if r == 0 || (unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t') {
			return ErrVoiceInvalidResponse
		}
	}
	return nil
}

func campaignDraftBytes(draft CampaignDraft) int {
	return len(draft.Name) + len(draft.Subject) + len(draft.Body) +
		len(draft.PreviewText) + len(draft.Rationale)
}

func sequenceDraftBytes(draft SequenceDraft) int {
	total := len(draft.Name) + len(draft.Rationale)
	for _, step := range draft.Steps {
		total += len(step.Subject) + len(step.Body)
	}
	return total
}

func piiTokenOccurrences(value string) int {
	return strings.Count(value, "[[PII:")
}

func campaignPIITokenOccurrences(draft CampaignDraft) int {
	return piiTokenOccurrences(draft.Name) + piiTokenOccurrences(draft.Subject) +
		piiTokenOccurrences(draft.Body) + piiTokenOccurrences(draft.PreviewText) +
		piiTokenOccurrences(draft.Rationale)
}

func sequencePIITokenOccurrences(draft SequenceDraft) int {
	total := piiTokenOccurrences(draft.Name) + piiTokenOccurrences(draft.Rationale)
	for _, step := range draft.Steps {
		total += piiTokenOccurrences(step.Subject) + piiTokenOccurrences(step.Body)
	}
	return total
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
