// SPDX-License-Identifier: AGPL-3.0-only
//
// precondition.go — write-side optimistic concurrency (RFC 7232 If-Match
// → 412 Precondition Failed). The read side (If-None-Match → 304) lives in
// conditional.go / etag.go; this is its mutating counterpart so a client
// that loaded version N can refuse to clobber a concurrent edit.
//
// The concurrency token is a strong ETag derived from the row's updated_at
// (microsecond-resolution version counter) — no extra schema needed.

package httpcache

import (
	"net/http"
	"strings"
	"time"
)

// ConcurrencyToken derives a strong optimistic-concurrency ETag for a row
// from its updated_at timestamp. Emit it on reads; clients echo it back in
// If-Match on the next write.
func ConcurrencyToken(resource, id string, updatedAt time.Time) string {
	return ETagStrong(resource, id, updatedAt.UnixMicro())
}

// ParseIfMatch parses the request's If-Match header.
//
//	present  — the header was sent (non-empty)
//	wildcard — the header was "*" (matches any existing row)
//	token    — the header value exactly as supplied, with surrounding OWS removed
//
// Callers compare token to a strong server validator. Keeping weak prefixes and
// multi-value lists intact is deliberate: RFC 7232 requires strong comparison
// for If-Match, and this small API cannot truthfully reduce a list to one tag.
// A weak or multi-value value therefore cannot accidentally equal the current
// strong token. Callers that support lists must parse every member explicitly.
func ParseIfMatch(r *http.Request) (token string, present bool, wildcard bool) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" {
		return "", false, false
	}
	if raw == "*" {
		return "", true, true
	}
	return raw, true, false
}

// IfMatchFailed reports whether an If-Match precondition was supplied AND
// fails against currentToken. Returns false when no If-Match was sent (the
// write proceeds unconditionally, preserving legacy last-writer-wins for
// callers that don't opt in). For "*" the precondition passes iff the row
// exists (currentToken != "").
func IfMatchFailed(r *http.Request, currentToken string) bool {
	token, present, wildcard := ParseIfMatch(r)
	if !present {
		return false
	}
	if wildcard {
		return currentToken == ""
	}
	return token != currentToken
}

// WritePreconditionFailed emits a 412 with a structured error envelope
// matching the {"error":{code,message}} shape the SDKs already parse.
func WritePreconditionFailed(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPreconditionFailed)
	_, _ = w.Write([]byte(`{"error":{"code":"precondition_failed",` +
		`"message":"the resource was modified since you last loaded it; reload and retry"}}`))
}

// WritePreconditionRequired emits RFC 6585 428 for mutation surfaces that
// require an exact version token. A wildcard proves only that the resource
// exists; it does not prevent lost updates and therefore is not an acceptable
// substitute on those surfaces.
func WritePreconditionRequired(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPreconditionRequired)
	_, _ = w.Write([]byte(`{"error":{"code":"precondition_required",` +
		`"message":"an exact If-Match version from the latest response is required"}}`))
}
