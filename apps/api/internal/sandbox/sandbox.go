// SPDX-License-Identifier: AGPL-3.0-only
//
// Package sandbox provides the sandbox-mode primitives. A request is in
// sandbox when EITHER the X-Postwave-Sandbox header is "true" OR the API
// key was provisioned with sandbox_only=true. Sends in sandbox never reach
// Listmonk; instead they enqueue deterministic synthetic lifecycle events
// into sandbox_events, which the background flusher promotes into
// subscriber_events on schedule.
package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
)

// HeaderName is the request header that opts an authenticated request into
// sandbox mode regardless of API-key flag.
const HeaderName = "X-Postwave-Sandbox"

// MessageIDPrefix is the prefix used on synthetic message ids returned from
// sandbox sends. SDK consumers can detect a sandbox response by string check
// without needing to inspect headers.
const MessageIDPrefix = "sandbox_"

type ctxKey int

const (
	ctxKeySandbox ctxKey = iota + 1
)

// IsSandboxRequest reports whether the request is in sandbox mode. Returns
// true when the X-Postwave-Sandbox header is truthy OR when the apikey
// middleware has stamped the sandbox flag on the request context (which it
// does for API keys that have sandbox_only=true).
func IsSandboxRequest(r *http.Request) bool {
	if v := strings.TrimSpace(r.Header.Get(HeaderName)); v != "" {
		switch strings.ToLower(v) {
		case "true", "1", "yes":
			return true
		}
	}
	if v, ok := r.Context().Value(ctxKeySandbox).(bool); ok && v {
		return true
	}
	return false
}

// WithSandboxFlag returns r with sandbox=true on its context. The apikey
// middleware calls this when it resolves a key whose sandbox_only column is
// set. Exposed as a function so callers do not need to know the key type.
func WithSandboxFlag(r *http.Request) *http.Request {
	return r.WithContext(WithFlag(r.Context()))
}

// WithFlag returns ctx with the sandbox flag set. Useful for tests that
// build a context directly without an HTTP request.
func WithFlag(ctx context.Context) context.Context {
	return context.WithValue(ctx, ctxKeySandbox, true)
}

// IsFlagged reports whether ctx carries the sandbox flag. This is the
// context-level counterpart to IsSandboxRequest, for callers (e.g. the
// agenttools execution chokepoint) that work off a context rather than an
// *http.Request. Reading from the same context key the middleware stamps
// means a sandbox-only key cannot bypass simulation just because a caller
// forgot to denormalize the flag into its own struct.
func IsFlagged(ctx context.Context) bool {
	v, ok := ctx.Value(ctxKeySandbox).(bool)
	return ok && v
}

// FakeMessageID returns an opaque, prefixed message id. Each call produces a
// fresh id (8 random hex bytes) so callers can correlate logs without
// colliding.
func FakeMessageID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return MessageIDPrefix + hex.EncodeToString(b[:])
}
