// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk.go — Phase 1 cross-cutting `p1-bulk-endpoints` item.
//
// Adds POST /api/v1/assets/bulk-delete. The dashboard "select N rows
// and trash them" path was previously a parallel-fanout of N single
// DELETEs from the client (one HTTP request per row); that path is
// linear in N and a 200-row trash op generated 200 individual audit
// rows and 200 HTTP requests. This endpoint folds that into one bounded HTTP
// request while retaining a short tenant transaction per asset, so one row's
// result does not poison the remaining per-id outcomes.
//
// Shape — request:
//   {"items":[{"id":uuid,"expected_version":N}...], "force": bool?}.
// Every row is version-bound so a delayed bulk action cannot delete a newer
// representation than the operator selected.
//
// `skipped` covers two cases the caller can re-render as informational:
//   * not_found  — id missing from the tenant (already deleted / wrong tenant)
//   * has_references with force=false — current behaviour of the single-row
//     DELETE; this preserves that gate at bulk too so a misclick can't
//     trash a referenced asset in one shot.
//
// `failed` is the structured per-id error list — a hard storage / DB
// failure on row i doesn't poison the rest of the batch.
//
// Cap matches the rest of the platform's bulk endpoints: BulkMaxIDs=1000
// per request keeps aggregate database work bounded and the response under the
// HTTP buffer.

package assets

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// BulkMaxIDs caps a single bulk-delete call. Matches the
// tags / suppressions bulk ceilings so the audit + idempotency
// budget per request is consistent across the platform.
const BulkMaxIDs = 1000

// bulkDeleteJSONMaxBodyBytes — 1k uuids @ ~37 bytes each plus envelope
// fits well under 64 KiB.
const bulkDeleteJSONMaxBodyBytes int64 = 128 << 10

// bulkDeleteInput is the body for POST /api/v1/assets/bulk-delete.
type bulkDeleteItem struct {
	ID              string `json:"id"`
	ExpectedVersion int64  `json:"expected_version"`
}

type bulkDeleteInput struct {
	Items []bulkDeleteItem `json:"items"`
	Force bool             `json:"force,omitempty"`
}

// BulkDeleteFailure is one per-id failure surfaced in the response.
// The dashboard renders this as a per-row toast so the operator can
// retry just the misses instead of the whole batch.
type BulkDeleteFailure struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// BulkDeleteResponse is the wire shape. Empty `failed` is rendered as
// an empty array, never null, so the dashboard's reducer can rely on
// .map() existing.
type BulkDeleteResponse struct {
	Deleted  int                 `json:"deleted"`
	Skipped  int                 `json:"skipped"`
	Receipts []DeleteReceipt     `json:"receipts"`
	Failed   []BulkDeleteFailure `json:"failed"`
}

type DeleteReceipt struct {
	OK      bool   `json:"ok"`
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

// MountBulkRoutes registers the bulk endpoints. Scoped to write_campaigns
// so the same gate as the single DELETE applies; the route is wrapped
// by the caller-side idempotency middleware in main.go.
//
// Kept on a separate mount fn so a downstream tenant can disable bulk
// destructive ops independently of the single-row DELETE.
func (d *Deps) MountBulkRoutes(r chi.Router) {
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(write).Post("/api/v1/assets/bulk-delete", d.BulkDelete)
}

// BulkDelete POST /api/v1/assets/bulk-delete — soft-delete N assets.
//
// Behaviour mirrors the single-row Delete handler:
//   - Missing rows count as `skipped` (not an error — they're already gone).
//   - Rows with live referrers and force=false count as `skipped` with
//     reason "has_references"; pass {force:true} to override.
//   - Real database failures populate `failed` per-id without
//     poisoning the rest of the batch.
//
// The handler returns 200 even when some ids failed so the caller can
// render per-id outcomes; a top-level 5xx is reserved for cases where
// nothing was attempted (no tenant, body too large, etc).
func (d *Deps) BulkDelete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	// Parse + validate the body FIRST so structural errors (missing ids,
	// oversized batch, malformed JSON) surface as the relevant 4xx
	// regardless of whether the repo is wired. Returning 503 from a
	// malformed payload would hide the client bug.
	var in bulkDeleteInput
	if err := httpbody.DecodeJSON(w, r, bulkDeleteJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Items) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_items", "items required"))
		return
	}
	if len(in.Items) > BulkMaxIDs {
		writeJSON(w, http.StatusRequestEntityTooLarge,
			errEnv("too_many_items", "items exceeds 1000 per request"))
		return
	}
	items, invalid := canonicalAssetVersionedItems(in.Items)
	if invalid != "" {
		writeJSON(w, http.StatusBadRequest,
			errEnv("invalid_item", invalid))
		return
	}
	if !d.canDelete() {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	resp := BulkDeleteResponse{Receipts: []DeleteReceipt{}, Failed: []BulkDeleteFailure{}}
	for _, item := range items {
		// Reference gate is per-id so a single referenced row doesn't
		// block the whole batch. Replicates the single-row Delete
		// behaviour exactly so the caller can use the same `force`
		// confirmation modal.
		version, _, _, err := d.checkedDelete(r.Context(), t.ID, item.ID, item.ExpectedVersion, in.Force)
		if err != nil {
			if errors.Is(err, ErrHasReferences) {
				resp.Skipped++
				resp.Failed = append(resp.Failed, BulkDeleteFailure{ID: item.ID, Reason: "has_references"})
				continue
			}
			if errors.Is(err, ErrNotFound) {
				resp.Skipped++
				resp.Failed = append(resp.Failed, BulkDeleteFailure{ID: item.ID, Reason: "not_found"})
				continue
			}
			if errors.Is(err, ErrStale) {
				resp.Skipped++
				resp.Failed = append(resp.Failed, BulkDeleteFailure{ID: item.ID, Reason: "stale_version"})
				continue
			}
			resp.Failed = append(resp.Failed, BulkDeleteFailure{
				ID:     item.ID,
				Reason: "internal_error",
			})
			continue
		}
		resp.Deleted++
		resp.Receipts = append(resp.Receipts, DeleteReceipt{OK: true, ID: item.ID, Version: version})
	}
	writeJSON(w, http.StatusOK, resp)
}

// canonicalAssetIDs validates strict RFC 4122 text, normalizes case, and
// de-duplicates while preserving the first-seen order.
func canonicalAssetIDs(in []string) ([]string, string) {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		trimmed := strings.TrimSpace(raw)
		parsed, err := uuid.Parse(trimmed)
		if err != nil || len(trimmed) != 36 || parsed.String() != strings.ToLower(trimmed) {
			return nil, raw
		}
		id := parsed.String()
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, ""
}

func canonicalAssetVersionedItems(in []bulkDeleteItem) ([]bulkDeleteItem, string) {
	seen := make(map[string]struct{}, len(in))
	out := make([]bulkDeleteItem, 0, len(in))
	for _, item := range in {
		trimmed := strings.TrimSpace(item.ID)
		parsed, err := uuid.Parse(trimmed)
		if err != nil || len(trimmed) != 36 || parsed.String() != strings.ToLower(trimmed) {
			return nil, "each item id must be a canonical lowercase UUID"
		}
		if item.ExpectedVersion <= 0 {
			return nil, "each item expected_version must be a positive integer"
		}
		if _, duplicate := seen[trimmed]; duplicate {
			return nil, "item ids must be unique"
		}
		seen[trimmed] = struct{}{}
		out = append(out, bulkDeleteItem{ID: trimmed, ExpectedVersion: item.ExpectedVersion})
	}
	return out, ""
}
