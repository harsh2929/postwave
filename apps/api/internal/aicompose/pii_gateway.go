// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-072 — production wiring of the PII gateway / privacy firewall into the AI
// composer path.
//
// The pii_gateway package defines the tokenize/detokenize engine and the generic
// WrapVoiceClient middleware, but until now it was only ever exercised in tests:
// production AI calls (the broadcast composer, Subject Lab, subject-line
// assistant — all of which fan out through aicompose.VoiceClient) did NOT route
// through it, so a prompt that interpolated a tenant's PII shipped that PII
// straight to the model.
//
// GatewayVoiceClient closes that gap. It is a VoiceClient decorator: for every
// Generate call it builds a per-request, tenant-scoped sanitizer (from the
// tenant's pii_tokenization_config — migrations 0560/0561) and runs the model
// call through pii_gateway.WrapVoiceClient, so any configured sensitive value
// present in the prompt or context is tokenized before the model sees it and the
// tokens are restored in the response. It is fail-safe: a nil factory or a tenant
// with nothing marked sensitive is a transparent pass-through, so wiring it can
// never break a model call that has no PII to protect.

package aicompose

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

// ErrStrictPIIGatewayUnavailable means a model call was blocked because the
// fail-closed text sanitizer could not be constructed. Callers must return a
// generic availability error and must never retry through an unwrapped client.
var ErrStrictPIIGatewayUnavailable = errors.New("aicompose: strict PII gateway unavailable")

// SanitizerFactory builds a request-scoped pii_gateway.Sanitizer for a tenant.
// Kept as a narrow interface (rather than a concrete *pii_gateway.Repo) so the
// decorator stays testable with a fake and so the wiring site in main.go owns
// the policy of how a tenant's sensitive value set is resolved. A nil Sanitizer
// return is valid and means "nothing to tokenize" — WrapVoiceClient treats it as
// a pass-through.
type SanitizerFactory interface {
	// SanitizerForTenant returns a sanitizer scoped to tenantID. salt should be
	// a per-request identifier so tokens never collide across requests. An error
	// is best-effort advisory: the returned sanitizer (even on error) is still
	// safe to use — the gateway is fail-safe and falls back to tokenizing only
	// the built-in identifiers.
	SanitizerForTenant(ctx context.Context, tenantID, salt string) (pii_gateway.Sanitizer, error)
}

// SanitizerFactoryFunc adapts a function into a SanitizerFactory.
type SanitizerFactoryFunc func(ctx context.Context, tenantID, salt string) (pii_gateway.Sanitizer, error)

func (f SanitizerFactoryFunc) SanitizerForTenant(ctx context.Context, tenantID, salt string) (pii_gateway.Sanitizer, error) {
	return f(ctx, tenantID, salt)
}

// GatewayVoiceClient decorates an inner VoiceClient so every model call is
// routed through the PII gateway. Construct via NewGatewayVoiceClient.
type GatewayVoiceClient struct {
	inner   VoiceClient
	factory SanitizerFactory
}

// NewGatewayVoiceClient wraps inner so its Generate calls tokenize PII via the
// supplied factory. A nil inner returns nil (nothing to wrap); a nil factory
// returns the inner unchanged (no gateway available → original behaviour), so
// this is always safe to call at the wiring site.
func NewGatewayVoiceClient(inner VoiceClient, factory SanitizerFactory) VoiceClient {
	if inner == nil {
		return nil
	}
	if factory == nil {
		return inner
	}
	return &GatewayVoiceClient{inner: inner, factory: factory}
}

// Generate tokenizes the prompt + context through a tenant-scoped sanitizer,
// delegates to the inner client, and detokenizes the response. The context_text
// is sanitized with the SAME sanitizer as the prompt so a value that appears
// only in the context (e.g. an audience description carrying an email) is
// tokenized too, and the response's structured Draft fields are restored
// alongside the free-text Text.
//
// The captured draft below is a method-local (not a package var) so the
// composer's concurrent variant fan-out — many Generate calls in flight — stays
// race-free: each call owns its own sanitizer + draft.
func (g *GatewayVoiceClient) Generate(ctx context.Context, tenantID string, kind ChatKind, prompt, contextText string) (GenerateResult, error) {
	san, _ := g.factory.SanitizerForTenant(ctx, tenantID, tenantID)
	// Tokenize the context up-front with the same sanitizer so its tokens share
	// the registry with the prompt's (a value seen in both maps to one token).
	sanitizedContext := contextText
	if san != nil {
		sanitizedContext = san.Sanitize(contextText)
	}
	// capturedDraft carries the structured draft out of the inner closure so
	// Generate can detokenize and return it. Method-local → race-free per call.
	var capturedDraft *CampaignDraft
	// Route the prompt through the generic gateway middleware. The inner closure
	// is the real model call with the (already sanitized) context.
	wrapped := pii_gateway.WrapVoiceClient(san, func(ctx context.Context, p string) (string, error) {
		res, err := g.inner.Generate(ctx, tenantID, kind, p, sanitizedContext)
		if err != nil {
			return "", err
		}
		capturedDraft = res.Draft
		return res.Text, nil
	})
	text, err := wrapped(ctx, prompt)
	if err != nil {
		return GenerateResult{}, err
	}
	out := GenerateResult{Text: text, Draft: capturedDraft}
	if san != nil && out.Draft != nil {
		out.Draft = &CampaignDraft{
			Name:        san.Restore(out.Draft.Name),
			Subject:     san.Restore(out.Draft.Subject),
			Body:        san.Restore(out.Draft.Body),
			PreviewText: san.Restore(out.Draft.PreviewText),
		}
	}
	return out, nil
}

// StrictTextSanitizerFactory receives the actual bounded text before any
// upstream model call. This is intentionally distinct from SanitizerFactory:
// model-facing authoring flows must discover high-confidence identifiers in
// their fully rendered prompt/context rather than relying on a caller to have
// resolved concrete subscriber values beforehand.
type StrictTextSanitizerFactory interface {
	SanitizerForText(
		ctx context.Context,
		tenantID, salt, prompt, contextText string,
	) (pii_gateway.Sanitizer, error)
}

// StrictTextSanitizerFactoryFunc adapts a function to the strict factory.
type StrictTextSanitizerFactoryFunc func(
	ctx context.Context,
	tenantID, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error)

func (f StrictTextSanitizerFactoryFunc) SanitizerForText(
	ctx context.Context,
	tenantID, salt, prompt, contextText string,
) (pii_gateway.Sanitizer, error) {
	return f(ctx, tenantID, salt, prompt, contextText)
}

// StrictTextGatewayVoiceClient is the fail-closed decorator used by production
// model-facing authoring flows. GatewayVoiceClient remains for compatibility
// tests and explicitly resolved-value callers; production wiring must use this
// strict boundary so a policy failure cannot downgrade into raw model egress.
type StrictTextGatewayVoiceClient struct {
	inner   VoiceClient
	factory StrictTextSanitizerFactory
}

// NewStrictTextGatewayVoiceClient returns a client that refuses to call inner
// unless a non-nil sanitizer was built from the actual prompt and context.
// Returning a non-nil wrapper even for missing dependencies preserves the
// fail-closed behavior if wiring is incomplete.
func NewStrictTextGatewayVoiceClient(
	inner VoiceClient,
	factory StrictTextSanitizerFactory,
) VoiceClient {
	return &StrictTextGatewayVoiceClient{inner: inner, factory: factory}
}

func (g *StrictTextGatewayVoiceClient) Generate(
	ctx context.Context,
	tenantID string,
	kind ChatKind,
	prompt, contextText string,
) (GenerateResult, error) {
	if g == nil || g.inner == nil || g.factory == nil {
		return GenerateResult{}, ErrStrictPIIGatewayUnavailable
	}
	salt, err := strictPIIRequestSalt()
	if err != nil {
		return GenerateResult{}, fmt.Errorf("%w: request salt: %v", ErrStrictPIIGatewayUnavailable, err)
	}
	sanitizer, err := g.factory.SanitizerForText(
		ctx,
		tenantID,
		salt,
		prompt,
		contextText,
	)
	if err != nil {
		return GenerateResult{}, fmt.Errorf("%w: %v", ErrStrictPIIGatewayUnavailable, err)
	}
	if sanitizer == nil {
		return GenerateResult{}, fmt.Errorf("%w: sanitizer is nil", ErrStrictPIIGatewayUnavailable)
	}

	sanitizedPrompt := sanitizer.Sanitize(prompt)
	sanitizedContext := sanitizer.Sanitize(contextText)
	result, err := g.inner.Generate(
		ctx,
		tenantID,
		kind,
		sanitizedPrompt,
		sanitizedContext,
	)
	if err != nil {
		return GenerateResult{}, err
	}
	result.Text = sanitizer.Restore(result.Text)
	if result.Draft != nil {
		result.Draft = &CampaignDraft{
			Name:        sanitizer.Restore(result.Draft.Name),
			Subject:     sanitizer.Restore(result.Draft.Subject),
			Body:        sanitizer.Restore(result.Draft.Body),
			PreviewText: sanitizer.Restore(result.Draft.PreviewText),
		}
	}
	return result, nil
}

func strictPIIRequestSalt() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}
