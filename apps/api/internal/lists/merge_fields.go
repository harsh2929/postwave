// Package lists — merge_fields.go owns GAP-LS-066: per-list custom
// fields (Mailchimp parity "merge fields"). Tenant already has
// tenant-wide subscriber custom fields; merge fields are list-scoped
// so the FNAME / LNAME / PHONE schema can vary per audience.
//
// Storage: list_metadata.custom_metadata.merge_fields as a JSON array of
// MergeField objects. We chose JSONB over a sibling SQL table because
// the cardinality is tiny (≤30 fields per list per Mailchimp; we cap
// at 50) and the read pattern is "fetch all fields whenever any list
// detail loads" — a JSONB column is one fewer JOIN per page load.
//
// Field shape:
//
//   tag         e.g. "FNAME" / "LNAME" / "PHONE". 1-10 uppercase chars.
//   type        text | number | date | email | phone | address
//   name        human label for forms / preference page
//   required    bool
//   default     optional default value (text)
//   help_text   optional inline helper rendered on forms
//   created_at  ISO-8601 string. Set on first insert; preserved on update.

package lists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// MountMergeFieldRoutes registers the per-list merge-fields surface.
func (d *Deps) MountMergeFieldRoutes(r chi.Router) {
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers))
	write := r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers))
	read.Get("/api/v1/lists/{id}/merge-fields", d.ListMergeFields)
	// p4d-recordsurface-wire-others: per-list merge-field CRUD.
	write.Post("/api/v1/lists/{id}/merge-fields", observability.RecordSurfaceFunc("lists", "merge_field_create", d.CreateMergeField))
	write.Patch("/api/v1/lists/{id}/merge-fields/{tag}", observability.RecordSurfaceFunc("lists", "merge_field_update", d.UpdateMergeField))
	write.Delete("/api/v1/lists/{id}/merge-fields/{tag}", observability.RecordSurfaceFunc("lists", "merge_field_delete", d.DeleteMergeField))
}

// MergeField is the wire shape.
type MergeField struct {
	Tag       string `json:"tag"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	Required  bool   `json:"required"`
	Default   string `json:"default,omitempty"`
	HelpText  string `json:"help_text,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

const (
	mergeFieldMaxPerList   = 50
	mergeFieldJSONMaxBytes = 16 << 10
	mergeFieldTagMaxLen    = 10
	mergeFieldNameMaxLen   = 80
)

var (
	mergeFieldTagRE      = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	mergeFieldValidTypes = map[string]struct{}{
		"text":    {},
		"number":  {},
		"date":    {},
		"email":   {},
		"phone":   {},
		"address": {},
	}
)

func validateMergeField(in MergeField) error {
	// Tags are normalised by the caller (handlers do TrimSpace+ToUpper
	// before calling validate). Reject lowercase / whitespace input
	// rather than silently coercing so accidental drift surfaces.
	if in.Tag == "" || len(in.Tag) > mergeFieldTagMaxLen {
		return fmt.Errorf("tag must be 1..%d characters", mergeFieldTagMaxLen)
	}
	if !mergeFieldTagRE.MatchString(in.Tag) {
		return fmt.Errorf("tag must be uppercase letters, digits and underscores, starting with a letter")
	}
	if _, ok := mergeFieldValidTypes[in.Type]; !ok {
		return fmt.Errorf("type must be one of text, number, date, email, phone, address")
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > mergeFieldNameMaxLen {
		return fmt.Errorf("name must be 1..%d characters", mergeFieldNameMaxLen)
	}
	return nil
}

// ListMergeFields GET /api/v1/lists/{id}/merge-fields
func (d *Deps) ListMergeFields(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		// No mapping yet — return an empty set so the UI can render.
		writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "merge_fields": []MergeField{}})
		return
	}
	fields, err := d.Repo.ListMergeFields(r.Context(), tenantID, bigintID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "merge_fields": fields})
}

// CreateMergeField POST /api/v1/lists/{id}/merge-fields
func (d *Deps) CreateMergeField(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	var in MergeField
	if err := httpbody.DecodeJSON(w, r, mergeFieldJSONMaxBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Tag = strings.ToUpper(strings.TrimSpace(in.Tag))
	if err := validateMergeField(in); err != nil {
		httperror.WriteValidation(w, "invalid_field", err.Error())
		return
	}
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		if errors.Is(err, ErrListIDNotMapped) {
			httperror.Write(w, http.StatusNotFound, "not_found", "list not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	in.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := d.Repo.SaveMergeField(r.Context(), tenantID, bigintID, in, false); err != nil {
		if errors.Is(err, errMergeFieldExists) {
			httperror.Write(w, http.StatusConflict, "tag_taken", "merge-field tag already exists")
			return
		}
		if errors.Is(err, errTooManyMergeFields) {
			httperror.Write(w, http.StatusUnprocessableEntity, "too_many_fields",
				fmt.Sprintf("list has reached the %d merge-field cap", mergeFieldMaxPerList))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.merge_field.create", "list_merge_field", in.Tag,
		nil, in, map[string]any{"list_id": listUUID})
	writeJSON(w, http.StatusCreated, in)
}

// UpdateMergeField PATCH /api/v1/lists/{id}/merge-fields/{tag}
func (d *Deps) UpdateMergeField(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	tag := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "tag")))
	if tag == "" {
		httperror.WriteValidation(w, "missing_tag", "tag required")
		return
	}
	var in MergeField
	if err := httpbody.DecodeJSON(w, r, mergeFieldJSONMaxBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Tag = tag // ignore tag override in body — URL is the source of truth
	if err := validateMergeField(in); err != nil {
		httperror.WriteValidation(w, "invalid_field", err.Error())
		return
	}
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		if errors.Is(err, ErrListIDNotMapped) {
			httperror.Write(w, http.StatusNotFound, "not_found", "list not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.Repo.SaveMergeField(r.Context(), tenantID, bigintID, in, true); err != nil {
		if errors.Is(err, errMergeFieldMissing) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no merge-field with that tag")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.merge_field.update", "list_merge_field", in.Tag,
		nil, in, map[string]any{"list_id": listUUID})
	writeJSON(w, http.StatusOK, in)
}

// DeleteMergeField DELETE /api/v1/lists/{id}/merge-fields/{tag}
func (d *Deps) DeleteMergeField(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	tag := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "tag")))
	if tag == "" {
		httperror.WriteValidation(w, "missing_tag", "tag required")
		return
	}
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		if errors.Is(err, ErrListIDNotMapped) {
			httperror.Write(w, http.StatusNotFound, "not_found", "list not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.Repo.DeleteMergeField(r.Context(), tenantID, bigintID, tag); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.merge_field.delete", "list_merge_field", tag,
		nil, nil, map[string]any{"list_id": listUUID})
	w.WriteHeader(http.StatusNoContent)
}

// ----------------- repo -----------------

var (
	errMergeFieldExists   = errors.New("merge field tag already exists")
	errMergeFieldMissing  = errors.New("merge field tag not found")
	errTooManyMergeFields = errors.New("merge field cap reached")
)

// ListMergeFields reads the JSONB array from list_metadata. Missing
// row -> empty slice.
func (r *Repo) ListMergeFields(ctx context.Context, tenantID string, bigintID int64) ([]MergeField, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var raw []byte
	err = tx.QueryRow(ctx, `
SELECT COALESCE(custom_metadata -> 'merge_fields', '[]'::jsonb)::text::bytea
  FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
		tenantID, bigintID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Commit(ctx)
		return []MergeField{}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	var out []MergeField
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	if out == nil {
		out = []MergeField{}
	}
	return out, nil
}

// SaveMergeField is the upsert path for both create + update. When
// expectExisting is true the function 404s if the tag isn't already
// present (update semantics); when false it 409s on conflict (create
// semantics).
func (r *Repo) SaveMergeField(ctx context.Context, tenantID string, bigintID int64, in MergeField, expectExisting bool) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	tx, txErr := db.WithTenant(ctx, r.Pool, tenantID)
	if txErr != nil {
		return txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Read-modify-write under SELECT FOR UPDATE so concurrent writers
	// can't clobber each other's array mutations.
	var raw []byte
	txErr = tx.QueryRow(ctx, `
SELECT COALESCE(custom_metadata -> 'merge_fields', '[]'::jsonb)::text::bytea
  FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2
 FOR UPDATE`, tenantID, bigintID).Scan(&raw)
	if errors.Is(txErr, pgx.ErrNoRows) {
		// Auto-create the sidecar row, then continue with an empty list.
		if _, err := tx.Exec(ctx, `
INSERT INTO list_metadata (tenant_id, listmonk_list_id, custom_metadata)
VALUES ($1::uuid, $2, '{}'::jsonb)
ON CONFLICT (tenant_id, listmonk_list_id) DO NOTHING`,
			tenantID, bigintID); err != nil {
			return err
		}
		raw = []byte("[]")
	} else if txErr != nil {
		return txErr
	}

	var fields []MergeField
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &fields)
	}

	foundIdx := -1
	for i := range fields {
		if fields[i].Tag == in.Tag {
			foundIdx = i
			break
		}
	}
	if expectExisting && foundIdx < 0 {
		return errMergeFieldMissing
	}
	if !expectExisting && foundIdx >= 0 {
		return errMergeFieldExists
	}
	if !expectExisting && len(fields) >= mergeFieldMaxPerList {
		return errTooManyMergeFields
	}

	if foundIdx >= 0 {
		// Preserve the original created_at on update.
		if fields[foundIdx].CreatedAt != "" {
			in.CreatedAt = fields[foundIdx].CreatedAt
		}
		fields[foundIdx] = in
	} else {
		fields = append(fields, in)
	}

	out, txErr := json.Marshal(fields)
	if txErr != nil {
		return txErr
	}
	if _, err := tx.Exec(ctx, `
UPDATE list_metadata
   SET custom_metadata = jsonb_set(
           COALESCE(custom_metadata, '{}'::jsonb),
           ARRAY['merge_fields'],
           $3::jsonb,
           true
       ),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
		tenantID, bigintID, string(out)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteMergeField removes the entry with the given tag. No-op if the
// row doesn't exist or the tag isn't present — operator-safe.
func (r *Repo) DeleteMergeField(ctx context.Context, tenantID string, bigintID int64, tag string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var raw []byte
	err = tx.QueryRow(ctx, `
SELECT COALESCE(custom_metadata -> 'merge_fields', '[]'::jsonb)::text::bytea
  FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2
 FOR UPDATE`, tenantID, bigintID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Commit(ctx)
		return nil
	}
	if err != nil {
		return err
	}

	var fields []MergeField
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &fields)
	}
	kept := fields[:0]
	for _, f := range fields {
		if f.Tag != tag {
			kept = append(kept, f)
		}
	}
	out, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE list_metadata
   SET custom_metadata = jsonb_set(
           COALESCE(custom_metadata, '{}'::jsonb),
           ARRAY['merge_fields'],
           $3::jsonb,
           true
       ),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
		tenantID, bigintID, string(out)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
