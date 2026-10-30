// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// verificationHTTPErrorClass reduces every unexpected verification HTTP
// failure to a closed, non-PII vocabulary. Database, provider, and constraint
// errors can contain a tenant identifier, recipient address, credential label,
// provider URL, or rejected row detail; none of those values may reach the
// process log merely because a handler returned a generic 500.
func verificationHTTPErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, ErrCacheUnavailable):
		return "cache_unavailable"
	case errors.Is(err, errInvalidStoredJob),
		errors.Is(err, errInvalidStoredJobResult),
		errors.Is(err, errStoredHealthVerificationInvalid),
		errors.Is(err, errInvalidStoredVerificationPolicy):
		return "stored_contract_invalid"
	default:
		return "internal_or_dependency"
	}
}

// writeVerificationInternal is the only verification HTTP path allowed to
// call httperror.WriteInternal. Passing the closed class instead of the source
// error preserves the shared generic response/request-id behavior without
// copying provider, database, tenant, or recipient detail into logs.
func (d *Deps) writeVerificationInternal(w http.ResponseWriter, r *http.Request, err error) {
	httperror.WriteInternal(w, d.Logger, errors.New(verificationHTTPErrorClass(err)), r.Context())
}
