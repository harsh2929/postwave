// Package aicompose orchestrates the AI broadcast composer endpoints
// (POST /api/v1/ai/compose/*).
//
// Why this lives in apps/api rather than as a thin reverse proxy to the
// voice service: the user-facing affordance is "brief → A/B-ready
// broadcast", which is a fan-out of N voice-service calls (one for the
// primary draft + one per subject variant + one per hook variant) that
// then need to be merged into a single structured response. A reverse
// proxy can't compose responses; doing the fan-out here keeps the
// desktop/web clients out of the orchestration business and gives us a
// single place to enforce quotas, rate-limits, and brand-voice attachment.
//
// The voice service handles the actual LLM call; this package only
// fans out, joins, and shapes the result. If GEMINI_API_KEY is missing
// downstream, the voice service returns 503 and we propagate the gap.
package aicompose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Errors surfaced by the orchestrator. Handlers map these onto HTTP codes.
var (
	// ErrVoiceUnavailable is returned when the voice service refuses the
	// request (most commonly because GEMINI_API_KEY is unset upstream).
	ErrVoiceUnavailable = errors.New("aicompose: voice service unavailable")
	// ErrBadRequest is returned for client-side input issues that the
	// caller should fix (empty brief, etc.).
	ErrBadRequest = errors.New("aicompose: bad request")
)

// VoiceClient is the narrow surface the composer uses against the voice
// service. The default implementation is a small HTTP client; tests pass
// a fake.
type VoiceClient interface {
	// Generate calls POST /v1/voice/generate on the voice service with the
	// given tenant + chat kind + prompt and returns the parsed response.
	Generate(ctx context.Context, tenantID string, kind ChatKind, prompt string, contextText string) (GenerateResult, error)
}

// ChatKind mirrors the voice service's ChatKind enum. We re-declare it
// here so apps/api doesn't import the voice service package — keep the
// two in sync.
type ChatKind string

const (
	KindCampaignDraft ChatKind = "campaign_draft"
	KindSubjectLine   ChatKind = "subject_line"
	KindFreeForm      ChatKind = "free_form"
	KindReplyIntent   ChatKind = "reply_intent"
)

// GenerateResult is the deserialized voice-service response. The voice
// service returns Text always; Draft is populated only for the
// campaign_draft kind.
type GenerateResult struct {
	Text  string         `json:"text"`
	Draft *CampaignDraft `json:"draft,omitempty"`
}

// CampaignDraft mirrors the voice service's campaignDraft.
type CampaignDraft struct {
	Name        string `json:"name"`
	Subject     string `json:"subject"`
	Body        string `json:"body"`
	PreviewText string `json:"preview_text,omitempty"`
}

// HTTPVoiceClient is the production VoiceClient that talks to the voice
// service over HTTP. The BaseURL must NOT include the /v1/voice prefix —
// the client appends it.
type HTTPVoiceClient struct {
	BaseURL          string
	InternalAPIToken string
	HTTP             *http.Client
}

// NewHTTPVoiceClient constructs an authenticated client with a 90s timeout.
// internalAPIToken is forwarded only to the configured Voice service as a
// Bearer credential; production startup already requires this shared secret.
func NewHTTPVoiceClient(baseURL, internalAPIToken string) *HTTPVoiceClient {
	return &HTTPVoiceClient{
		BaseURL:          strings.TrimRight(baseURL, "/"),
		InternalAPIToken: strings.TrimSpace(internalAPIToken),
		HTTP: &http.Client{
			Timeout: 90 * time.Second,
			// Never follow service redirects with an internal bearer credential.
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Generate posts to /v1/voice/generate and returns the parsed body.
func (c *HTTPVoiceClient) Generate(ctx context.Context, tenantID string, kind ChatKind, prompt, contextText string) (GenerateResult, error) {
	if c == nil || c.BaseURL == "" {
		return GenerateResult{}, ErrVoiceUnavailable
	}
	body := map[string]any{
		"prompt": prompt,
		"kind":   string(kind),
	}
	if contextText != "" {
		body["context_text"] = contextText
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return GenerateResult{}, fmt.Errorf("marshal voice request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/voice/generate", bytes.NewReader(buf))
	if err != nil {
		return GenerateResult{}, fmt.Errorf("build voice request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Tenant-ID", tenantID)
	if c.InternalAPIToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.InternalAPIToken)
	}

	httpC := c.HTTP
	if httpC == nil {
		httpC = http.DefaultClient
	}
	resp, err := httpC.Do(req)
	if err != nil {
		return GenerateResult{}, voiceTransportFailure(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusServiceUnavailable {
		return GenerateResult{}, ErrVoiceUnavailable
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return GenerateResult{}, fmt.Errorf("voice service refused tenant: %d", resp.StatusCode)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		// Do not reflect internal/provider response bodies into upstream logs or
		// routine receipts; status is sufficient for diagnosis and retry policy.
		return GenerateResult{}, fmt.Errorf("voice service returned HTTP %d", resp.StatusCode)
	}

	// Cap the body to a generous-but-bounded ceiling. The voice service
	// emits structured JSON for the chat kinds, so 256KB is plenty even
	// for long-body drafts.
	var out GenerateResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&out); err != nil {
		return GenerateResult{}, fmt.Errorf("decode voice response: %w", err)
	}
	return out, nil
}

// ComposeBroadcastInput is the request body for POST /api/v1/ai/compose/broadcast.
type ComposeBroadcastInput struct {
	// Brief is the user's 1-line prompt ("announce our pricing change",
	// "send a black-friday teaser to power users", etc.). Required.
	Brief string `json:"brief"`
	// VariantCount is the number of *alternate* subject-line variants to
	// generate alongside the primary draft. Default 2 (so client gets
	// primary subject + 2 alternates = 3 total options, matching the
	// A/B test page in the desktop UI). Bounded to [0,4] to cap LLM cost.
	VariantCount int `json:"variant_count,omitempty"`
	// Tone is an optional override ("witty", "formal", "urgent") that
	// overrides the inferred brand voice if the tenant has one. When
	// empty, the brand voice profile (if any) is used by the voice
	// service itself.
	Tone string `json:"tone,omitempty"`
	// Audience is optional free-form context about who's receiving the
	// broadcast ("paid annual subscribers", "trial users on day 7", ...).
	// Surfaced to the LLM as part of the system context.
	Audience string `json:"audience,omitempty"`
	// ProfileID optionally binds this compose call to a specific authored
	// brand-voice profile (G10). When empty the composer uses the
	// tenant's active profile. Recorded in context so the binding is
	// explicit and auditable across compose surfaces.
	ProfileID string `json:"profile_id,omitempty"`
}

// ComposeBroadcastOutput is the response from POST /api/v1/ai/compose/broadcast.
type ComposeBroadcastOutput struct {
	// Primary is the fully-formed campaign draft (subject + body +
	// preview text + suggested name). The desktop can drop these
	// fields directly into the New Campaign modal.
	Primary CampaignDraft `json:"primary"`
	// SubjectVariants are alternate subjects ready for A/B testing. The
	// first entry is the primary's subject (so callers can use the
	// whole slice as the A/B variant list when they hit
	// /api/v1/campaigns/ab-test).
	SubjectVariants []string `json:"subject_variants"`
	// GeneratedAt records when the composition completed. Useful for
	// caching tells on the client side.
	GeneratedAt time.Time `json:"generated_at"`
}

// ComposeVariantsInput requests N additional subject variants for an
// already-drafted broadcast.
type ComposeVariantsInput struct {
	// Subject is the existing primary subject — used as anchor so the
	// variants stay relevant.
	Subject string `json:"subject"`
	// Body is the existing body (HTML or plain) — used as semantic
	// context so the variants reflect the actual content.
	Body string `json:"body"`
	// VariantCount is the number of alternates to generate. Default 3,
	// capped at [1,5].
	VariantCount int `json:"variant_count,omitempty"`
	// ProfileID optionally binds variant generation to a specific
	// authored brand-voice profile (G10). Subject Lab threads its
	// voice_profile_id through here. Empty = tenant active profile.
	ProfileID string `json:"profile_id,omitempty"`
}

// ComposeVariantsOutput is the response from POST /api/v1/ai/compose/variants.
type ComposeVariantsOutput struct {
	SubjectVariants []string  `json:"subject_variants"`
	GeneratedAt     time.Time `json:"generated_at"`
}

// BrandVoiceProfile is the authored tenant voice profile shape the
// composer needs. Kept local to this package so callers can adapt the
// storage package without creating an import cycle.
type BrandVoiceProfile struct {
	ID             string
	Descriptors    []string
	WritingRules   []string
	SampleSnippets []string
}

// BrandVoiceLoader returns the active authored brand voice profile for
// a tenant. nil profile means "no authored profile; use regular corpus".
type BrandVoiceLoader interface {
	LoadBrandVoice(ctx context.Context, tenantID string) (*BrandVoiceProfile, error)
}

// BrandVoiceLoaderFunc adapts a function into BrandVoiceLoader.
type BrandVoiceLoaderFunc func(ctx context.Context, tenantID string) (*BrandVoiceProfile, error)

func (f BrandVoiceLoaderFunc) LoadBrandVoice(ctx context.Context, tenantID string) (*BrandVoiceProfile, error) {
	return f(ctx, tenantID)
}

// Composer orchestrates voice-service fan-out. Stateless; safe to share.
type Composer struct {
	Voice VoiceClient
	// BrandVoice, when configured, injects the tenant's authored brand
	// voice into context_text for compose surfaces. A tone override
	// intentionally suppresses the profile so explicit operator intent
	// wins for that request.
	BrandVoice BrandVoiceLoader
	// MaxVariants caps the general Compose API surface. Defaults to 4 if
	// zero, matching the A/B test split limit. Specialized, server-owned
	// surfaces may request a larger bounded fan-out through
	// ComposeVariantsUpTo; the package-wide hard ceiling remains 8.
	MaxVariants int
}

const absoluteMaxVariants = 8

// New constructs a Composer. Pass a nil VoiceClient to disable the
// composer entirely (handlers will return 503).
func New(v VoiceClient) *Composer {
	return &Composer{Voice: v, MaxVariants: 4}
}

// ComposeBroadcast runs the full fan-out: primary draft + N subject variants
// in parallel. The primary draft fans out first; subject variants reuse the
// brief + the primary's subject as anchor context. All variant calls run
// concurrently and are joined; partial failures degrade gracefully (we
// still return the primary even if a variant call errors).
func (c *Composer) ComposeBroadcast(ctx context.Context, tenantID string, in ComposeBroadcastInput) (ComposeBroadcastOutput, error) {
	if c == nil || c.Voice == nil {
		return ComposeBroadcastOutput{}, ErrVoiceUnavailable
	}
	in.Brief = strings.TrimSpace(in.Brief)
	if in.Brief == "" {
		return ComposeBroadcastOutput{}, fmt.Errorf("%w: brief is required", ErrBadRequest)
	}
	variantCount := clamp(in.VariantCount, 0, c.maxVariants())

	contextText := c.ContextText(ctx, tenantID, in.Tone, in.Audience, profileBindingExtra(in.ProfileID))

	// Primary draft first; the subject variants need the primary's
	// subject to stay anchored.
	primary, err := c.Voice.Generate(ctx, tenantID, KindCampaignDraft, in.Brief, contextText)
	if err != nil {
		return ComposeBroadcastOutput{}, err
	}
	if primary.Draft == nil {
		// Voice service was happy but didn't return structured JSON (the
		// LLM produced free-form text). Synthesize a minimal draft from
		// the text response so the caller still gets *something*.
		primary.Draft = &CampaignDraft{
			Subject: firstLine(primary.Text),
			Body:    primary.Text,
		}
	}

	subjects := []string{primary.Draft.Subject}
	if variantCount > 0 {
		variants := c.generateSubjectVariants(ctx, tenantID, in.Brief, primary.Draft.Subject, primary.Draft.Body, variantCount, contextText)
		subjects = append(subjects, variants...)
	}

	return ComposeBroadcastOutput{
		Primary:         *primary.Draft,
		SubjectVariants: dedupeNonEmpty(subjects),
		GeneratedAt:     time.Now().UTC(),
	}, nil
}

// ComposeVariants generates additional subject variants for an existing
// draft. Used by the desktop "Generate more variants" affordance.
func (c *Composer) ComposeVariants(ctx context.Context, tenantID string, in ComposeVariantsInput) (ComposeVariantsOutput, error) {
	return c.composeVariants(ctx, tenantID, in, c.maxVariants())
}

// ComposeVariantsUpTo is the explicit boundary for server-owned authoring
// surfaces whose reviewed contract differs from the general four-way A/B
// composer. The requested ceiling is itself hard-clamped to eight so a caller
// cannot turn one request into unbounded model fan-out.
func (c *Composer) ComposeVariantsUpTo(ctx context.Context, tenantID string, in ComposeVariantsInput, maximum int) (ComposeVariantsOutput, error) {
	return c.composeVariants(ctx, tenantID, in, clamp(maximum, 1, absoluteMaxVariants))
}

func (c *Composer) composeVariants(ctx context.Context, tenantID string, in ComposeVariantsInput, maximum int) (ComposeVariantsOutput, error) {
	if c == nil || c.Voice == nil {
		return ComposeVariantsOutput{}, ErrVoiceUnavailable
	}
	in.Subject = strings.TrimSpace(in.Subject)
	if in.Subject == "" {
		return ComposeVariantsOutput{}, fmt.Errorf("%w: subject is required", ErrBadRequest)
	}
	count := clamp(in.VariantCount, 1, maximum)
	if in.VariantCount == 0 {
		count = 3
	}

	// Use the existing subject as the brief anchor; pass body in the
	// context_text so the LLM stays semantically relevant.
	contextText := c.ContextText(ctx, tenantID, "", "", "Existing subject: "+in.Subject, profileBindingExtra(in.ProfileID))
	if in.Body != "" {
		contextText += "\n\nBody excerpt:\n" + trimToBytes(in.Body, 4096)
	}

	variants := c.generateSubjectVariants(ctx, tenantID, in.Subject, in.Subject, in.Body, count, contextText)
	return ComposeVariantsOutput{
		SubjectVariants: dedupeNonEmpty(variants),
		GeneratedAt:     time.Now().UTC(),
	}, nil
}

// generateSubjectVariants fans out N concurrent subject_line calls. Each
// call hints the LLM with the variant index so the prompts diversify
// (the voice service's subject_line prompt asks for one variant per call).
// Failures are swallowed silently and produce an empty slot; we filter
// empties before returning so partial fan-out still produces useful output.
func (c *Composer) generateSubjectVariants(ctx context.Context, tenantID, brief, anchorSubject, body string, count int, contextText string) []string {
	if count <= 0 {
		return nil
	}
	out := make([]string, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			variantPrompt := fmt.Sprintf(
				"Write one alternative subject line for this campaign. Variant %d of %d. "+
					"Avoid duplicating: %q. The new subject must be different in opening word, "+
					"length, or angle from the anchor. Brief: %s",
				i+1, count, anchorSubject, brief,
			)
			res, err := c.Voice.Generate(ctx, tenantID, KindSubjectLine, variantPrompt, contextText)
			if err != nil {
				return
			}
			text := strings.TrimSpace(res.Text)
			if text == "" {
				return
			}
			// Some prompts return the subject wrapped in quotes; strip them.
			text = strings.Trim(text, `"' `)
			// If the LLM returned multiple lines, take the first non-empty one.
			text = firstLine(text)
			// G10 merge-tag guardrail: if the anchor subject was
			// personalized (e.g. "Hi {{first_name}}, …") and this variant
			// dropped the token, the variant would send "Hi , …" — reject
			// it rather than ship broken personalization. The slot stays
			// empty and is filtered out with the other misses.
			if !PreservesMergeTags(anchorSubject, text) {
				return
			}
			out[i] = text
		}()
	}
	wg.Wait()
	return out
}

func (c *Composer) maxVariants() int {
	if c.MaxVariants <= 0 {
		return 4
	}
	return clamp(c.MaxVariants, 1, absoluteMaxVariants)
}

// ContextText builds the voice-service context_text block shared by
// AI compose, Subject Lab, and subject-line assistant surfaces.
func (c *Composer) ContextText(ctx context.Context, tenantID, tone, audience string, extras ...string) string {
	parts := []string{}
	if profile := c.loadBrandVoice(ctx, tenantID, tone); profile != "" {
		parts = append(parts, profile)
	}
	base := buildContext(tone, audience)
	if base != "" {
		parts = append(parts, base)
	}
	for _, extra := range extras {
		extra = strings.TrimSpace(extra)
		if extra != "" {
			parts = append(parts, extra)
		}
	}
	return strings.Join(parts, "\n")
}

// profileBindingExtra returns a context line recording an explicit
// brand-voice profile binding (G10) so the chosen profile is auditable
// in the generated context_text. Empty id => no line.
func profileBindingExtra(profileID string) string {
	id := strings.TrimSpace(profileID)
	if id == "" {
		return ""
	}
	return "Bound brand voice profile: " + id
}

func (c *Composer) loadBrandVoice(ctx context.Context, tenantID, tone string) string {
	if c == nil || c.BrandVoice == nil || strings.TrimSpace(tone) != "" {
		return ""
	}
	p, err := c.BrandVoice.LoadBrandVoice(ctx, tenantID)
	if err != nil || p == nil {
		return ""
	}
	parts := []string{}
	if p.ID != "" {
		parts = append(parts, "Brand voice profile: "+p.ID)
	}
	if len(p.Descriptors) > 0 {
		parts = append(parts, "Brand voice descriptors: "+strings.Join(p.Descriptors, ", "))
	}
	if len(p.WritingRules) > 0 {
		parts = append(parts, "Brand voice writing rules:\n- "+strings.Join(p.WritingRules, "\n- "))
	}
	if len(p.SampleSnippets) > 0 {
		snips := make([]string, 0, len(p.SampleSnippets))
		for _, s := range p.SampleSnippets {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			snips = append(snips, trimToBytes(s, 1200))
		}
		if len(snips) > 0 {
			parts = append(parts, "Brand voice sample snippets:\n"+strings.Join(snips, "\n---\n"))
		}
	}
	return strings.Join(parts, "\n")
}

func buildContext(tone, audience string) string {
	parts := []string{}
	if tone != "" {
		parts = append(parts, "Tone override: "+tone)
	}
	if audience != "" {
		parts = append(parts, "Audience: "+audience)
	}
	return strings.Join(parts, "\n")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func dedupeNonEmpty(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		key := strings.ToLower(s)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, s)
	}
	return out
}

func trimToBytes(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	return s[:maxBytes]
}
