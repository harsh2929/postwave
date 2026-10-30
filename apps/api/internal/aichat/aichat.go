// SPDX-License-Identifier: AGPL-3.0-only

// Package aichat owns the API-side Moosewave AI Chat boundary. It deliberately
// returns bounded synchronous JSON even when the compatibility request carries
// stream=true: the model call must pass through the injected fail-closed PII
// gateway before any upstream bytes can be accepted.
package aichat

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	routePath               = "/api/v1/voice/generate"
	chatJSONMaxBodyBytes    = 128 << 10
	maxPromptBytes          = 32 << 10
	maxContextTextBytes     = 64 << 10
	maxContextRefs          = 20
	maxContextRefIDBytes    = 254
	maxResponseTextBytes    = 200_000
	maxDraftNameBytes       = 512
	maxDraftSubjectBytes    = 1_000
	maxDraftPreviewBytes    = 2_000
	maxDraftBodyBytes       = 200_000
	maxCombinedResponseSize = 256 << 10
)

var allowedKinds = map[string]struct{}{
	"campaign_draft": {},
	"subject_line":   {},
	"summary":        {},
	"free_form":      {},
}

var allowedContextKinds = map[string]struct{}{
	"campaign":      {},
	"subscriber":    {},
	"sequence":      {},
	"template":      {},
	"form":          {},
	"voice_profile": {},
}

type contextRef struct {
	Kind string `json:"kind,omitempty"`
	// Type is accepted only for the immediately preceding desktop wire shape.
	// A request carrying both fields must make them agree.
	Type string `json:"type,omitempty"`
	ID   string `json:"id"`
}

func (r contextRef) canonicalKind() string {
	if strings.TrimSpace(r.Kind) != "" {
		return strings.TrimSpace(r.Kind)
	}
	return strings.TrimSpace(r.Type)
}

type request struct {
	Prompt      string       `json:"prompt"`
	Kind        string       `json:"kind"`
	ContextRefs []contextRef `json:"context_refs,omitempty"`
	ContextText string       `json:"context_text,omitempty"`
	// Stream remains in the compatibility request contract. The API always
	// responds with JSON so one privacy-gated model call has one receipt.
	Stream bool `json:"stream,omitempty"`
}

type response struct {
	Text  string                   `json:"text"`
	Draft *aicompose.CampaignDraft `json:"draft,omitempty"`
}

type validationProblem struct {
	status  int
	code    string
	message string
}

// Deps requires an aicompose VoiceClient built with
// NewStrictTextGatewayVoiceClient. The handler cannot infer whether an
// arbitrary implementation is wrapped, so production wiring and integration
// tests own that construction invariant.
type Deps struct {
	Voice  aicompose.VoiceClient
	Logger *slog.Logger
	// VoiceNotDeployed says this environment runs no voice service
	// (VOICE_SERVICE_URL=disabled): chat answers that it is not available
	// here, instead of failing each request as an internal error.
	VoiceNotDeployed bool
}

// Mount keeps the historical desktop path and write_campaigns scope.
// Main mounts this package inside the shared expensive-tenant limiter group.
func Mount(router chi.Router, deps *Deps) {
	if router == nil || deps == nil {
		return
	}
	// Keep the literal path at the executable registration site: the
	// fail-closed route-reachability generator admits only concrete routes.
	router.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/voice/generate", deps.Generate)
}

// Generate validates the compatibility request, uses only the trusted tenant
// context, and delegates exactly once to the injected strict PII gateway.
func (d *Deps) Generate(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || strings.TrimSpace(tenant.ID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d != nil && d.VoiceNotDeployed {
		httperror.WriteUnavailable(w, "service_not_deployed",
			"AI chat isn't available in this environment.", false)
		return
	}
	if d == nil || d.Voice == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "ai_chat_unavailable", "AI chat is unavailable")
		return
	}

	var input request
	if err := httpbody.DecodeJSON(w, r, chatJSONMaxBodyBytes, &input); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if problem := validateRequest(&input); problem != nil {
		httperror.Write(w, problem.status, problem.code, problem.message)
		return
	}

	result, err := d.Voice.Generate(
		r.Context(),
		tenant.ID,
		aicompose.ChatKind(input.Kind),
		input.Prompt,
		input.ContextText,
	)
	if err != nil {
		d.writeGenerationError(w, r.Context(), err)
		return
	}
	output := response{Text: result.Text}
	if result.Draft != nil {
		draft := *result.Draft
		if draft.Body != "" {
			draft.Body = aidisclosure.MarkHTML(draft.Body)
		}
		output.Draft = &draft
	}
	if err := validateResponse(output); err != nil {
		d.writeGenerationError(w, r.Context(), err)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set(aidisclosure.HeaderName, "true")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(output)
}

func validateRequest(input *request) *validationProblem {
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Prompt == "" {
		return &validationProblem{http.StatusBadRequest, "prompt_required", "prompt is required"}
	}
	if !utf8.ValidString(input.Prompt) || len(input.Prompt) > maxPromptBytes {
		return &validationProblem{http.StatusRequestEntityTooLarge, "prompt_too_large", "prompt exceeds the permitted size"}
	}
	input.Kind = strings.TrimSpace(input.Kind)
	if input.Kind == "" {
		input.Kind = "free_form"
	}
	if _, ok := allowedKinds[input.Kind]; !ok {
		return &validationProblem{http.StatusBadRequest, "unsupported_kind", "unsupported chat kind"}
	}
	if !utf8.ValidString(input.ContextText) || len(input.ContextText) > maxContextTextBytes {
		return &validationProblem{http.StatusRequestEntityTooLarge, "context_too_large", "context exceeds the permitted size"}
	}
	if len(input.ContextRefs) > maxContextRefs {
		return &validationProblem{http.StatusBadRequest, "too_many_context_refs", "too many context references"}
	}

	seen := make(map[string]struct{}, len(input.ContextRefs))
	for _, ref := range input.ContextRefs {
		kind := ref.canonicalKind()
		if strings.TrimSpace(ref.Kind) != "" && strings.TrimSpace(ref.Type) != "" &&
			strings.TrimSpace(ref.Kind) != strings.TrimSpace(ref.Type) {
			return &validationProblem{http.StatusBadRequest, "invalid_context_ref", "context reference kind fields conflict"}
		}
		if _, ok := allowedContextKinds[kind]; !ok {
			return &validationProblem{http.StatusBadRequest, "invalid_context_ref", "unsupported context reference kind"}
		}
		id := strings.TrimSpace(ref.ID)
		if id == "" || len(id) > maxContextRefIDBytes || !utf8.ValidString(id) ||
			strings.IndexFunc(id, unicode.IsControl) >= 0 {
			return &validationProblem{http.StatusBadRequest, "invalid_context_ref", "context reference id is invalid"}
		}
		key := kind + "\x00" + id
		if _, duplicate := seen[key]; duplicate {
			return &validationProblem{http.StatusBadRequest, "duplicate_context_ref", "duplicate context reference"}
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validateResponse(output response) error {
	if !utf8.ValidString(output.Text) || strings.TrimSpace(output.Text) == "" ||
		len(output.Text) > maxResponseTextBytes {
		return errors.New("aichat: upstream text response is invalid")
	}
	total := len(output.Text)
	if output.Draft != nil {
		draft := output.Draft
		if !boundedUTF8(draft.Name, maxDraftNameBytes) ||
			!boundedUTF8(draft.Subject, maxDraftSubjectBytes) ||
			!boundedUTF8(draft.PreviewText, maxDraftPreviewBytes) ||
			!boundedUTF8(draft.Body, maxDraftBodyBytes) ||
			(strings.TrimSpace(draft.Subject) == "" && strings.TrimSpace(draft.Body) == "") {
			return errors.New("aichat: upstream draft response is invalid")
		}
		total += len(draft.Name) + len(draft.Subject) + len(draft.PreviewText) + len(draft.Body)
	}
	if total > maxCombinedResponseSize {
		return errors.New("aichat: upstream response exceeds the combined limit")
	}
	return nil
}

func boundedUTF8(value string, maximum int) bool {
	return utf8.ValidString(value) && len(value) <= maximum
}

func (d *Deps) writeGenerationError(w http.ResponseWriter, ctx context.Context, err error) {
	if d != nil && d.Logger != nil {
		d.Logger.ErrorContext(ctx, "AI chat generation failed", "err", err)
	}
	status := http.StatusBadGateway
	if errors.Is(err, aicompose.ErrVoiceUnavailable) ||
		errors.Is(err, aicompose.ErrStrictPIIGatewayUnavailable) {
		status = http.StatusServiceUnavailable
	} else if errors.Is(err, context.DeadlineExceeded) {
		status = http.StatusGatewayTimeout
	}
	// httperror intentionally normalizes every 5xx code/message to the generic
	// internal envelope. Raw gateway, transport, provider, and model details are
	// logged server-side only.
	httperror.Write(w, status, "ai_chat_failed", "AI chat could not complete")
}
