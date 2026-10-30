// SPDX-License-Identifier: AGPL-3.0-only
//
// Package httpcache centralises the ETag + Cache-Control patterns
// already scattered across newsletter_feed.go and podcast.go so the
// rest of the API can declare cache intent instead of hand-rolling
// SHA-256 + W/"" envelopes per handler.
//
// Two tiers:
//
//   - Tier A (weak): ETagWeak / ETagFor — W/"sha256-<16hex>" of the
//     canonical JSON body. Cheap to compute, safe when the body
//     is small and the handler is fine with hashing on every hit.
//
//   - Tier B (strong): ETagStrong — "<resource>:<id>:v<version>".
//     Use when the row already carries a monotonic version column,
//     so we can skip body hashing entirely.
//
// The package is intentionally dependency-free (no chi, no db) so
// handlers can call it directly inside a hot path without dragging
// in transitive imports.
package httpcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// ETagFor returns the best ETag the caller can produce. If version
// > 0 it emits a strong Tier B tag; otherwise it falls back to a
// Tier A weak hash of the canonical JSON of body.
//
// resource and id are required for Tier B; body is required for
// Tier A. resource/id are sanitised so the tag stays a valid
// HTTP token (no quotes, no whitespace).
func ETagFor(resource, id string, version int64, body any) string {
	if version > 0 && resource != "" && id != "" {
		return ETagStrong(resource, id, version)
	}
	return ETagWeak(body)
}

// ETagWeak produces a weak ETag from the canonical-JSON marshalling
// of body. Two equal Go values always hash to the same tag because
// CanonicalJSON sorts map keys recursively.
//
// Empty / nil bodies hash to a stable "empty" sentinel so 304
// negotiation still works for legitimately empty responses.
func ETagWeak(body any) string {
	if body == nil {
		return `W/"empty"`
	}
	buf, err := CanonicalJSON(body)
	if err != nil || len(buf) == 0 {
		return `W/"empty"`
	}
	sum := sha256.Sum256(buf)
	return `W/"sha256-` + hex.EncodeToString(sum[:])[:16] + `"`
}

// ETagStrong returns "<resource>:<id>:v<version>" as a strong tag.
// Callers SHOULD only use this when the underlying row carries a
// monotonic version (or updated_at converted to a counter).
func ETagStrong(resource, id string, version int64) string {
	return `"` + sanitiseToken(resource) + `:` + sanitiseToken(id) +
		`:v` + fmt.Sprintf("%d", version) + `"`
}

// IfNoneMatch returns true and writes 304 if the request's
// If-None-Match header matches etag. The caller should return
// immediately when this returns true. ETag is always set on the
// response so downstream caches stay coherent.
func IfNoneMatch(w http.ResponseWriter, r *http.Request, etag string) bool {
	if etag == "" {
		return false
	}
	w.Header().Set("ETag", etag)
	got := r.Header.Get("If-None-Match")
	if got == "" {
		return false
	}
	// RFC 7232 §3.2 — list of entity tags separated by commas.
	for _, raw := range strings.Split(got, ",") {
		if strings.TrimSpace(raw) == etag {
			w.WriteHeader(http.StatusNotModified)
			return true
		}
	}
	return false
}

// CanonicalJSON marshals v with map keys recursively sorted so two
// semantically-equal Go values always produce byte-identical
// output. Used by ETagWeak; exposed so callers can reuse it when
// computing custom tags.
func CanonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var any2 any
	if err := json.Unmarshal(raw, &any2); err != nil {
		// Non-JSON-roundtrippable value; fall back to the
		// original marshalling.
		return raw, nil
	}
	return marshalCanonical(any2)
}

func marshalCanonical(v any) ([]byte, error) {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			kb, err := json.Marshal(k)
			if err != nil {
				return nil, err
			}
			b.Write(kb)
			b.WriteByte(':')
			vb, err := marshalCanonical(t[k])
			if err != nil {
				return nil, err
			}
			b.Write(vb)
		}
		b.WriteByte('}')
		return []byte(b.String()), nil
	case []any:
		var b strings.Builder
		b.WriteByte('[')
		for i, el := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			eb, err := marshalCanonical(el)
			if err != nil {
				return nil, err
			}
			b.Write(eb)
		}
		b.WriteByte(']')
		return []byte(b.String()), nil
	default:
		return json.Marshal(t)
	}
}

// sanitiseToken strips characters that would break the HTTP entity
// tag syntax. Cheap pass — resource/id come from internal callers
// so we only guard against accidental whitespace / quotes.
func sanitiseToken(s string) string {
	if s == "" {
		return "_"
	}
	repl := func(r rune) rune {
		switch r {
		case '"', '\\', ' ', '\t', '\r', '\n':
			return '_'
		}
		return r
	}
	return strings.Map(repl, s)
}
