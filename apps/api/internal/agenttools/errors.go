// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

// ScopeError reports the specific scopes a caller was missing. It wraps
// [ErrScopeDenied] so callers can use errors.Is(err, ErrScopeDenied) and
// still recover the list for the wire response's error data.
type ScopeError struct {
	Missing []apikeys.Scope
}

func (e *ScopeError) Error() string {
	return fmt.Sprintf("agenttools: required scope missing: %s", strings.Join(scopeStrings(e.Missing), ", "))
}

// Unwrap lets errors.Is(err, ErrScopeDenied) match.
func (e *ScopeError) Unwrap() error { return ErrScopeDenied }

// MissingScopeStrings returns the missing scopes as plain strings, for
// the JSON-RPC error `data` field.
func (e *ScopeError) MissingScopeStrings() []string { return scopeStrings(e.Missing) }

func scopeError(missing []apikeys.Scope) error {
	return &ScopeError{Missing: missing}
}
