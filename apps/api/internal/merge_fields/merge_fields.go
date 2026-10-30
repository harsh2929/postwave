// Package merge_fields owns Mailchimp's "audience field" editor surface:
// a per-tenant schema (key/label/type/default/required/position) plus
// per-subscriber values. subscribers.merge_fields (jsonb) remains the
// canonical compatibility store used by imports, search, exports, and sending;
// merge_field_values is a typed sidecar mirrored for rolling compatibility and
// per-cell evolution. Migration preflight requires both stores to agree before
// enabling transactional mirrors; canonical JSONB wins and a sidecar value is
// the safe fallback when a declared canonical key is absent.
//
// Why not reuse `customfields/`: customfields constrains keys to
// lowercase identifiers and has no notion of default values, required
// flags, or display order — which are Mailchimp parity requirements.
// merge_fields is the schema-level "tag" (FNAME / LNAME / BIRTHDAY)
// that operators define + render in the dashboard.
//
// Surface:
//
//   - GET    /api/v1/merge-fields/schema             — list schema rows
//   - POST   /api/v1/merge-fields/schema             — create
//   - PATCH  /api/v1/merge-fields/schema/{key}       — update one row
//   - DELETE /api/v1/merge-fields/schema/{key}       — remove one row
//   - GET    /api/v1/subscribers/{id}/merge-fields   — { key: value }
//   - PATCH  /api/v1/subscribers/{id}/merge-fields   — partial upsert
package merge_fields

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// FieldType is one of: text | number | boolean | date | address | phone.
// Mailchimp's MERGE TAG types are a superset; we keep the practical
// minimum here. Extending it is additive.
type FieldType string

const (
	TypeText    FieldType = "text"
	TypeNumber  FieldType = "number"
	TypeBoolean FieldType = "boolean"
	TypeDate    FieldType = "date"
	TypeAddress FieldType = "address"
	TypePhone   FieldType = "phone"
)

func isValidType(t string) bool {
	switch FieldType(t) {
	case TypeText, TypeNumber, TypeBoolean, TypeDate, TypeAddress, TypePhone:
		return true
	}
	return false
}

// Errors surfaced to handlers.
var (
	ErrNotFound     = errors.New("merge_fields: not found")
	ErrKeyConflict  = errors.New("merge_fields: key already exists")
	ErrInvalidInput = errors.New("merge_fields: invalid input")
	ErrFieldInUse   = errors.New("merge_fields: field has stored subscriber values")
	ErrSchemaLimit  = errors.New("merge_fields: schema field limit reached")
)

// MaxKeyLength caps the merge-tag identifier. Mailchimp keys are
// uppercase + short (FNAME, LNAME); we don't need 100s of characters.
const MaxKeyLength = 32

// MaxLabelLength caps display labels.
const MaxLabelLength = 200

// MaxSchemaFields is the per-tenant audience-field catalog limit. The native
// schema is also the Mailchimp compatibility schema, so this intentionally
// matches Moosewave's existing 50-field per-list compatibility ceiling: it is
// above Mailchimp's conventional 30-field catalog while remaining small enough
// for complete-schema reads, editor rendering, and typed write validation.
const MaxSchemaFields = 50

// MaxValueLength bounds both defaults and stored subscriber values. Merge
// fields are personalization tokens, not an unbounded document store.
const MaxValueLength = 4096

// Display positions are deliberately bounded below PostgreSQL's integer range
// so invalid JSON becomes a 422 instead of a database overflow/500.
const (
	MinPosition = -1_000_000
	MaxPosition = 1_000_000
)

const mergeFieldJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// MergeFieldSchema is one schema row.
type MergeFieldSchema struct {
	TenantID     string    `json:"tenant_id"`
	Key          string    `json:"key"`
	Label        string    `json:"label"`
	Type         FieldType `json:"type"`
	DefaultValue string    `json:"default_value"`
	Required     bool      `json:"required"`
	Position     int       `json:"position"`
	ValueCount   int64     `json:"value_count"`
	CreatedAt    string    `json:"created_at"`
	UpdatedAt    string    `json:"updated_at"`
}

// SchemaInput is the body of POST /merge-fields/schema.
type SchemaInput struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	Type         string `json:"type"`
	DefaultValue string `json:"default_value"`
	Required     bool   `json:"required"`
	Position     int    `json:"position"`
}

// SchemaPatch carries only the updatable columns. nil = no change.
type SchemaPatch struct {
	Label        *string `json:"label,omitempty"`
	Type         *string `json:"type,omitempty"`
	DefaultValue *string `json:"default_value,omitempty"`
	Required     *bool   `json:"required,omitempty"`
	Position     *int    `json:"position,omitempty"`
}

// SubscriberValues is the response shape for
// GET /api/v1/subscribers/{id}/merge-fields.
type SubscriberValues struct {
	SubscriberID string         `json:"subscriber_id"`
	Values       map[string]any `json:"values"`
}

// Deps bundles the repo for handler wiring.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

// MountRoutes registers tenant-scoped routes.
func (d *Deps) MountRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/merge-fields/schema", d.ListSchema)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/merge-fields/schema", d.CreateSchema)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/merge-fields/schema/{key}", d.PatchSchema)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/merge-fields/schema/{key}", d.DeleteSchema)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/merge-fields", d.GetSubscriberValues)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/merge-fields", d.PatchSubscriberValues)
}

func (d *Deps) ListSchema(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	out, err := d.Repo.ListSchema(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateSchema(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in SchemaInput
	if err := httpbody.DecodeJSON(w, r, mergeFieldJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.CreateSchema(r.Context(), t.ID, in)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) PatchSchema(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	key := chi.URLParam(r, "key")
	var in SchemaPatch
	if err := httpbody.DecodeJSON(w, r, mergeFieldJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.PatchSchema(r.Context(), t.ID, key, in)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteSchema(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	if err := d.Repo.DeleteSchema(r.Context(), t.ID, chi.URLParam(r, "key")); err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) GetSubscriberValues(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	sid := chi.URLParam(r, "id")
	values, err := d.Repo.GetSubscriberValues(r.Context(), t.ID, sid)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, SubscriberValues{SubscriberID: sid, Values: values})
}

func (d *Deps) PatchSubscriberValues(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	sid := chi.URLParam(r, "id")
	var in map[string]any
	if err := httpbody.DecodeJSON(w, r, mergeFieldJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	values, err := d.Repo.PatchSubscriberValues(r.Context(), t.ID, sid, in)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, SubscriberValues{SubscriberID: sid, Values: values})
}

// writeErr routes domain errors to the right envelope. Validation-class
// errors (ErrInvalidInput, ErrKeyConflict) carry operator-authored
// messages that are safe to echo. Unknown errors go through
// httperror.WriteInternal so err.Error() is logged server-side instead of
// being leaked to the client.
func (d *Deps) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "merge field not found")
	case errors.Is(err, ErrKeyConflict):
		httperror.Write(w, http.StatusConflict, "key_conflict", err.Error())
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	case errors.Is(err, ErrFieldInUse):
		httperror.Write(
			w,
			http.StatusConflict,
			"field_in_use",
			"This field has stored subscriber values. Clear or migrate those values before changing its type or deleting it.",
		)
	case errors.Is(err, ErrSchemaLimit):
		httperror.Write(
			w,
			http.StatusUnprocessableEntity,
			"schema_limit",
			"This workspace has reached the 50 audience-field limit. Delete an unused field before adding another.",
		)
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
