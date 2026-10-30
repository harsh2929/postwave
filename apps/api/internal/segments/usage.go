// usage.go — GAP-LS-080: "which campaigns / automations / forms /
// audiences use this segment?" surface. HubSpot ships this as the
// "uses of this list" panel; we mirror.
//
// Today the schema has three references to a segment_id we can
// fold into a usage answer:
//
//   - campaigns.segment_id                       (0027) — campaign audience
//   - social_auto_reply_rules.target_segment_id  (0208) — form/social capture target
//   - audience_destinations.segment_id           (0256) — sync targets (Meta/Google)
//
// Each JOIN is best-effort: if the migration hasn't run we silently
// skip. Returns an empty array (not 404) when nothing references
// the segment.

package segments

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// UsageReference is one referencing row.
type UsageReference struct {
	Kind   string `json:"kind"` // campaign | form | audience_destination
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status,omitempty"`
	// BlocksDelete is true for a campaign that has not started sending: while
	// one uses the segment as its audience, deleting the segment is refused
	// (migration 1876). Decided by the same predicate the refusal uses, so a
	// paused campaign that already began sending does not count, whatever its
	// status says.
	BlocksDelete bool `json:"blocks_delete"`
}

// SegmentUsage GET /api/v1/segments/{id}/usage.
func (d *Deps) SegmentUsage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "segment id required"))
		return
	}
	refs, err := d.Repo.SegmentUsage(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": refs,
		"count": len(refs),
	})
}

// SegmentUsage joins against every known segment-referencing table.
// Each JOIN is wrapped in an inner block so a missing table (e.g.
// a tenant that hasn't run the 0256 lookalike migration) does not
// fail the whole response.
func (r *Repo) SegmentUsage(ctx context.Context, tenantID, segmentID string) ([]UsageReference, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := make([]UsageReference, 0, 8)

	// Campaigns.
	rows, err := tx.Query(ctx, `
SELECT id::text, name, status, COALESCE(`+campaigndispatch.EditablePredicate+`, false) FROM campaigns
WHERE tenant_id = $1::uuid AND segment_id::text = $2
ORDER BY updated_at DESC NULLS LAST
LIMIT 200`, tenantID, segmentID)
	if err == nil {
		for rows.Next() {
			var u UsageReference
			u.Kind = "campaign"
			if scanErr := rows.Scan(&u.ID, &u.Name, &u.Status, &u.BlocksDelete); scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			out = append(out, u)
		}
		rows.Close()
	}

	// Social capture rules (target_segment_id).
	rows2, err := tx.Query(ctx, `
SELECT id::text, COALESCE(name,'(rule)'), COALESCE(status,'') FROM social_auto_reply_rules
WHERE tenant_id = $1::uuid AND target_segment_id::text = $2
ORDER BY updated_at DESC NULLS LAST
LIMIT 200`, tenantID, segmentID)
	if err == nil {
		for rows2.Next() {
			var u UsageReference
			u.Kind = "social_capture"
			if err := rows2.Scan(&u.ID, &u.Name, &u.Status); err != nil {
				rows2.Close()
				return nil, err
			}
			out = append(out, u)
		}
		rows2.Close()
	}

	// Audience destinations (Meta Ads / lookalike sync). No name
	// column — synthesise from provider + external_audience_id.
	rows3, err := tx.Query(ctx, `
SELECT id::text, provider, COALESCE(external_audience_id,''), COALESCE(status,'') FROM audience_destinations
WHERE tenant_id = $1::uuid AND segment_id::text = $2
ORDER BY updated_at DESC NULLS LAST
LIMIT 200`, tenantID, segmentID)
	if err == nil {
		for rows3.Next() {
			var u UsageReference
			var provider, extID string
			u.Kind = "audience_destination"
			if err := rows3.Scan(&u.ID, &provider, &extID, &u.Status); err != nil {
				rows3.Close()
				return nil, err
			}
			if extID != "" {
				u.Name = provider + ": " + extID
			} else {
				u.Name = provider
			}
			out = append(out, u)
		}
		rows3.Close()
	}

	// Flows (FLOW-029): a journey references a segment when its id appears as a
	// value anywhere in the current graph (trigger audience, branch condition,
	// etc.). jsonb_path_exists matches exact values, not substrings.
	rows4, err := tx.Query(ctx, `
SELECT id::text, COALESCE(name,'(flow)'), COALESCE(status,'') FROM automation_journeys
WHERE tenant_id = $1::uuid
  AND (
        jsonb_path_exists(nodes, '$.** ? (@ == $v)', jsonb_build_object('v', $2::text))
     OR jsonb_path_exists(triggers, '$.** ? (@ == $v)', jsonb_build_object('v', $2::text))
  )
ORDER BY updated_at DESC NULLS LAST
LIMIT 200`, tenantID, segmentID)
	if err == nil {
		for rows4.Next() {
			var u UsageReference
			u.Kind = "flow"
			if err := rows4.Scan(&u.ID, &u.Name, &u.Status); err != nil {
				rows4.Close()
				return nil, err
			}
			out = append(out, u)
		}
		rows4.Close()
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
