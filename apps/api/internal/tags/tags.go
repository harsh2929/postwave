// Package tags owns the tenant-scoped tag registry. subscriber_tags is the
// canonical membership store; subscribers.tags is a bounded compatibility
// projection maintained transactionally by migration 1774.
package tags

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

var (
	ErrConflict           = errors.New("tags: name already in use")
	ErrNotFound           = errors.New("tags: not found")
	ErrInvalidGroup       = errors.New("tags: group does not belong to this tenant")
	ErrPreconditionFailed = errors.New("tags: version precondition failed")
	ErrUnsafeMutation     = errors.New("tags: destructive mutation requires a planned idempotent receipt")
)

const (
	TagNameMaxRunes        = 64
	TagDescriptionMaxRunes = 1024
)

var tagHexColor = regexp.MustCompile(`^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$`)

var tagPalette = map[string]struct{}{
	"slate": {}, "teal": {}, "sky": {}, "indigo": {},
	"violet": {}, "rose": {}, "amber": {}, "lime": {},
}

// Tag is the complete tenant-visible registry record. ETag is derived from
// Version and is repeated in the response header for singular writes.
type Tag struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Color       string     `json:"color,omitempty"`
	Description string     `json:"description"`
	GroupID     string     `json:"group_id,omitempty"`
	CreatedBy   string     `json:"created_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	UpdatedBy   string     `json:"updated_by,omitempty"`
	ArchivedAt  *time.Time `json:"archived_at,omitempty"`
	PII         bool       `json:"pii"`
	Version     int64      `json:"version"`
	ETag        string     `json:"etag"`
	// SubscriberCount is the number of subscribers currently carrying this
	// tag, counted from the canonical subscriber_tags join. It is a pointer
	// so "not requested" (nil, omitted from JSON) stays distinguishable from
	// "requested and genuinely zero" (0). Populated only when the caller
	// asks for it — see ListFilteredWithCounts / ?with_counts=true.
	SubscriberCount *int64 `json:"subscriber_count,omitempty"`
}

type Repo struct {
	Pool    *db.Pool
	History *History
}

type tagScanner interface {
	Scan(dest ...any) error
}

func scanTag(row tagScanner) (*Tag, error) {
	var out Tag
	if err := row.Scan(
		&out.ID, &out.Name, &out.Color, &out.Description, &out.GroupID,
		&out.CreatedBy, &out.CreatedAt, &out.UpdatedAt, &out.UpdatedBy,
		&out.ArchivedAt, &out.PII, &out.Version,
	); err != nil {
		return nil, err
	}
	out.ETag = httpcache.ETagStrong("tag", out.ID, out.Version)
	return &out, nil
}

// scanTagWithCount scans the same projection as scanTag plus the trailing
// subscriber_count column. Kept separate (rather than a variadic scanTag)
// so the column count is checked by the compiler at each call site.
func scanTagWithCount(row tagScanner) (*Tag, error) {
	var out Tag
	var count int64
	if err := row.Scan(
		&out.ID, &out.Name, &out.Color, &out.Description, &out.GroupID,
		&out.CreatedBy, &out.CreatedAt, &out.UpdatedAt, &out.UpdatedBy,
		&out.ArchivedAt, &out.PII, &out.Version, &count,
	); err != nil {
		return nil, err
	}
	out.ETag = httpcache.ETagStrong("tag", out.ID, out.Version)
	out.SubscriberCount = &count
	return &out, nil
}

// List preserves the original repository API for internal callers.
func (r *Repo) List(ctx context.Context, tenantID, q string) ([]Tag, error) {
	return r.ListFiltered(ctx, tenantID, q, "", false)
}

// ListFiltered returns live rows by default, with optional exact group and
// archive filters. Empty slices encode as [] rather than null.
func (r *Repo) ListFiltered(ctx context.Context, tenantID, q, groupID string, includeArchived bool) ([]Tag, error) {
	return r.ListFilteredWithCounts(ctx, tenantID, q, groupID, includeArchived, false)
}

// listSelectColumns is the shared projection for both the plain and the
// usage-counted list. Kept as one literal so the two queries cannot drift
// out of the column order scanTag expects.
const listSelectColumns = `t.id::text, t.name::text, COALESCE(t.color, ''), COALESCE(t.description, ''),
       COALESCE(t.group_id::text, ''), COALESCE(t.created_by::text, ''),
       t.created_at, t.updated_at, COALESCE(t.updated_by::text, ''), t.archived_at,
       t.pii, t.version`

const listFilterClause = ` WHERE t.tenant_id = $1::uuid
   AND ($2 = '' OR t.name ILIKE '%' || $2 || '%')
   AND ($3::boolean OR t.archived_at IS NULL)
   AND ($4 = '' OR t.group_id = $4::uuid)
 ORDER BY lower(t.name::text), t.id`

// ListFilteredWithCounts is ListFiltered plus an optional per-tag
// subscriber count (MAP#58 — the registry was previously readable with no
// sense of scale, so a client could not tell a 40k-subscriber tag from a
// dead one).
//
// The count is opt-in rather than always-on because it is a second pass
// over subscriber_tags: on a large tenant that table is the widest join in
// the schema, and the existing callers of the plain list (pickers,
// autocomplete) do not need it. When withCounts is false the emitted SQL is
// byte-identical in shape to the historical query — no join, no aggregate.
//
// subscriber_tags is the canonical membership store (migration 0290); the
// legacy subscribers.tags text[] projection is deliberately NOT counted,
// because it is a bounded compatibility mirror and would double-count.
// The aggregate is grouped once for the whole tenant and joined, rather
// than run as a correlated per-row subquery, so the cost is one index-only
// pass of subscriber_tags_tag_idx (tenant_id, tag_id, applied_at DESC)
// regardless of how many tags the tenant has.
func (r *Repo) ListFilteredWithCounts(ctx context.Context, tenantID, q, groupID string, includeArchived, withCounts bool) ([]Tag, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	query := `
SELECT ` + listSelectColumns + `
  FROM tags t` + listFilterClause
	if withCounts {
		query = `
SELECT ` + listSelectColumns + `,
       COALESCE(c.n, 0)::bigint AS subscriber_count
  FROM tags t
  LEFT JOIN (
        SELECT st.tag_id, count(*)::bigint AS n
          FROM subscriber_tags st
         WHERE st.tenant_id = $1::uuid
         GROUP BY st.tag_id
       ) c ON c.tag_id = t.id` + listFilterClause
	}

	rows, err := tx.Query(ctx, query, tenantID, q, includeArchived, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Tag, 0)
	for rows.Next() {
		var t *Tag
		var err error
		if withCounts {
			t, err = scanTagWithCount(rows)
		} else {
			t, err = scanTag(rows)
		}
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateInput is the versioned POST contract used by the desktop. Empty
// group_id means ungrouped; pii is explicit and defaults false.
type CreateInput struct {
	Name        string `json:"name"`
	Color       string `json:"color,omitempty"`
	Description string `json:"description,omitempty"`
	GroupID     string `json:"group_id,omitempty"`
	PII         bool   `json:"pii,omitempty"`
	ActorID     string `json:"-"`
}

func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Tag, error) {
	var err error
	if in.Name, err = normalizeTagName(in.Name); err != nil {
		return nil, err
	}
	if in.Color, err = normalizeTagColor(in.Color); err != nil {
		return nil, err
	}
	if in.Description, err = normalizeTagDescription(in.Description); err != nil {
		return nil, err
	}
	if in.GroupID, err = normalizeTagGroup(in.GroupID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO tags
       (tenant_id, name, color, description, group_id, pii, created_by, updated_by)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4, NULLIF($5, '')::uuid, $6,
        NULLIF($7, '')::uuid, NULLIF($7, '')::uuid)
RETURNING id::text, name::text, COALESCE(color, ''), COALESCE(description, ''),
          COALESCE(group_id::text, ''), COALESCE(created_by::text, ''),
          created_at, updated_at, COALESCE(updated_by::text, ''), archived_at,
          pii, version`, tenantID, in.Name, in.Color, in.Description,
		in.GroupID, in.PII, in.ActorID)
	tag, err := scanTag(row)
	if err != nil {
		switch {
		case isUniqueViolation(err):
			return nil, ErrConflict
		case isForeignKeyViolation(err):
			return nil, ErrInvalidGroup
		}
		return nil, err
	}
	if r.History != nil {
		if err := r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID: tenantID, TagID: tag.ID, TagName: tag.Name,
			Action: ActionTagCreated, Source: "tags_api", ActorID: in.ActorID,
		}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return tag, nil
}

// UpdateInput is the body for PATCH /api/v1/tags/{id}. All fields
// are optional; nil means "leave alone".
type UpdateInput struct {
	Name            *string `json:"name,omitempty"`
	Color           *string `json:"color,omitempty"`
	Description     *string `json:"description,omitempty"`
	GroupID         *string `json:"group_id,omitempty"`
	PII             *bool   `json:"pii,omitempty"`
	ActorID         string  `json:"-"`
	ExpectedVersion int64   `json:"-"`
}

// Update mutates the supplied fields. PR 1 — closes the gap where
// the frontend was calling PATCH with no backend route mounted.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Tag, error) {
	var err error
	if in.ExpectedVersion <= 0 {
		return nil, errors.New("tags: expected version must be positive")
	}
	if in.Name != nil {
		value, normalizeErr := normalizeTagName(*in.Name)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		in.Name = &value
	}
	if in.Color != nil {
		value, normalizeErr := normalizeTagColor(*in.Color)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		in.Color = &value
	}
	if in.Description != nil {
		value, normalizeErr := normalizeTagDescription(*in.Description)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		in.Description = &value
	}
	if in.GroupID != nil {
		value, normalizeErr := normalizeTagGroup(*in.GroupID)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		in.GroupID = &value
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE tags
SET name        = COALESCE($3, name),
	    color       = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE color END,
	    description = COALESCE($6, description),
	    group_id    = CASE WHEN $7::boolean THEN NULLIF($8, '')::uuid ELSE group_id END,
	    pii         = COALESCE($9, pii),
	    updated_by  = NULLIF($10, '')::uuid
WHERE tenant_id = $1::uuid AND id = $2::uuid AND version = $11
RETURNING id::text, name::text, COALESCE(color, ''), COALESCE(description, ''),
          COALESCE(group_id::text, ''), COALESCE(created_by::text, ''),
          created_at, updated_at, COALESCE(updated_by::text, ''), archived_at,
          pii, version`, tenantID, id, in.Name, in.Color != nil, stringValue(in.Color),
		in.Description, in.GroupID != nil, stringValue(in.GroupID), in.PII,
		in.ActorID, in.ExpectedVersion)
	tag, err := scanTag(row)
	if err != nil {
		switch {
		case isUniqueViolation(err):
			return nil, ErrConflict
		case isForeignKeyViolation(err):
			return nil, ErrInvalidGroup
		case errors.Is(err, pgx.ErrNoRows):
			var current int64
			lookupErr := tx.QueryRow(ctx, `
SELECT version FROM tags WHERE tenant_id = $1::uuid AND id = $2::uuid`,
				tenantID, id).Scan(&current)
			if errors.Is(lookupErr, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			if lookupErr != nil {
				return nil, lookupErr
			}
			return nil, ErrPreconditionFailed
		}
		return nil, err
	}
	if r.History != nil {
		action := ActionTagUpdated
		if in.Name != nil {
			action = ActionTagRenamed
		}
		if err := r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID: tenantID, TagID: tag.ID, TagName: tag.Name,
			Action: action, Source: "tags_api", ActorID: in.ActorID,
		}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return tag, nil
}

// GetByID returns one tag by id; ErrNotFound when absent. Used by the
// handlers to snapshot the before-state for audit emits (p4d) so the
// audit_log row carries a full {before, after} diff on update/delete.
func (r *Repo) GetByID(ctx context.Context, tenantID, id string) (*Tag, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, name::text, COALESCE(color, ''), COALESCE(description, ''),
       COALESCE(group_id::text, ''), COALESCE(created_by::text, ''),
       created_at, updated_at, COALESCE(updated_by::text, ''), archived_at,
       pii, version
  FROM tags
	 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	tag, err := scanTag(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return tag, nil
}

func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	return ErrUnsafeMutation
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return strings.Contains(err.Error(), "23505")
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows) || (err != nil && strings.Contains(err.Error(), "no rows"))
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func normalizeTagName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("name required")
	}
	if utf8.RuneCountInString(value) > TagNameMaxRunes {
		return "", errors.New("name exceeds 64 characters")
	}
	return value, nil
}

func normalizeTagColor(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || tagHexColor.MatchString(value) {
		return value, nil
	}
	if _, ok := tagPalette[value]; ok {
		return value, nil
	}
	return "", errors.New("color must be a supported palette id, #RGB, or #RRGGBB")
}

func normalizeTagDescription(value string) (string, error) {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > TagDescriptionMaxRunes {
		return "", errors.New("description exceeds 1024 characters")
	}
	return value, nil
}

func normalizeTagGroup(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", errors.New("group_id must be a UUID or empty")
	}
	return parsed.String(), nil
}

func parseRequiredTagVersion(r *http.Request, id string) (int64, error) {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	if raw == "" || raw == "*" {
		return 0, ErrPreconditionFailed
	}
	if strings.HasPrefix(raw, "W/") || strings.Contains(raw, ",") {
		return 0, errors.New("If-Match must contain one strong tag ETag")
	}
	prefix := `"tag:` + id + `:v`
	if !strings.HasPrefix(raw, prefix) || !strings.HasSuffix(raw, `"`) {
		return 0, errors.New("If-Match does not identify this tag")
	}
	versionText := strings.TrimSuffix(strings.TrimPrefix(raw, prefix), `"`)
	version, err := strconv.ParseInt(versionText, 10, 64)
	if err != nil || version <= 0 {
		return 0, errors.New("If-Match has an invalid tag version")
	}
	return version, nil
}

type Deps struct {
	Repo               *Repo
	SubscriberTagsRepo *SubscriberTagsRepo
	GroupRepo          *GroupRepo
	// Logger, when non-nil, is used by httperror.WriteInternal to log
	// the raw error text server-side (with tenant_id + request_id
	// enrichment) while keeping the client response generic. Optional
	// — leaving it nil is safe in tests; production wires the shared
	// slog instance.
	Logger *slog.Logger
}

// repoPool returns the audit-emit pool. We re-use the Repo's pool —
// the audit_log write happens in its own fresh background-ctx tx so
// sharing the pool is safe (no tx coupling). Returns nil when the
// Deps is constructed without a Repo (handler-level tests that only
// hit the validation paths); audit.EmitOrLog short-circuits cleanly
// on nil pool when no test hook is installed.
func (d *Deps) repoPool() *db.Pool {
	if d == nil || d.Repo == nil {
		return nil
	}
	return d.Repo.Pool
}

// fetchTagForAudit is a best-effort before-state snapshot helper for
// the update/delete audit emits. Returns nil on any error or when
// the Repo pool is nil — in either case the audit row still fires,
// just without a before block. We deliberately swallow the error so
// a transient read miss can't break the mutation handler.
func (d *Deps) fetchTagForAudit(ctx context.Context, tenantID, id string) *Tag {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return nil
	}
	t, err := d.Repo.GetByID(ctx, tenantID, id)
	if err != nil {
		return nil
	}
	return t
}

// parseLimit is a small helper shared by the tag history + bulk routes.
// Mirrors the idempotency package's parseLimit semantics; kept local to
// avoid cross-package coupling.
func parseLimit(raw string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, err
	}
	if n <= 0 {
		return 0, errors.New("limit must be positive")
	}
	return n, nil
}

// actorID extracts the authenticated user id from the request. Returns
// empty string when unauthenticated — callers pass empty through to
// NULLIF($, ”)::uuid in SQL so audit columns stay nullable.
// TODO: replace with the canonical auth middleware accessor once one
// lands in middleware; currently we have no central helper.
func actorID(r *http.Request) string {
	if r == nil {
		return ""
	}
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		return u.ID
	}
	return ""
}

func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/tags", d.List)
	// p4d-recordsurface-wire-others: mutating routes get the
	// pw_tags_<action>_total + pw_tags_duration_seconds pair so the
	// Grafana surface dashboard covers tags alongside the Phase-1
	// surfaces (subscribers / segments / campaigns).
	r.Post("/api/v1/tags", observability.RecordSurfaceFunc("tags", "create", d.Create))
	r.Patch("/api/v1/tags/{id}", observability.RecordSurfaceFunc("tags", "update", d.Update))
	r.Delete("/api/v1/tags/{id}", observability.RecordSurfaceFunc("tags", "delete", d.Delete))
	// Bulk apply/unapply join-table ops + bulk-delete registry tear-
	// down. All three emit one batched audit_log row per call so the
	// log row count stays scannable on a 1k payload.
	r.Post("/api/v1/tags/{id}/apply", observability.RecordSurfaceFunc("tags", "bulk_apply", d.BulkApply))
	r.Post("/api/v1/tags/{id}/unapply", observability.RecordSurfaceFunc("tags", "bulk_unapply", d.BulkUnapply))
	r.Post("/api/v1/tags/bulk-delete", observability.RecordSurfaceFunc("tags", "bulk_delete", d.BulkDelete))
	if d.GroupRepo != nil {
		(&GroupDeps{Repo: d.GroupRepo, Logger: d.Logger}).MountRoutes(r)
	}
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	q := listsearch.ReadQuery(r.URL.Query())
	includeArchived := false
	if raw := strings.TrimSpace(r.URL.Query().Get("include_archived")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_include_archived",
				"include_archived must be true or false")
			return
		}
		includeArchived = parsed
	}
	groupID, err := normalizeTagGroup(r.URL.Query().Get("group_id"))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_group_id", err.Error())
		return
	}
	// MAP#58: ?with_counts=true adds subscriber_count to every row so a
	// client can render scale next to the label. Opt-in — see
	// ListFilteredWithCounts for why this is not always-on.
	withCounts := false
	if raw := strings.TrimSpace(r.URL.Query().Get("with_counts")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_with_counts",
				"with_counts must be true or false")
			return
		}
		withCounts = parsed
	}
	out, err := d.Repo.ListFilteredWithCounts(r.Context(), t.ID, q, groupID, includeArchived, withCounts)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

const tagJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, tagJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	rawName := in.Name
	normalizedName, err := normalizeTagName(rawName)
	if err != nil {
		code := "invalid_name"
		if strings.TrimSpace(rawName) == "" {
			code = "missing_name"
		}
		httperror.Write(w, http.StatusBadRequest, code, err.Error())
		return
	}
	in.Name = normalizedName
	in.Color, err = normalizeTagColor(in.Color)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_color", err.Error())
		return
	}
	in.Description, err = normalizeTagDescription(in.Description)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_description", err.Error())
		return
	}
	in.GroupID, err = normalizeTagGroup(in.GroupID)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_group_id", err.Error())
		return
	}
	in.ActorID = actorID(r)
	tag, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			// ErrConflict is a typed sentinel with an operator-authored
			// message ("tags: name already in use"); safe to echo verbatim.
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
			return
		}
		if errors.Is(err, ErrInvalidGroup) {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_group", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// p4d-audit-emit-wire-tags — one audit row per mutation; best-effort
	// (failures are logged, never bubble up as a 5xx for the caller).
	audit.EmitOrLog(r.Context(), d.repoPool(), "tag.create", "tag", tag.ID, nil, tag, nil)
	w.Header().Set("ETag", tag.ETag)
	writeJSON(w, http.StatusCreated, tag)
}

// Update PATCH /api/v1/tags/{id}. PR 1 — frontend had been calling
// this with no route; this is the missing piece.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, tagJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	parsedID, err := uuid.Parse(id)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "id must be a UUID")
		return
	}
	id = parsedID.String()
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if rawIfMatch == "" || rawIfMatch == "*" {
		httpcache.WritePreconditionRequired(w)
		return
	}
	version, err := parseRequiredTagVersion(r, id)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_if_match", err.Error())
		return
	}
	if in.Name == nil && in.Color == nil && in.Description == nil &&
		in.GroupID == nil && in.PII == nil {
		httperror.Write(w, http.StatusBadRequest, "empty_patch", "at least one field is required")
		return
	}
	if in.Name != nil {
		v, normalizeErr := normalizeTagName(*in.Name)
		if normalizeErr != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_name", normalizeErr.Error())
			return
		}
		in.Name = &v
	}
	if in.Color != nil {
		v, normalizeErr := normalizeTagColor(*in.Color)
		if normalizeErr != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_color", normalizeErr.Error())
			return
		}
		in.Color = &v
	}
	if in.Description != nil {
		v, normalizeErr := normalizeTagDescription(*in.Description)
		if normalizeErr != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_description", normalizeErr.Error())
			return
		}
		in.Description = &v
	}
	if in.GroupID != nil {
		v, normalizeErr := normalizeTagGroup(*in.GroupID)
		if normalizeErr != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_group_id", normalizeErr.Error())
			return
		}
		in.GroupID = &v
	}
	in.ActorID = actorID(r)
	in.ExpectedVersion = version
	// Best-effort before-state snapshot for the audit trail. Failure
	// here just leaves before=nil; we never block the mutation on it.
	before := d.fetchTagForAudit(r.Context(), t.ID, id)
	tag, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrConflict):
			// ErrConflict carries an operator-authored sentinel message;
			// safe to echo verbatim.
			httperror.Write(w, http.StatusConflict, "name_taken", err.Error())
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrInvalidGroup):
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_group", err.Error())
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	// p4d-audit-emit-wire-tags — emit a 'tag.rename' row when the name
	// actually changed (a rename is a semantically distinct audit event),
	// otherwise the generic 'tag.update' covers color/description edits.
	action := "tag.update"
	if before != nil && tag != nil && before.Name != tag.Name {
		action = "tag.rename"
	}
	audit.EmitOrLog(r.Context(), d.repoPool(), action, "tag", tag.ID, before, tag, nil)
	w.Header().Set("ETag", tag.ETag)
	writeJSON(w, http.StatusOK, tag)
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	writeJSON(w, http.StatusConflict, errEnv("unsafe_mutation_disabled",
		"Permanent tag deletion requires an authoritative impact plan and idempotent receipt; use archive when available."))
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
