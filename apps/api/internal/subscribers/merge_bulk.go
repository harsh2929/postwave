// Subscribers bulk merge — runs multiple primary/duplicate merges in a
// single round-trip. Each pair runs in its own transaction so a
// per-pair failure is isolated and the others still complete. The
// response carries per-pair status so the operator can retry the
// failures without re-running the successes.

package subscribers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// MaxBulkMergePairs caps a single bulk-merge call. Higher than the
// duplicate-scanner cap (100) and well under the generic bulk-write cap
// (10k) because every pair runs its own transaction and audit row.
const MaxBulkMergePairs = 500

// BulkMergeInput is the request body for POST /api/v1/subscribers/merge/bulk.
type BulkMergeInput struct {
	Pairs []MergeInput `json:"pairs"`
}

// BulkMergeItemResult is one pair's outcome.
type BulkMergeItemResult struct {
	PrimaryID   string       `json:"primary_id"`
	DuplicateID string       `json:"duplicate_id"`
	Status      string       `json:"status"` // "merged" | "failed"
	Error       string       `json:"error,omitempty"`
	Result      *MergeResult `json:"result,omitempty"`
}

// BulkMergeResult is the wire shape returned by the endpoint.
type BulkMergeResult struct {
	Merged int                   `json:"merged"`
	Failed int                   `json:"failed"`
	Items  []BulkMergeItemResult `json:"items"`
}

// MountBulkMergeRoutes registers POST /api/v1/subscribers/merge/bulk.
// Wrapped with observability.RecordSurfaceFunc so pw_subscribers_bulk_merge_total +
// pw_subscribers_duration_seconds are emitted (Phase 4
// p4d-recordsurface-wire-subscribers).
func MountBulkMergeRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/merge/bulk",
			observability.RecordSurfaceFunc("subscribers", "bulk_merge", d.BulkMergeHandler))
}

// BulkMergeHandler POST /api/v1/subscribers/merge/bulk
func (d *Deps) BulkMergeHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in BulkMergeInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		writeJSON(w, httpbody.StatusCode(err), errEnv(httpbody.ErrorCode(err), httpbody.PublicMessage(err)))
		return
	}
	if len(in.Pairs) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("empty_pairs", "pairs required"))
		return
	}
	if len(in.Pairs) > MaxBulkMergePairs {
		writeJSON(w, http.StatusBadRequest, errEnv("too_many_pairs", "too many pairs"))
		return
	}

	meta := middleware.AuditMetaFromRequest(r)
	meta.TenantID = t.ID

	out := BulkMergeResult{Items: make([]BulkMergeItemResult, 0, len(in.Pairs))}
	for _, p := range in.Pairs {
		p.AuditMeta = meta
		p.Bulk = true
		item := BulkMergeItemResult{PrimaryID: p.PrimaryID, DuplicateID: p.DuplicateID}
		res, err := d.Repo.Merge(r.Context(), t.ID, p)
		if err != nil {
			item.Status = "failed"
			if errors.Is(err, ErrSameSubscriber) {
				item.Error = "same_subscriber"
			} else if errors.Is(err, ErrMergePreconditionRequired) {
				item.Error = "precondition_required"
			} else if errors.Is(err, ErrPreconditionFailed) {
				item.Error = "precondition_failed"
			} else if errors.Is(err, ErrErasureBlocked) {
				item.Error = "erasure_blocked"
			} else if errors.Is(err, ErrMergeConflict) {
				item.Error = "merge_conflict"
			} else {
				// Unknown error from the merge path (could be a pgx/DB
				// error whose text is sensitive). Log the raw text
				// server-side with tenant_id+request_id enrichment, then
				// return the stable generic code/message to the client
				// — same envelope contract httperror.WriteInternal uses
				// for direct HTTP writes.
				if d.Logger != nil {
					d.Logger.LogAttrs(r.Context(), slog.LevelError,
						"subscribers.bulk_merge.pair_failed",
						slog.String("tenant_id", t.ID),
						slog.String("primary_id", p.PrimaryID),
						slog.String("duplicate_id", p.DuplicateID),
						slog.String("err", err.Error()),
					)
				}
				item.Error = httperror.CodeInternal
			}
			out.Failed++
			out.Items = append(out.Items, item)
			continue
		}
		item.Status = "merged"
		item.Result = res
		out.Merged++
		out.Items = append(out.Items, item)

		// SUB-119: bridge each successful bulk-merge pair to the SSE Bus as
		// subscriber.merged, mirroring the single-merge handler so the
		// desktop's "subscriber.*" wildcard hears bulk merges too. The
		// outbound webhook is fired per pair inside Repo.Merge. nil-safe.
		d.emit(t.ID, EventSubscriberMerged, map[string]any{
			"primary_id":   p.PrimaryID,
			"duplicate_id": p.DuplicateID,
			"bulk":         true,
		})
	}

	writeJSON(w, http.StatusOK, out)
}
