package tags

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// TagGroup is the canonical record for a tag namespace. tags.group_id
// FKs back to this row; an FK ON DELETE SET NULL means deleting the
// group leaves the tags but unbuckets them.
type TagGroup struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color,omitempty"`
	SortOrder int       `json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
}

// GroupRepo is the tenant-scoped CRUD repo for tag_groups.
type GroupRepo struct {
	Pool *db.Pool
}

func (r *GroupRepo) List(ctx context.Context, tenantID string) ([]TagGroup, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, COALESCE(color, ''), sort_order, created_at
FROM tag_groups
WHERE tenant_id = $1::uuid
ORDER BY sort_order, name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagGroup{}
	for rows.Next() {
		var g TagGroup
		if err := rows.Scan(&g.ID, &g.Name, &g.Color, &g.SortOrder, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GroupCreateInput is the body for POST /api/v1/tag-groups.
type GroupCreateInput struct {
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder int    `json:"sort_order"`
}

const tagGroupSortOrderLimit = 1_000_000

func (r *GroupRepo) Create(ctx context.Context, tenantID string, in GroupCreateInput) (*TagGroup, error) {
	var err error
	if in.Name, err = normalizeTagName(in.Name); err != nil {
		return nil, err
	}
	if in.Color, err = normalizeTagColor(in.Color); err != nil {
		return nil, err
	}
	if in.SortOrder < 0 || in.SortOrder > tagGroupSortOrderLimit {
		return nil, errors.New("sort_order is outside the supported range")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var g TagGroup
	err = tx.QueryRow(ctx, `
INSERT INTO tag_groups (tenant_id, name, color, sort_order)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4)
RETURNING id::text, name, COALESCE(color, ''), sort_order, created_at`,
		tenantID, in.Name, in.Color, in.SortOrder,
	).Scan(&g.ID, &g.Name, &g.Color, &g.SortOrder, &g.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return &g, tx.Commit(ctx)
}

// GroupUpdateInput is the body for PATCH /api/v1/tag-groups/{id}.
type GroupUpdateInput struct {
	Name      *string `json:"name,omitempty"`
	Color     *string `json:"color,omitempty"`
	SortOrder *int    `json:"sort_order,omitempty"`
}

func (r *GroupRepo) Update(ctx context.Context, tenantID, id string, in GroupUpdateInput) (*TagGroup, error) {
	if in.Name != nil {
		value, err := normalizeTagName(*in.Name)
		if err != nil {
			return nil, err
		}
		in.Name = &value
	}
	if in.Color != nil {
		value, err := normalizeTagColor(*in.Color)
		if err != nil {
			return nil, err
		}
		in.Color = &value
	}
	if in.SortOrder != nil && (*in.SortOrder < 0 || *in.SortOrder > tagGroupSortOrderLimit) {
		return nil, errors.New("sort_order is outside the supported range")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var g TagGroup
	err = tx.QueryRow(ctx, `
UPDATE tag_groups
SET name       = COALESCE($3, name),
    color      = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE color END,
    sort_order = COALESCE($6, sort_order)
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, name, COALESCE(color, ''), sort_order, created_at`,
		tenantID, id, in.Name, in.Color != nil, stringValue(in.Color), in.SortOrder,
	).Scan(&g.ID, &g.Name, &g.Color, &g.SortOrder, &g.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &g, tx.Commit(ctx)
}

// GetByID returns one tag_group by id; ErrNotFound when absent. Used
// by the handlers to snapshot the before-state for audit emits
// (p4d-audit-emit-wire-tags) so the audit_log row carries a full
// {before, after} diff on update/delete.
func (r *GroupRepo) GetByID(ctx context.Context, tenantID, id string) (*TagGroup, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var g TagGroup
	err = tx.QueryRow(ctx, `
SELECT id::text, name, COALESCE(color, ''), sort_order, created_at
  FROM tag_groups
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).
		Scan(&g.ID, &g.Name, &g.Color, &g.SortOrder, &g.CreatedAt)
	if err != nil {
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &g, tx.Commit(ctx)
}

func (r *GroupRepo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tag_groups WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// GroupDeps wires the GroupRepo into chi. Deps.MountRoutes delegates here
// when production composition supplies its GroupRepo.
type GroupDeps struct {
	Repo *GroupRepo
	// Logger, when non-nil, is used by httperror.WriteInternal to log
	// the raw error text server-side (with tenant_id + request_id
	// enrichment) while keeping the client response generic. Optional —
	// leaving it nil is safe in tests; production wires the shared
	// slog instance.
	Logger *slog.Logger
}

// repoPool — sibling of Deps.repoPool. Returns the GroupRepo pool so
// the audit emits can hand a non-nil pool to audit.EmitOrLog. Nil
// when GroupDeps is built without a Repo (handler-only tests); the
// audit helper short-circuits cleanly on nil pool.
func (d *GroupDeps) repoPool() *db.Pool {
	if d == nil || d.Repo == nil {
		return nil
	}
	return d.Repo.Pool
}

// fetchGroupForAudit is the GroupRepo analogue of fetchTagForAudit:
// best-effort before-state snapshot for the update/delete audit emits.
// Returns nil on any error (audit row still fires, just without a
// before block) so the mutation handler never blocks on it.
func (d *GroupDeps) fetchGroupForAudit(ctx context.Context, tenantID, id string) *TagGroup {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return nil
	}
	g, err := d.Repo.GetByID(ctx, tenantID, id)
	if err != nil {
		return nil
	}
	return g
}

func (d *GroupDeps) MountRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	write := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	r.With(read).Get("/api/v1/tag-groups", d.List)
	// p4d-recordsurface-wire-others: tag-groups share the `tags` surface
	// namespace — same dashboard, distinct action labels.
	r.With(write).Post("/api/v1/tag-groups", observability.RecordSurfaceFunc("tags", "group_create", d.Create))
	r.With(write).Patch("/api/v1/tag-groups/{id}", observability.RecordSurfaceFunc("tags", "group_update", d.Update))
	r.With(write).Delete("/api/v1/tag-groups/{id}", observability.RecordSurfaceFunc("tags", "group_delete", d.Delete))
}

const tagGroupJSONMaxBodyBytes int64 = 32 << 10

func (d *GroupDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeGroupJSON(w, http.StatusUnauthorized, groupErrEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeGroupJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *GroupDeps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeGroupJSON(w, http.StatusUnauthorized, groupErrEnv("no_tenant", ""))
		return
	}
	var in GroupCreateInput
	if err := httpbody.DecodeJSON(w, r, tagGroupJSONMaxBodyBytes, &in); err != nil {
		writeGroupJSON(w, httpbody.StatusCode(err), groupErrEnv(httpbody.ErrorCode(err), httpbody.PublicMessage(err)))
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	var err error
	if in.Name, err = normalizeTagName(in.Name); err != nil {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_name", err.Error()))
		return
	}
	if in.Color, err = normalizeTagColor(in.Color); err != nil {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_color", err.Error()))
		return
	}
	if in.SortOrder < 0 || in.SortOrder > tagGroupSortOrderLimit {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_sort_order", "sort_order is outside the supported range"))
		return
	}
	g, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			writeGroupJSON(w, http.StatusConflict, groupErrEnv("name_taken", err.Error()))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// p4d-audit-emit-wire-tags — one audit row per mutation.
	audit.EmitOrLog(r.Context(), d.repoPool(), "tag_group.create", "tag_group", g.ID, nil, g, nil)
	writeGroupJSON(w, http.StatusCreated, g)
}

func (d *GroupDeps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeGroupJSON(w, http.StatusUnauthorized, groupErrEnv("no_tenant", ""))
		return
	}
	var in GroupUpdateInput
	if err := httpbody.DecodeJSON(w, r, tagGroupJSONMaxBodyBytes, &in); err != nil {
		writeGroupJSON(w, httpbody.StatusCode(err), groupErrEnv(httpbody.ErrorCode(err), httpbody.PublicMessage(err)))
		return
	}
	if in.Name == nil && in.Color == nil && in.SortOrder == nil {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("empty_patch", "at least one field is required"))
		return
	}
	if in.Name != nil {
		v, err := normalizeTagName(*in.Name)
		if err != nil {
			writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_name", err.Error()))
			return
		}
		in.Name = &v
	}
	if in.Color != nil {
		v, err := normalizeTagColor(*in.Color)
		if err != nil {
			writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_color", err.Error()))
			return
		}
		in.Color = &v
	}
	if in.SortOrder != nil && (*in.SortOrder < 0 || *in.SortOrder > tagGroupSortOrderLimit) {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_sort_order", "sort_order is outside the supported range"))
		return
	}
	id, err := normalizeGroupPathID(chi.URLParam(r, "id"))
	if err != nil {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_id", err.Error()))
		return
	}
	// Snapshot the before-state for the audit emit. Best-effort: a
	// read miss leaves before=nil; the audit row still fires.
	before := d.fetchGroupForAudit(r.Context(), t.ID, id)
	g, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrConflict):
			writeGroupJSON(w, http.StatusConflict, groupErrEnv("name_taken", err.Error()))
		case errors.Is(err, ErrNotFound):
			writeGroupJSON(w, http.StatusNotFound, groupErrEnv("not_found", ""))
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	audit.EmitOrLog(r.Context(), d.repoPool(), "tag_group.update", "tag_group", g.ID, before, g, nil)
	writeGroupJSON(w, http.StatusOK, g)
}

func (d *GroupDeps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeGroupJSON(w, http.StatusUnauthorized, groupErrEnv("no_tenant", ""))
		return
	}
	id, err := normalizeGroupPathID(chi.URLParam(r, "id"))
	if err != nil {
		writeGroupJSON(w, http.StatusBadRequest, groupErrEnv("invalid_id", err.Error()))
		return
	}
	before := d.fetchGroupForAudit(r.Context(), t.ID, id)
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeGroupJSON(w, http.StatusNotFound, groupErrEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	audit.EmitOrLog(r.Context(), d.repoPool(), "tag_group.delete", "tag_group", id, before, nil, nil)
	writeGroupJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func groupErrEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func normalizeGroupPathID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", errors.New("id must be a UUID")
	}
	return parsed.String(), nil
}

func writeGroupJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
