// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_delete.go — the compatibility POST /api/v1/tags/bulk-delete route.
// It validates the bounded request envelope, then fails closed until an
// authoritative impact plan and idempotent receipt contract exist.
package tags

import (
	"context"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// BulkDeleteMaxIDs caps a single bulk-delete call. Mirrors
// BulkMaxSubscribers — both run inside a single tenant-scoped tx, and
// the same per-request work budget applies.
const BulkDeleteMaxIDs = 1000

// BulkDeleteInput is the JSON body for POST /api/v1/tags/bulk-delete.
type BulkDeleteInput struct {
	IDs []string `json:"ids"`
}

// BulkDeleteResult is retained for source compatibility with callers that
// compiled against the former proposal. No supported path returns it while
// permanent deletion is disabled.
type BulkDeleteResult struct {
	Deleted int `json:"deleted"`
	Skipped int `json:"skipped"`
}

// BulkDelete validates the repository-level size envelope and refuses the
// unsafe mutation without opening a transaction.
func (r *Repo) BulkDelete(ctx context.Context, tenantID string, ids []string) (BulkDeleteResult, error) {
	ids = dedupeNonEmpty(ids)
	if len(ids) == 0 {
		return BulkDeleteResult{}, nil
	}
	if len(ids) > BulkDeleteMaxIDs {
		return BulkDeleteResult{}, ErrBulkTooLarge
	}
	return BulkDeleteResult{}, ErrUnsafeMutation
}

const bulkDeleteJSONMaxBodyBytes int64 = 64 << 10

// BulkDelete POST /api/v1/tags/bulk-delete.
//
// Validation order (mirrors bulkHandler):
//  1. tenant — 401 without it
//  2. repo wired — 503 if not (handler-only tests pass &Deps{})
//  3. payload decode + ids non-empty — 400
//  4. size cap — 413
//  5. stable 409; no repository mutation or audit claim of deletion
func (d *Deps) BulkDelete(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable",
			"tags repo not wired"))
		return
	}
	var in BulkDeleteInput
	if err := httpbody.DecodeJSON(w, r, bulkDeleteJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// Validate IDs are non-empty before the size check so an empty
	// payload produces missing_ids (test expectation) not too_many_ids.
	cleaned := dedupeNonEmpty(in.IDs)
	if len(cleaned) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_ids",
			"ids must be a non-empty array"))
		return
	}
	if len(cleaned) > BulkDeleteMaxIDs {
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("too_many_ids",
			"ids exceeds bulk-delete cap"))
		return
	}
	writeJSON(w, http.StatusConflict, errEnv("unsafe_mutation_disabled",
		"Bulk deletion requires an authoritative impact plan and idempotent receipt; no tags were changed."))
}
