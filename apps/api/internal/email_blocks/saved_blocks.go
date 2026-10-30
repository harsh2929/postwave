// SPDX-License-Identifier: AGPL-3.0-only
//
// Workstream 4 (Mailchimp parity polish) — saved (reusable) blocks.
//
// Operators save a configured block (or multi-block snippet) under a
// name, then drag it back into the template editor on subsequent
// campaigns. Mirrors Mailchimp's "Saved blocks" surface.
//
// Routes (all tenant-scoped):
//
//   GET    /api/v1/blocks/saved          paginated list
//   POST   /api/v1/blocks/saved          create (body: name, kind?, body_html?, body_json?)
//   PATCH  /api/v1/blocks/saved/{id}     partial update
//   DELETE /api/v1/blocks/saved/{id}     remove
//
// Storage: saved_blocks(tenant_id, id, name UNIQUE-per-tenant, kind,
// body_html, body_json). See migration 0232_saved_blocks.sql.

package email_blocks

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SavedBlock is one row from saved_blocks.
type SavedBlock struct {
	ID        string          `json:"id"`
	TenantID  string          `json:"tenant_id,omitempty"`
	Name      string          `json:"name"`
	Kind      string          `json:"kind"`
	BodyHTML  string          `json:"body_html"`
	BodyJSON  json.RawMessage `json:"body_json"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
	Version   int64           `json:"version"`
}

// SavedBlockInput is the body of POST + PATCH (pointer fields = optional).
type SavedBlockInput struct {
	Name            *string         `json:"name,omitempty"`
	Kind            *string         `json:"kind,omitempty"`
	BodyHTML        *string         `json:"body_html,omitempty"`
	BodyJSON        json.RawMessage `json:"body_json,omitempty"`
	ExpectedVersion *int64          `json:"expected_version,omitempty"`
}

// Errors
var (
	ErrSavedBlockNotFound      = errors.New("saved_blocks: not found")
	ErrSavedBlockNameConflict  = errors.New("saved_blocks: name already in use")
	ErrSavedBlockStale         = errors.New("saved_blocks: stale version")
	ErrSavedBlockInvalidID     = errors.New("saved_blocks: invalid id")
	ErrSavedBlockInvalidInput  = errors.New("saved_blocks: invalid input")
	ErrSavedBlockInvalidCursor = errors.New("saved_blocks: invalid cursor")
)

const (
	savedBlocksMaxBody    = 256 * 1024 // 256 KiB — enough for a multi-block snippet
	savedBlockNameMaxLen  = 120
	savedBlockListDefault = 50
	savedBlockListMax     = 200
	savedBlockSearchMax   = 200
)

func validKind(k string) bool {
	switch k {
	case "block", "snippet", "section":
		return true
	}
	return false
}

// SavedRepo wraps pgx with saved-block CRUD.
type SavedRepo struct{ Pool *db.Pool }

const savedBlockCols = `id::text, tenant_id::text, name, kind, body_html, body_json, created_at, updated_at, version`

func scanSavedBlock(row pgx.Row, s *SavedBlock) error {
	return row.Scan(&s.ID, &s.TenantID, &s.Name, &s.Kind, &s.BodyHTML, &s.BodyJSON, &s.CreatedAt, &s.UpdatedAt, &s.Version)
}

type SavedBlockListOptions struct {
	Kind   string
	Query  string
	Before string
	Limit  int
}

type SavedBlockPage struct {
	Items      []SavedBlock `json:"items"`
	Total      int          `json:"total"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

// List returns up to limit rows; kind, when non-empty, filters by kind.
func (r *SavedRepo) List(ctx context.Context, tenantID, kind string, limit int) ([]SavedBlock, error) {
	page, err := r.ListPage(ctx, tenantID, SavedBlockListOptions{Kind: kind, Limit: limit})
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (r *SavedRepo) ListPage(ctx context.Context, tenantID string, opts SavedBlockListOptions) (*SavedBlockPage, error) {
	if opts.Limit <= 0 || opts.Limit > savedBlockListMax {
		opts.Limit = savedBlockListDefault
	}
	if opts.Before != "" && !canonicalSavedBlockID(opts.Before) {
		return nil, ErrSavedBlockInvalidCursor
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if opts.Before != "" {
		var cursorExists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM saved_blocks WHERE tenant_id = $1::uuid AND id = $2::uuid)`,
			tenantID, opts.Before).Scan(&cursorExists); err != nil {
			return nil, err
		}
		if !cursorExists {
			return nil, ErrSavedBlockInvalidCursor
		}
	}
	where := []string{"tenant_id = $1::uuid"}
	args := []any{tenantID}
	if opts.Kind != "" {
		args = append(args, opts.Kind)
		where = append(where, "kind = $"+itoaSB(len(args)))
	}
	if opts.Query != "" {
		args = append(args, "%"+escapeSavedBlockLike(strings.ToLower(opts.Query))+"%")
		where = append(where, "lower(name) LIKE $"+itoaSB(len(args))+" ESCAPE E'\\\\'")
	}
	var total int
	if err := tx.QueryRow(ctx, "SELECT COUNT(*) FROM saved_blocks WHERE "+strings.Join(where, " AND "), args...).Scan(&total); err != nil {
		return nil, err
	}
	if opts.Before != "" {
		args = append(args, opts.Before)
		position := "$" + itoaSB(len(args))
		where = append(where, "(updated_at, id) < (SELECT updated_at, id FROM saved_blocks WHERE id = "+position+"::uuid)")
	}
	q := "SELECT " + savedBlockCols + " FROM saved_blocks WHERE " + strings.Join(where, " AND ") +
		" ORDER BY updated_at DESC, id DESC LIMIT " + itoaSB(opts.Limit+1)
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SavedBlock{}
	for rows.Next() {
		var s SavedBlock
		if err := scanSavedBlock(rows, &s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	next := ""
	if len(out) > opts.Limit {
		out = out[:opts.Limit]
		next = out[len(out)-1].ID
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &SavedBlockPage{Items: out, Total: total, NextCursor: next}, nil
}

func (r *SavedRepo) Get(ctx context.Context, tenantID, id string) (*SavedBlock, error) {
	if !canonicalSavedBlockID(id) {
		return nil, ErrSavedBlockInvalidID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var block SavedBlock
	if err := scanSavedBlock(tx.QueryRow(ctx,
		"SELECT "+savedBlockCols+" FROM saved_blocks WHERE tenant_id = $1::uuid AND id = $2::uuid",
		tenantID, id), &block); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSavedBlockNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &block, nil
}

// Create inserts a new saved block.
func (r *SavedRepo) Create(ctx context.Context, tenantID string, in SavedBlockInput) (*SavedBlock, error) {
	if in.ExpectedVersion == nil || *in.ExpectedVersion != 0 {
		return nil, ErrSavedBlockInvalidInput
	}
	name := ""
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	kind := "block"
	if in.Kind != nil {
		kind = *in.Kind
	}
	body := ""
	if in.BodyHTML != nil {
		body = *in.BodyHTML
	}
	bodyJSON := json.RawMessage("{}")
	if len(in.BodyJSON) > 0 {
		bodyJSON = in.BodyJSON
	}
	if err := validateSavedBlockValues(name, kind, body, bodyJSON); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s SavedBlock
	row := tx.QueryRow(ctx, `
INSERT INTO saved_blocks (tenant_id, name, kind, body_html, body_json)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
RETURNING `+savedBlockCols,
		tenantID, name, kind, body, string(bodyJSON))
	if err := scanSavedBlock(row, &s); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSavedBlockNameConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// Update applies the partial input. Empty pointers = leave column alone.
func (r *SavedRepo) Update(ctx context.Context, tenantID, id string, in SavedBlockInput) (*SavedBlock, error) {
	if !canonicalSavedBlockID(id) {
		return nil, ErrSavedBlockInvalidID
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		return nil, ErrSavedBlockInvalidInput
	}
	if in.Name == nil && in.Kind == nil && in.BodyHTML == nil && len(in.BodyJSON) == 0 {
		return nil, ErrSavedBlockInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current SavedBlock
	if err := scanSavedBlock(tx.QueryRow(ctx,
		"SELECT "+savedBlockCols+" FROM saved_blocks WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE",
		tenantID, id), &current); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSavedBlockNotFound
		}
		return nil, err
	}
	if current.Version != *in.ExpectedVersion {
		return nil, ErrSavedBlockStale
	}
	name, kind, body, bodyJSON := current.Name, current.Kind, current.BodyHTML, current.BodyJSON
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	if in.Kind != nil {
		kind = *in.Kind
	}
	if in.BodyHTML != nil {
		body = *in.BodyHTML
	}
	if len(in.BodyJSON) > 0 {
		bodyJSON = in.BodyJSON
	}
	if err := validateSavedBlockValues(name, kind, body, bodyJSON); err != nil {
		return nil, err
	}
	var s SavedBlock
	row := tx.QueryRow(ctx, `
UPDATE saved_blocks
   SET name = $3, kind = $4, body_html = $5, body_json = $6::jsonb,
       updated_at = now(), version = version + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND version = $7
 RETURNING `+savedBlockCols,
		tenantID, id, name, kind, body, string(bodyJSON), *in.ExpectedVersion)
	if err := scanSavedBlock(row, &s); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSavedBlockNotFound
		}
		if isUniqueViolation(err) {
			return nil, ErrSavedBlockNameConflict
		}
		return nil, err
	}
	return &s, tx.Commit(ctx)
}

// Delete removes one saved block.
func (r *SavedRepo) Delete(ctx context.Context, tenantID, id string, expectedVersion int64) (int64, error) {
	if !canonicalSavedBlockID(id) {
		return 0, ErrSavedBlockInvalidID
	}
	if expectedVersion <= 0 {
		return 0, ErrSavedBlockInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentVersion int64
	if err := tx.QueryRow(ctx,
		`SELECT version FROM saved_blocks WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
		tenantID, id).Scan(&currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrSavedBlockNotFound
		}
		return 0, err
	}
	if currentVersion != expectedVersion {
		return 0, ErrSavedBlockStale
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM saved_blocks WHERE tenant_id = $1::uuid AND id = $2::uuid AND version = $3`,
		tenantID, id, expectedVersion)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrSavedBlockNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return currentVersion + 1, nil
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

// SavedDeps wires the handler.
type SavedDeps struct {
	Repo   *SavedRepo
	Logger *slog.Logger
}

// MountSavedRoutes registers the saved-block CRUD endpoints.
func MountSavedRoutes(r chi.Router, d *SavedDeps) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/blocks/saved", d.List)
	r.With(write).Post("/api/v1/blocks/saved", d.Create)
	r.With(write).Get("/api/v1/blocks/saved/{id}", d.Get)
	r.With(write).Patch("/api/v1/blocks/saved/{id}", d.Update)
	r.With(write).Delete("/api/v1/blocks/saved/{id}", d.Delete)
}

func (d *SavedDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeSavedErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	query := r.URL.Query()
	for key := range query {
		switch key {
		case "kind", "limit", "q", "before":
		default:
			writeSavedErr(w, http.StatusBadRequest, "invalid_query_parameter", "request contains an unsupported saved-block query parameter")
			return
		}
		if len(query[key]) != 1 {
			writeSavedErr(w, http.StatusBadRequest, "duplicate_query_parameter", "saved-block query parameters must be specified once")
			return
		}
	}
	kind := strings.TrimSpace(query.Get("kind"))
	if kind != "" && !validKind(kind) {
		writeSavedErr(w, http.StatusBadRequest, "invalid_kind",
			"kind must be one of block | snippet | section")
		return
	}
	limit := savedBlockListDefault
	if raw := query.Get("limit"); raw != "" {
		limit = atoiOrZero(raw)
		if limit < 1 || limit > savedBlockListMax {
			writeSavedErr(w, http.StatusBadRequest, "invalid_limit", "limit must be an integer from 1 to 200")
			return
		}
	}
	q := strings.TrimSpace(query.Get("q"))
	if !safeSavedBlockName(q, savedBlockSearchMax, true) {
		writeSavedErr(w, http.StatusBadRequest, "invalid_query", "q must be 200 safe characters or fewer")
		return
	}
	page, err := d.Repo.ListPage(r.Context(), t.ID, SavedBlockListOptions{
		Kind: kind, Query: q, Before: query.Get("before"), Limit: limit,
	})
	if err != nil {
		if errors.Is(err, ErrSavedBlockInvalidCursor) {
			writeSavedErr(w, http.StatusBadRequest, "invalid_cursor", "before must identify a current saved block in this workspace")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeSavedJSON(w, http.StatusOK, page)
}

func (d *SavedDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeSavedErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if !canonicalSavedBlockID(id) {
		writeSavedErr(w, http.StatusBadRequest, "invalid_id", "saved-block id must be a canonical lowercase UUID")
		return
	}
	block, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrSavedBlockNotFound) {
			writeSavedErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeSavedJSON(w, http.StatusOK, block)
}

func (d *SavedDeps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeSavedErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in SavedBlockInput
	if err := httpbody.DecodeJSON(w, r, savedBlocksMaxBody, &in); err != nil {
		writeSavedErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion != 0 {
		writeSavedErr(w, http.StatusPreconditionRequired, "expected_version_required", "expected_version must be 0 for a saved-block create")
		return
	}
	saved, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrSavedBlockNameConflict) {
			writeSavedErr(w, http.StatusConflict, "name_conflict", "a saved block with that name already exists")
			return
		}
		writeSavedErr(w, http.StatusUnprocessableEntity, "invalid_saved_block", "saved block input is invalid")
		return
	}
	writeSavedJSON(w, http.StatusCreated, saved)
}

func (d *SavedDeps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeSavedErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if !canonicalSavedBlockID(id) {
		writeSavedErr(w, http.StatusBadRequest, "invalid_id", "saved-block id must be a canonical lowercase UUID")
		return
	}
	var in SavedBlockInput
	if err := httpbody.DecodeJSON(w, r, savedBlocksMaxBody, &in); err != nil {
		writeSavedErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeSavedErr(w, http.StatusPreconditionRequired, "expected_version_required", "expected_version must be a positive integer")
		return
	}
	saved, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrSavedBlockNotFound):
			writeSavedErr(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrSavedBlockNameConflict):
			writeSavedErr(w, http.StatusConflict, "name_conflict", "a saved block with that name already exists")
		case errors.Is(err, ErrSavedBlockStale):
			writeSavedErr(w, http.StatusPreconditionFailed, "stale_version", "saved block changed after it was read")
		default:
			writeSavedErr(w, http.StatusUnprocessableEntity, "invalid_saved_block", "saved block input is invalid")
		}
		return
	}
	writeSavedJSON(w, http.StatusOK, saved)
}

func (d *SavedDeps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeSavedErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if !canonicalSavedBlockID(id) {
		writeSavedErr(w, http.StatusBadRequest, "invalid_id", "saved-block id must be a canonical lowercase UUID")
		return
	}
	expectedVersion, ok := readSavedBlockExpectedVersion(w, r)
	if !ok {
		return
	}
	version, err := d.Repo.Delete(r.Context(), t.ID, id, expectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrSavedBlockNotFound):
			writeSavedErr(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrSavedBlockStale):
			writeSavedErr(w, http.StatusPreconditionFailed, "stale_version", "saved block changed after it was read")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeSavedJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "version": version})
}

// ---------------------------------------------------------------------
// Helpers (scoped to avoid colliding with email_blocks.go helpers)
// ---------------------------------------------------------------------

func writeSavedJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeSavedErr(w http.ResponseWriter, status int, code, msg string) {
	writeSavedJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

func canonicalSavedBlockID(raw string) bool {
	id, err := uuid.Parse(raw)
	return err == nil && raw == id.String()
}

func safeSavedBlockName(value string, maxRunes int, allowEmpty bool) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	if !allowEmpty && strings.TrimSpace(value) == "" {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f || r >= 0x202a && r <= 0x202e || r >= 0x2066 && r <= 0x2069 {
			return false
		}
	}
	return true
}

func validateSavedBlockValues(name, kind, bodyHTML string, bodyJSON json.RawMessage) error {
	if !safeSavedBlockName(name, savedBlockNameMaxLen, false) || !validKind(kind) {
		return ErrSavedBlockInvalidInput
	}
	if !utf8.ValidString(bodyHTML) || len(bodyHTML) > 200*1024 || len(bodyJSON) > 200*1024 || !utf8.Valid(bodyJSON) {
		return ErrSavedBlockInvalidInput
	}
	var structured map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(bodyJSON)))
	decoder.UseNumber()
	if err := decoder.Decode(&structured); err != nil || structured == nil {
		return ErrSavedBlockInvalidInput
	}
	if nodes, depth, ok := savedBlockJSONShape(structured, 1); !ok || nodes > 10_000 || depth > 32 {
		return ErrSavedBlockInvalidInput
	}
	if strings.TrimSpace(bodyHTML) == "" && len(structured) == 0 {
		return ErrSavedBlockInvalidInput
	}
	return nil
}

func savedBlockJSONShape(value any, depth int) (nodes int, maxDepth int, ok bool) {
	if depth > 32 {
		return 0, depth, false
	}
	switch typed := value.(type) {
	case map[string]any:
		nodes, maxDepth = 1, depth
		for key, child := range typed {
			if !safeSavedBlockName(key, 128, false) || reservedSavedBlockJSONKey(key) {
				return 0, depth, false
			}
			childNodes, childDepth, childOK := savedBlockJSONShape(child, depth+1)
			if !childOK {
				return 0, childDepth, false
			}
			nodes += childNodes
			if childDepth > maxDepth {
				maxDepth = childDepth
			}
			if nodes > 10_000 {
				return nodes, maxDepth, false
			}
		}
		return nodes, maxDepth, true
	case []any:
		nodes, maxDepth = 1, depth
		for _, child := range typed {
			childNodes, childDepth, childOK := savedBlockJSONShape(child, depth+1)
			if !childOK {
				return 0, childDepth, false
			}
			nodes += childNodes
			if childDepth > maxDepth {
				maxDepth = childDepth
			}
			if nodes > 10_000 {
				return nodes, maxDepth, false
			}
		}
		return nodes, maxDepth, true
	case string:
		return 1, depth, utf8.ValidString(typed) && len(typed) <= 64*1024
	case json.Number:
		value, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
			return 0, depth, false
		}
		if math.Trunc(value) == value && math.Abs(value) > 9_007_199_254_740_991 {
			return 0, depth, false
		}
		return 1, depth, true
	case bool, nil:
		return 1, depth, true
	default:
		return 0, depth, false
	}
}

func reservedSavedBlockJSONKey(key string) bool {
	switch key {
	case "__proto__", "constructor", "prototype":
		return true
	default:
		return false
	}
}

func escapeSavedBlockLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func readSavedBlockExpectedVersion(w http.ResponseWriter, r *http.Request) (int64, bool) {
	var in struct {
		ExpectedVersion *int64 `json:"expected_version"`
	}
	raw, err := httpbody.ReadJSONAtMost(r, 8*1024, httpbody.Options{AllowEmptyBody: true})
	if err != nil {
		writeSavedErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return 0, false
	}
	if len(raw) > 0 {
		if err := httpbody.DecodeJSONValue(raw, &in, httpbody.Options{}); err != nil {
			writeSavedErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return 0, false
		}
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeSavedErr(w, http.StatusPreconditionRequired, "expected_version_required", "expected_version must be a positive integer")
		return 0, false
	}
	return *in.ExpectedVersion, true
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique")
}

func itoaSB(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func atoiOrZero(s string) int {
	if s == "" {
		return 0
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}
