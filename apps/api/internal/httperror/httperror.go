// Package httperror provides a single, opinionated way for API handlers to
// emit JSON error responses without leaking internal error text to callers.
//
// # Migration recipe
//
// Most handlers in this codebase use a local helper pattern like:
//
//	writeJSON(w, status, errEnv(code, err.Error()))
//
// That pattern echoes the raw Go error string to the client, which can leak
// database internals (pgx error messages, SQL fragments, file paths) and is
// also hard for callers to program against. Replace those calls as follows:
//
//   - For UNKNOWN or INFRASTRUCTURE errors (db failures, timeouts, panics,
//     unexpected branches), use:
//
//     httperror.WriteInternal(w, d.Logger, err, r.Context())
//
//     This logs err.Error() server-side with tenant_id+request_id+err and
//     returns a generic {error:{code:"internal_error", message:"an internal
//     error occurred", request_id:"..."}} envelope to the client. It NEVER
//     echoes err.Error() to the response body.
//
//   - For INPUT/USER errors that are safe to surface verbatim (validation
//     failures, erasure-blocked, payload-too-large, conflict messages
//     authored for operators), use:
//
//     httperror.WriteValidation(w, "validation_failed", err.Error())
//
//     Only codes returned true by IsValidationCode are considered safe to
//     echo a free-form message for. Other codes use Write with a static
//     operator-authored string.
//
//   - For richer cases (multi-field validation, RFC-7807 consumers), use
//     WriteProblemJSON with a populated Problem.
//
//   - For the common fixed-message cases (no_tenant, not_found, etc.),
//     use Write(w, status, code, message) directly with a hand-authored,
//     non-sensitive message string.
package httperror

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

const (
	// ContentTypeJSON is the Content-Type set on every error response.
	ContentTypeJSON = "application/json; charset=utf-8"

	// ContentTypeProblemJSON is the RFC 7807 media type.
	ContentTypeProblemJSON = "application/problem+json; charset=utf-8"

	// CodeInternal is the stable error code returned for all
	// unexpected/internal failures. Clients can match on this string.
	CodeInternal = "internal_error"

	// MessageInternal is the operator-safe message returned alongside
	// CodeInternal. Crucially, it does NOT include err.Error().
	MessageInternal = "an internal error occurred"
)

// MessageForStatus returns fixed caller-safe text for response paths that
// must retain a domain-specific status/code but cannot safely expose an
// upstream, parser, signature, provider, or persistence error string.
func MessageForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "request is invalid"
	case http.StatusUnauthorized:
		return "request authentication failed"
	case http.StatusForbidden:
		return "request is forbidden"
	case http.StatusNotFound:
		return "resource was not found"
	case http.StatusConflict:
		return "request conflicts with current state"
	case http.StatusRequestEntityTooLarge:
		return "request body exceeds the permitted size"
	case http.StatusUnprocessableEntity:
		return "request could not be processed"
	case http.StatusTooManyRequests:
		return "too many requests"
	default:
		if status >= http.StatusInternalServerError {
			return MessageInternal
		}
		return "request could not be completed"
	}
}

// envelope is the canonical JSON shape every error response uses:
//
//	{"error": {"code": "<stable_code>", "message": "<human_text>",
//	           "request_id": "<chi req id>"}}
//
// request_id is omitted when not available (e.g. background jobs surfacing
// errors through HTTP-style helpers in tests).
type envelope struct {
	Err errorBody `json:"error"`
}

type errorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

// Problem implements the RFC 7807 problem+json envelope. Use WriteProblemJSON
// to emit it. Type SHOULD be a stable URI; Title is a short human summary;
// Detail may include operator-safe specifics; Instance is the request URI.
// Code mirrors our internal stable code so existing clients can keep matching.
type Problem struct {
	Type     string         `json:"type,omitempty"`
	Title    string         `json:"title"`
	Status   int            `json:"status"`
	Detail   string         `json:"detail,omitempty"`
	Instance string         `json:"instance,omitempty"`
	Code     string         `json:"code,omitempty"`
	Extras   map[string]any `json:"-"`
}

// Write emits the stable {error:{code,message}} envelope at the given status.
// It is the lowest-level helper; prefer WriteInternal/WriteValidation when
// they apply so logging/sanitization happens uniformly.
//
// message MUST be an operator-authored, non-sensitive string. Do NOT pass
// err.Error() here for unknown errors — use WriteInternal instead.
func Write(w http.ResponseWriter, status int, code, message string) {
	if status >= http.StatusInternalServerError {
		code = CodeInternal
		message = MessageInternal
	}
	writeEnvelope(w, status, envelope{Err: errorBody{
		Code:      code,
		Message:   message,
		RequestID: requestIDFromWriter(w),
	}})
}

// WriteInternal logs err with tenant_id+request_id+err context and writes a
// generic 500 envelope that does NOT contain err.Error(). Use this for any
// error whose text is not safe to expose (db failures, unexpected branches,
// upstream timeouts, etc.).
//
// logger may be nil; in that case nothing is logged but the response is
// still written. ctx is read for chi request_id and middleware-attached
// tenant_id when available.
func WriteInternal(w http.ResponseWriter, logger *slog.Logger, err error, ctx context.Context) {
	reqID := requestIDFromCtx(ctx)
	// Fall back rather than discard. Deps structs are routinely constructed
	// without a logger -- the API-keys surface is `&apikeys.Deps{Repo, Cache}`
	// while the mount on the next line passes one, and a dozen other surfaces
	// match. Guarding with `if logger != nil` turned those into 500s that the
	// server had NOTHING to say about: an opaque envelope with a request_id,
	// and grepping for that request_id returned only the access-log line.
	//
	// An internal error is precisely the event that must never be silent, so a
	// missing logger degrades to the default one instead of to nothing.
	if logger == nil {
		logger = slog.Default()
	}
	attrs := []any{
		slog.String("request_id", reqID),
		slog.String("tenant_id", tenantIDFromCtx(ctx)),
	}
	if err != nil {
		attrs = append(attrs, slog.String("err", err.Error()))
	}
	// A client that closes the request (a superseded segment count, a closed
	// tab, a page navigation) cancels its context, and every query the
	// handler was running fails with that cancellation. It is not an internal
	// error: nothing is wrong with the server, and nobody receives this
	// response. Logging it at ERROR as a 500 made those requests about a third
	// of staging's 5xx. It is recorded as 499 at INFO instead. Only the
	// request's own cancellation qualifies; our own deadlines end a context
	// with DeadlineExceeded and stay 500s below.
	if isClientCancellation(ctx, err) {
		logger.LogAttrs(ctx, slog.LevelInfo, "http.client_closed_request", toAttrs(attrs)...)
		writeEnvelope(w, StatusClientClosedRequest, envelope{Err: errorBody{
			Code:      CodeClientClosedRequest,
			Message:   messageClientClosedRequest,
			RequestID: reqID,
		}})
		return
	}
	logger.LogAttrs(ctx, slog.LevelError, "http.internal_error", toAttrs(attrs)...)
	// An upstream we could not reach is not an internal error. 500 says "this
	// request is broken, retrying will not help"; 502 says "the path through us
	// is broken, the request itself was fine". Clients retry differently,
	// alerting routes differently, and an operator reading 500s goes hunting
	// for a code bug that does not exist.
	//
	// *url.Error is the exact discriminator. net/http's Client wraps EVERY
	// transport failure in one, and nothing else here produces it -- a pgx
	// error, a marshalling error and a business-rule error are all something
	// else -- so this identifies "an outbound HTTP call failed" without
	// guessing at error strings. errors.As sees through the %w annotations
	// handlers add.
	var upstream *url.Error
	if err != nil && errors.As(err, &upstream) {
		writeEnvelope(w, http.StatusBadGateway, envelope{Err: errorBody{
			Code:      "upstream_unavailable",
			Message:   "a service this request depends on could not be reached",
			RequestID: reqID,
		}})
		return
	}
	writeEnvelope(w, http.StatusInternalServerError, envelope{Err: errorBody{
		Code:      CodeInternal,
		Message:   MessageInternal,
		RequestID: reqID,
	}})
}

// WriteValidation emits a 400 with the given code and message. The caller is
// expected to have already verified that code is in the safe-to-echo set
// (see IsValidationCode); this helper does NOT enforce that, so the message
// may be a free-form err.Error() when the error type guarantees the text is
// operator-safe (e.g. our own validator produced it).
func WriteValidation(w http.ResponseWriter, code, message string) {
	Write(w, http.StatusBadRequest, code, message)
}

// WriteProblemJSON emits a RFC 7807 application/problem+json response. Extras
// fields are flattened into the top-level object alongside the standard
// members, so callers can attach domain-specific data (e.g. retry_after,
// field-level errors) without inventing a new envelope.
func WriteProblemJSON(w http.ResponseWriter, p Problem) {
	status := p.Status
	if status <= 0 {
		status = http.StatusBadRequest
		p.Status = status
	}
	if status >= http.StatusInternalServerError {
		// A problem document has several caller-controlled fields, not just
		// Detail. Drop all of them at the trust boundary for 5xx responses so
		// an upstream, database, path, token, or signature canary cannot leak
		// through Title, Type, Instance, Code, or Extras either.
		p = Problem{
			Title:  http.StatusText(status),
			Status: status,
			Detail: MessageInternal,
			Code:   CodeInternal,
		}
	}
	body := map[string]any{
		"title":  p.Title,
		"status": status,
	}
	if p.Type != "" {
		body["type"] = p.Type
	}
	if p.Detail != "" {
		body["detail"] = p.Detail
	}
	if p.Instance != "" {
		body["instance"] = p.Instance
	}
	if p.Code != "" {
		body["code"] = p.Code
	}
	for k, v := range p.Extras {
		// Don't allow extras to clobber the canonical members.
		if _, exists := body[k]; exists {
			continue
		}
		body[k] = v
	}
	if rid := requestIDFromWriter(w); rid != "" {
		if _, exists := body["request_id"]; !exists {
			body["request_id"] = rid
		}
	}
	w.Header().Set("Content-Type", ContentTypeProblemJSON)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// IsValidationCode reports whether code is part of the curated set of error
// codes whose message string is considered safe to echo back to clients
// verbatim (e.g. via err.Error()).
//
// New codes MUST be added only when the codepath that produces them is the
// project's own validator producing operator-authored strings — never when
// the string comes from pgx, an upstream HTTP client, or a generic library.
func IsValidationCode(code string) bool {
	_, ok := safeEchoCodes[code]
	return ok
}

// safeEchoCodes is the allowlist used by IsValidationCode. Sorted
// alphabetically to make additions easy to review.
var safeEchoCodes = map[string]struct{}{
	"bad_json":          {}, // httpbody.DecodeJSON returns operator-safe text.
	"erasure_blocked":   {}, // GDPR/CCPA workflow explanations.
	"invalid_input":     {},
	"invalid_request":   {},
	"missing_field":     {},
	"payload_too_large": {}, // httpbody.ErrTooLarge text is safe.
	"rate_limited":      {}, // surface retry-after / scope text.
	"validation_failed": {}, // our validator emits these.
}

// --- internal helpers ---------------------------------------------------------

func writeEnvelope(w http.ResponseWriter, status int, body envelope) {
	w.Header().Set("Content-Type", ContentTypeJSON)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func requestIDFromCtx(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	return chimiddleware.GetReqID(ctx)
}

// requestIDFromWriter returns the chi request id attached to the active
// request via the response writer's context, when discoverable. Today we
// have no plumbing from w back to r, so this always returns "" — callers
// that DO have a context should prefer requestIDFromCtx. Kept as a hook
// so a future middleware can stash it on a header we can read here.
func requestIDFromWriter(w http.ResponseWriter) string {
	// Allow handlers / middleware to surface the request id via the
	// response header set by chi-middleware.RequestID when it's enabled.
	// chi sets "X-Request-Id" on the *request* but not the writer, so we
	// also check the header the writer has — middleware may copy it.
	if h := w.Header().Get("X-Request-Id"); h != "" {
		return h
	}
	return ""
}

// tenantIDFromCtx is intentionally decoupled from the middleware package to
// avoid an import cycle (middleware → httperror would break the layering we
// want). It reads via a string key that middleware/tenant.go can publish
// alongside its typed key in a follow-up; until then it returns "".
//
// Callers that have the *middleware.Tenant in hand can include it in their
// own log line if richer detail is needed.
func tenantIDFromCtx(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v := ctx.Value(tenantIDLogKey); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// tenantIDLogKey is a context key that middleware can use to publish the
// tenant id as a plain string for cross-package log enrichment, without
// httperror needing to import middleware.
type tenantIDKeyType struct{}

var tenantIDLogKey = tenantIDKeyType{}

// WithTenantIDLog returns a derived context carrying tenantID as a plain
// string, readable by WriteInternal for log enrichment. Middleware that
// already attaches a typed *Tenant can additionally call this helper to
// surface the id here. Safe to call with empty tenantID (no-op).
func WithTenantIDLog(ctx context.Context, tenantID string) context.Context {
	if tenantID == "" {
		return ctx
	}
	return context.WithValue(ctx, tenantIDLogKey, tenantID)
}

func toAttrs(kvs []any) []slog.Attr {
	out := make([]slog.Attr, 0, len(kvs))
	for _, kv := range kvs {
		if a, ok := kv.(slog.Attr); ok {
			out = append(out, a)
		}
	}
	return out
}
