// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type BlockImpactItem struct {
	TemplateID      string `json:"template_id"`
	TemplateName    string `json:"template_name"`
	PinnedVersion   string `json:"pinned_version"`
	TemplateVersion int64  `json:"template_version"`
}

// BlockImpact identifies tenant-owned templates pinned to a saved block.
// It is an impact review, not an automatic content propagation operation.
func (d *Deps) BlockImpact(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || d.ReviewPool == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "blockId")
	if _, err := uuid.Parse(id); err != nil {
		httperror.WriteValidation(w, "invalid_block_id", "block id is invalid")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.ReviewPool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var exists bool
	if err := tx.QueryRow(r.Context(), `
SELECT EXISTS(SELECT 1 FROM saved_blocks WHERE id = $1::uuid AND tenant_id = $2::uuid)`, id, tenant.ID).Scan(&exists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !exists {
		httperror.Write(w, http.StatusNotFound, "not_found", "")
		return
	}
	rows, err := tx.Query(r.Context(), `
SELECT t.id::text, t.name, COALESCE(link.value->>'version', ''), t.version
  FROM campaign_templates t
 CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(t.design_metadata->'moosewave_linked_blocks') = 'array'
        THEN t.design_metadata->'moosewave_linked_blocks' ELSE '[]'::jsonb END
 ) AS link(value)
 WHERE t.tenant_id = $1::uuid
   AND t.template_kind = 'editable'
   AND t.design_metadata ? 'moosewave_linked_blocks'
   AND t.design_metadata @> jsonb_build_object('moosewave_linked_blocks', jsonb_build_array(jsonb_build_object('id', $2)))
   AND link.value->>'id' = $2
 ORDER BY t.updated_at DESC, t.id DESC
 LIMIT 101`, tenant.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	items := []BlockImpactItem{}
	for rows.Next() {
		var item BlockImpactItem
		if err := rows.Scan(&item.TemplateID, &item.TemplateName, &item.PinnedVersion, &item.TemplateVersion); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	truncated := len(items) > 100
	if truncated {
		items = items[:100]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "truncated": truncated})
}
