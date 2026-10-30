package aicompose

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/concurrency"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	defaultAIMaxInflight = 32
	maxAIMaxInflight     = 1024
)

// aiInflight bounds concurrent AI-compose inference so a burst can't starve the
// upstream Voice service or memory (G-35). Override with POSTWAVE_AI_MAX_INFLIGHT.
// The upper bound prevents a malformed deployment value from allocating an
// enormous semaphore during package initialization.
var aiInflight = concurrency.New(aiMaxInflightFromEnv())

func aiMaxInflightFromEnv() int {
	value, err := strconv.Atoi(os.Getenv("POSTWAVE_AI_MAX_INFLIGHT"))
	if err != nil || value < 1 || value > maxAIMaxInflight {
		return defaultAIMaxInflight
	}
	return value
}

// acquireAISlot sheds with 503 when the limiter is saturated. Returns false when
// the caller must stop.
func acquireAISlot(w http.ResponseWriter) (release func(), ok bool) {
	release, ok = aiInflight.TryAcquire()
	if !ok {
		w.Header().Set("Retry-After", "1")
		httperror.Write(w, http.StatusServiceUnavailable, "ai_at_capacity",
			"AI composer is at capacity; retry shortly")
	}
	return release, ok
}

// composeJSONMaxBodyBytes bounds inbound bodies — briefs are short, but
// the variants endpoint accepts a body excerpt that can grow.
const composeJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// Deps wires the composer into the HTTP layer.
type Deps struct {
	Composer *Composer
	// Logger is used by httperror.WriteInternal to record server-side
	// detail on 5xx paths without leaking err.Error() to the client.
	// May be nil in tests; httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

// MountRoutes mounts the AI composer routes onto the API router.
// Routes live under /api/v1/ai/compose. Scoped to ScopeWriteCampaigns
// because the user-visible action is "create a campaign draft" — the
// same scope used by the underlying voice generate endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Composer == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/ai/compose/broadcast", d.ComposeBroadcast)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/ai/compose/variants", d.ComposeVariants)
}

// ComposeBroadcast handles POST /api/v1/ai/compose/broadcast.
func (d *Deps) ComposeBroadcast(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	release, ok := acquireAISlot(w)
	if !ok {
		return
	}
	defer release()
	var in ComposeBroadcastInput
	if err := httpbody.DecodeJSON(w, r, composeJSONMaxBodyBytes, &in); err != nil {
		writeDecodeError(w, err)
		return
	}
	out, err := d.Composer.ComposeBroadcast(r.Context(), tenant.ID, in)
	if err != nil {
		d.writeComposeError(w, r.Context(), err)
		return
	}
	// EU AI Act Art. 50: mark the machine-generated email body so the marking
	// travels with the content (survives editing/sending), and advertise it on
	// the response for API consumers.
	out.Primary.Body = aidisclosure.MarkHTML(out.Primary.Body)
	writeAIJSON(w, http.StatusOK, out)
}

// ComposeVariants handles POST /api/v1/ai/compose/variants.
func (d *Deps) ComposeVariants(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	release, ok := acquireAISlot(w)
	if !ok {
		return
	}
	defer release()
	var in ComposeVariantsInput
	if err := httpbody.DecodeJSON(w, r, composeJSONMaxBodyBytes, &in); err != nil {
		writeDecodeError(w, err)
		return
	}
	out, err := d.Composer.ComposeVariants(r.Context(), tenant.ID, in)
	if err != nil {
		d.writeComposeError(w, r.Context(), err)
		return
	}
	writeAIJSON(w, http.StatusOK, out)
}

// writeDecodeError handles httpbody decode failures. The codes returned by
// httpbody.ErrorCode ("bad_json", "payload_too_large") are in the
// httperror safe-echo allowlist. Always use httpbody's fixed public text:
// json.Decoder syntax errors contain implementation details and offsets.
func writeDecodeError(w http.ResponseWriter, err error) {
	code := httpbody.ErrorCode(err)
	status := httpbody.StatusCode(err)
	if httperror.IsValidationCode(code) {
		httperror.Write(w, status, code, httpbody.PublicMessage(err))
		return
	}
	httperror.Write(w, status, code, "invalid request body")
}

// writeComposeError maps composer errors onto HTTP status codes. Voice
// unavailable → 503 (consistent with the upstream service's own behavior);
// bad request → 400; anything else → 500 (logged via WriteInternal so the
// raw upstream/transport error text never leaks to the caller).
func (d *Deps) writeComposeError(w http.ResponseWriter, ctx context.Context, err error) {
	switch {
	case errors.Is(err, ErrVoiceUnavailable),
		errors.Is(err, ErrStrictPIIGatewayUnavailable):
		httperror.Write(w, http.StatusServiceUnavailable, "voice_unavailable",
			"AI composer is temporarily unavailable")
	case errors.Is(err, ErrBadRequest):
		// ErrBadRequest is a typed sentinel wrapped with operator-
		// authored detail (e.g. "brief is required"). The text is
		// safe to echo because it never includes raw upstream / pgx
		// strings — only our own validation messages.
		httperror.WriteValidation(w, "bad_request", err.Error())
	default:
		// Upstream/transport failures: log err server-side, return a
		// generic envelope. Avoid leaking the raw HTTP client error
		// (which can contain URLs, response bodies, etc.) to the caller.
		httperror.WriteInternal(w, d.Logger, err, ctx)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeAIJSON is writeJSON plus the EU AI Act Art. 50 machine-readable marking
// header, for responses that carry AI-generated content.
func writeAIJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set(aidisclosure.HeaderName, "true")
	writeJSON(w, status, body)
}
