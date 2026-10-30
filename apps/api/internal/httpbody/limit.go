// SPDX-License-Identifier: AGPL-3.0-only

// Package httpbody owns the API's inbound request-body contract. Keeping the
// limits and JSON rules here prevents individual handlers from accidentally
// accepting an unbounded, ambiguous, or content-type-confused payload.
package httpbody

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
)

const (
	// DefaultJSONMaxBodyBytes is the ceiling for ordinary JSON API payloads.
	// Handlers with a demonstrably larger contract must pass their own named
	// constant to DecodeJSON.
	DefaultJSONMaxBodyBytes int64 = 1 << 20 // 1 MiB

	// DefaultRequestMaxBodyBytes is the gateway-wide ceiling for routes that
	// do not appear in ProductionRouteLimits. Route-local decoders normally
	// impose a much smaller limit; this is the final defence against a missed
	// body reader.
	DefaultRequestMaxBodyBytes int64 = 8 << 20 // 8 MiB
)

// ErrTooLarge is returned when a request body exceeds the configured cap.
var ErrTooLarge = errors.New("request body too large")

// ErrEmpty is returned when a required JSON request has no JSON value.
var ErrEmpty = errors.New("request body must contain a JSON value")

// ErrUnsupportedMediaType is returned when a JSON endpoint receives a body
// without application/json (or a registered +json media type).
var ErrUnsupportedMediaType = errors.New("Content-Type must be application/json")

// ErrMultipleJSONValues is returned when a JSON request contains more than
// one top-level value. It keeps handlers from accepting ambiguous payloads
// such as `{...}{...}` where only the first object would otherwise be used.
var ErrMultipleJSONValues = errors.New("request body must contain a single JSON value")

// ErrUnknownField is returned when a JSON request carries a field that the
// destination struct does not declare. Rejecting typo'd / mis-cased keys is
// the default production contract; compatibility endpoints must opt out.
var ErrUnknownField = errors.New("request body contains an unknown field")

// Options tunes DecodeJSONWith. The zero value is intentionally strict.
// Every relaxation is named so a compatibility exception is visible in code
// review and can be found by the request-body static gate.
type Options struct {
	// AllowUnknownFields permits keys not declared by the destination struct.
	// Use only for explicitly versioned compatibility/webhook envelopes.
	AllowUnknownFields bool

	// AllowMissingContentType accepts a missing Content-Type header. An
	// explicitly wrong media type is still rejected. This exists only for
	// legacy endpoints whose documented clients cannot yet send the header.
	AllowMissingContentType bool

	// AllowEmptyBody treats a body with no JSON value as a successful decode
	// into dst's zero value. It is appropriate for POST actions whose options
	// object is genuinely optional.
	AllowEmptyBody bool

	// UseNumber keeps JSON numbers as json.Number when decoding into an
	// interface or map. Signed compatibility webhooks occasionally need this
	// to preserve large numeric identifiers without falling through float64.
	UseNumber bool

	// DisallowUnknownFields is retained for source compatibility with callers
	// that opted into the old lenient decoder. Unknown fields are now rejected
	// by default, so new code must not set this field.
	DisallowUnknownFields bool
}

// RouteLimit is an audited exception to the gateway's default request limit.
// Pattern consists of slash-separated literal segments, {parameter} segments
// that match exactly one non-empty segment, and a final * segment that matches
// the rest of the path.
type RouteLimit struct {
	Method   string
	Pattern  string
	MaxBytes int64
	Reason   string
}

// ProductionRouteLimits is the complete list of request shapes whose valid
// payloads exceed DefaultRequestMaxBodyBytes. The handler still enforces its
// own tighter semantic/file/row quota; these entries only prevent the global
// defence-in-depth ceiling from making the advertised route unusable.
var ProductionRouteLimits = []RouteLimit{
	{http.MethodPost, "/api/v1/assets", 20 << 20, "10 MiB asset encoded as JSON or multipart"},
	{http.MethodPost, "/api/v1/subscribers/import", 32 << 20, "10,000-row subscriber CSV import"},
	{http.MethodPost, "/api/v1/subscriber-imports/preview", 50 << 20, "migration-wizard CSV preview"},
	{http.MethodPost, "/api/v1/lists/{id}/import", 32 << 20, "10,000-row list CSV import"},
	{http.MethodPost, "/api/v1/suppressions/import", 25 << 20, "suppression CSV import"},
	{http.MethodPost, "/api/v1/suppressions/bulk-import", 16 << 20, "bounded suppression JSON batch"},
	{http.MethodPost, "/api/v1/suppressions/bulk-delete", 16 << 20, "bounded suppression JSON batch"},
	{http.MethodPost, "/api/v1/suppressions/bulk-action", 16 << 20, "bounded suppression JSON batch"},
	{http.MethodPost, "/api/v1/emails", 35 << 20, "transactional email with base64 attachments"},
	{http.MethodPost, "/api/v1/emails/batch", 40 << 20, "bounded transactional email batch"},
	{http.MethodPut, "/api/internal/uploads/*", 25 << 20, "development-only presigned upload target"},
}

// ReadAtMost reads r up to max bytes and returns ErrTooLarge when one or more
// extra bytes are present. It is intended for signed webhook receivers where
// the exact bytes must be retained for signature verification.
func ReadAtMost(r io.Reader, max int64) ([]byte, error) {
	if max <= 0 {
		return nil, fmt.Errorf("max must be positive")
	}
	body, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, ErrTooLarge
		}
		return nil, err
	}
	if int64(len(body)) > max {
		return nil, ErrTooLarge
	}
	return body, nil
}

// ReadJSONAtMost validates the request media type and retains the exact raw
// bytes under an explicit quota. Signed webhook handlers use it when they
// must verify the original bytes before decoding JSON. JSON syntax and shape
// must still be validated after signature verification.
func ReadJSONAtMost(r *http.Request, max int64, opts Options) ([]byte, error) {
	if r == nil {
		return nil, errors.New("request is nil")
	}
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		if opts.AllowEmptyBody {
			return nil, nil
		}
		return nil, ErrEmpty
	}
	if err := validateJSONMediaType(r.Header.Get("Content-Type"), opts.AllowMissingContentType); err != nil {
		return nil, err
	}
	return ReadAtMost(r.Body, max)
}

// PeekAtMost reads at most max bytes from body while restoring the exact
// request stream for the next handler. When the body is larger than max it
// returns ErrTooLarge, but still restores the prefix plus the unread tail.
// It is intended for middleware that inspects a small JSON prefix without
// taking ownership of the downstream handler's request body.
func PeekAtMost(body *io.ReadCloser, max int64) ([]byte, error) {
	if body == nil || *body == nil {
		return nil, nil
	}
	if max <= 0 {
		return nil, fmt.Errorf("max must be positive")
	}
	original := *body
	prefix, err := io.ReadAll(io.LimitReader(original, max+1))
	*body = &replayReadCloser{
		Reader: io.MultiReader(bytes.NewReader(prefix), original),
		Closer: original,
	}
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, ErrTooLarge
		}
		return nil, err
	}
	if int64(len(prefix)) > max {
		return nil, ErrTooLarge
	}
	return prefix, nil
}

// CopyAtMost streams no more than max bytes from src to dst and returns
// ErrTooLarge if an additional byte is present. Unlike io.LimitReader alone,
// it never mistakes a silently truncated upload for a successful one.
func CopyAtMost(dst io.Writer, src io.Reader, max int64) (int64, error) {
	if max <= 0 {
		return 0, fmt.Errorf("max must be positive")
	}
	n, err := io.Copy(dst, io.LimitReader(src, max))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return n, ErrTooLarge
		}
		return n, err
	}
	if n < max {
		return n, nil
	}
	var extra [1]byte
	extraN, readErr := io.ReadFull(src, extra[:])
	if extraN > 0 {
		return n, ErrTooLarge
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		var maxErr *http.MaxBytesError
		if errors.As(readErr, &maxErr) {
			return n, ErrTooLarge
		}
		return n, readErr
	}
	return n, nil
}

type replayReadCloser struct {
	io.Reader
	io.Closer
}

// DecodeJSON validates a JSON media type, caps r.Body at max bytes, rejects
// unknown fields, and decodes exactly one JSON value into dst.
func DecodeJSON(w http.ResponseWriter, r *http.Request, max int64, dst any) error {
	return DecodeJSONWith(w, r, max, dst, Options{})
}

// DecodeJSONBytes applies the same strict contract as DecodeJSONWith while
// also returning the bounded original bytes. It exists for handlers such as
// SCIM that must persist the submitted resource representation after safely
// decoding it.
func DecodeJSONBytes(r *http.Request, max int64, dst any, opts Options) ([]byte, error) {
	if max <= 0 {
		return nil, fmt.Errorf("max must be positive")
	}
	if r == nil {
		return nil, errors.New("request is nil")
	}
	if dst == nil {
		return nil, errors.New("decode destination is nil")
	}
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		if opts.AllowEmptyBody {
			return nil, nil
		}
		return nil, ErrEmpty
	}
	if err := validateJSONMediaType(r.Header.Get("Content-Type"), opts.AllowMissingContentType); err != nil {
		return nil, err
	}
	body, err := ReadAtMost(r.Body, max)
	if err != nil {
		return nil, err
	}
	if err := DecodeJSONValue(body, dst, opts); err != nil {
		return nil, err
	}
	return body, nil
}

// DecodeJSONValue strictly decodes already-bounded JSON bytes. It is the
// second half of the signed-webhook flow: ReadJSONAtMost retains exact bytes,
// the handler verifies the signature, then this function enforces syntax,
// unknown-field, and trailing-data rules.
func DecodeJSONValue(body []byte, dst any, opts Options) error {
	if dst == nil {
		return errors.New("decode destination is nil")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if opts.UseNumber {
		dec.UseNumber()
	}
	if !opts.AllowUnknownFields || opts.DisallowUnknownFields {
		dec.DisallowUnknownFields()
	}
	if err := dec.Decode(dst); err != nil {
		err = normalizeDecodeError(err)
		if errors.Is(err, io.EOF) {
			if opts.AllowEmptyBody {
				return nil
			}
			return ErrEmpty
		}
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return normalizeDecodeError(err)
	}
	return ErrMultipleJSONValues
}

// DecodeJSONWith is DecodeJSON with explicit, reviewable compatibility
// options. The zero Options value is the production-safe strict contract.
func DecodeJSONWith(w http.ResponseWriter, r *http.Request, max int64, dst any, opts Options) error {
	if max <= 0 {
		return fmt.Errorf("max must be positive")
	}
	if r == nil {
		return errors.New("request is nil")
	}
	if dst == nil {
		return errors.New("decode destination is nil")
	}

	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		if opts.AllowEmptyBody {
			return nil
		}
		return ErrEmpty
	}
	if err := validateJSONMediaType(r.Header.Get("Content-Type"), opts.AllowMissingContentType); err != nil {
		return err
	}

	r.Body = http.MaxBytesReader(w, r.Body, max)
	dec := json.NewDecoder(r.Body)
	if opts.UseNumber {
		dec.UseNumber()
	}
	if !opts.AllowUnknownFields || opts.DisallowUnknownFields {
		dec.DisallowUnknownFields()
	}
	if err := dec.Decode(dst); err != nil {
		err = normalizeDecodeError(err)
		if errors.Is(err, io.EOF) {
			if opts.AllowEmptyBody {
				return nil
			}
			return ErrEmpty
		}
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return normalizeDecodeError(err)
	}
	return ErrMultipleJSONValues
}

// LimitRequests applies the process-wide request ceiling and the audited
// large-route exceptions. It rejects a known oversized Content-Length before
// calling a handler and wraps chunked/unknown-length bodies so reads cannot
// cross the selected quota.
func LimitRequests(defaultMax int64, overrides []RouteLimit) func(http.Handler) http.Handler {
	if defaultMax <= 0 {
		panic("httpbody: default request limit must be positive")
	}
	validated := make([]RouteLimit, len(overrides))
	copy(validated, overrides)
	seen := make(map[string]struct{}, len(validated))
	for _, override := range validated {
		if override.Method == "" || override.Pattern == "" || override.MaxBytes <= 0 || override.Reason == "" {
			panic("httpbody: every route limit requires method, pattern, positive max, and reason")
		}
		if override.MaxBytes <= defaultMax {
			panic("httpbody: route limits must exceed the default request limit")
		}
		key := override.Method + " " + override.Pattern
		if _, duplicate := seen[key]; duplicate {
			panic("httpbody: duplicate route limit " + key)
		}
		seen[key] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			max := defaultMax
			for _, override := range validated {
				if r.Method == override.Method && matchPath(override.Pattern, r.URL.Path) {
					max = override.MaxBytes
					break
				}
			}
			if r.ContentLength > max {
				WriteError(w, ErrTooLarge)
				return
			}
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, max)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// StatusCode maps request-body errors to their HTTP status.
func StatusCode(err error) int {
	switch {
	case errors.Is(err, ErrTooLarge):
		return http.StatusRequestEntityTooLarge
	case errors.Is(err, ErrUnsupportedMediaType):
		return http.StatusUnsupportedMediaType
	default:
		return http.StatusBadRequest
	}
}

// ErrorCode maps request-body errors to stable API error codes.
func ErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrTooLarge):
		return "payload_too_large"
	case errors.Is(err, ErrUnsupportedMediaType):
		return "unsupported_media_type"
	case errors.Is(err, ErrUnknownField):
		return "unknown_field"
	case errors.Is(err, ErrMultipleJSONValues):
		return "multiple_json_values"
	default:
		return "bad_json"
	}
}

// PublicMessage returns an operator-authored message safe to expose to an API
// caller. Parser offsets and implementation details stay out of responses.
func PublicMessage(err error) string {
	switch {
	case errors.Is(err, ErrTooLarge):
		return "Request body exceeds the permitted size."
	case errors.Is(err, ErrUnsupportedMediaType):
		return "Content-Type must be application/json."
	case errors.Is(err, ErrUnknownField):
		return "Request body contains an unknown field."
	case errors.Is(err, ErrMultipleJSONValues):
		return "Request body must contain exactly one JSON value."
	case errors.Is(err, ErrEmpty):
		return "Request body must contain a JSON value."
	default:
		return "Request body is not valid JSON."
	}
}

// WriteError writes the standard JSON API error envelope for a request-body
// error. It is used by the global limiter and by migrated handlers that did
// not previously have a package-specific error writer.
func WriteError(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(StatusCode(err))
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{
			"code":    ErrorCode(err),
			"message": PublicMessage(err),
		},
	})
}

func validateJSONMediaType(raw string, allowMissing bool) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if allowMissing {
			return nil
		}
		return ErrUnsupportedMediaType
	}
	mediaType, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return ErrUnsupportedMediaType
	}
	mediaType = strings.ToLower(mediaType)
	if mediaType != "application/json" && !(strings.HasPrefix(mediaType, "application/") && strings.HasSuffix(mediaType, "+json")) {
		return ErrUnsupportedMediaType
	}
	for key, value := range params {
		if !strings.EqualFold(key, "charset") || !strings.EqualFold(strings.TrimSpace(value), "utf-8") {
			return ErrUnsupportedMediaType
		}
	}
	return nil
}

func matchPath(pattern, requestPath string) bool {
	patternParts := splitPath(pattern)
	requestParts := splitPath(requestPath)
	for i, part := range patternParts {
		if part == "*" {
			return i == len(patternParts)-1 && i < len(requestParts)
		}
		if i >= len(requestParts) {
			return false
		}
		if strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") {
			if requestParts[i] == "" {
				return false
			}
			continue
		}
		if part != requestParts[i] {
			return false
		}
	}
	return len(patternParts) == len(requestParts)
}

func splitPath(value string) []string {
	value = strings.Trim(value, "/")
	if value == "" {
		return nil
	}
	return strings.Split(value, "/")
}

func normalizeDecodeError(err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return ErrTooLarge
	}
	// encoding/json has no exported unknown-field sentinel.
	if err != nil && strings.HasPrefix(err.Error(), "json: unknown field ") {
		return fmt.Errorf("%w: %s", ErrUnknownField,
			strings.TrimPrefix(err.Error(), "json: unknown field "))
	}
	return err
}
