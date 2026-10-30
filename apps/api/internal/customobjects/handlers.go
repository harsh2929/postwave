// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — HTTP surface.
//
//	GET    /api/v1/custom-objects/types                        list
//	POST   /api/v1/custom-objects/types                        create
//	GET    /api/v1/custom-objects/types/{id}                   read
//	PUT    /api/v1/custom-objects/types/{id}                   update
//	DELETE /api/v1/custom-objects/types/{id}                   delete
//	GET    /api/v1/custom-objects/types/{id}/records           list records
//	POST   /api/v1/custom-objects/types/{id}/records/search    exact search
//	POST   /api/v1/custom-objects/types/{id}/records           create/update
//	GET    /api/v1/custom-objects/records/{id}                 read record
//	DELETE /api/v1/custom-objects/records/{id}                 delete record

package customobjects

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxRequestBytes = 1 << 20

// Deps bundles the handler deps.
type Deps struct {
	Store  Store
	Logger *slog.Logger
}

// MountRoutes mounts the custom-objects routes on r.
func (d *Deps) MountRoutes(r chi.Router) {
	read := []func(http.Handler) http.Handler{protectCustomObjectResponses, apikeys.RequireScope(apikeys.ScopeReadReports)}
	admin := []func(http.Handler) http.Handler{protectCustomObjectResponses, apikeys.RequireScope(apikeys.ScopeAdmin)}
	r.With(read...).Get("/api/v1/custom-objects/types", d.ListTypes)
	r.With(admin...).Post("/api/v1/custom-objects/types", d.CreateType)
	r.With(read...).Get("/api/v1/custom-objects/types/{id}", d.GetType)
	r.With(admin...).Put("/api/v1/custom-objects/types/{id}", d.UpdateType)
	r.With(admin...).Delete("/api/v1/custom-objects/types/{id}", d.DeleteType)
	r.With(read...).Get("/api/v1/custom-objects/types/{id}/records", d.ListRecords)
	// Exact property values can contain customer data and therefore never
	// belong in URLs, access logs, browser history, or referrer headers.
	r.With(read...).Post("/api/v1/custom-objects/types/{id}/records/search", d.SearchRecords)
	r.With(admin...).Post("/api/v1/custom-objects/types/{id}/records", d.UpsertRecord)
	r.With(read...).Get("/api/v1/custom-objects/records/{id}", d.GetRecord)
	r.With(admin...).Delete("/api/v1/custom-objects/records/{id}", d.DeleteRecord)
}

func (d *Deps) ListTypes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	out, err := d.Store.ListTypes(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateType(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var p CreateTypeParams
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := validateCreateTypeParams(&p); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	ctx := withMutationAuditMeta(r.Context(), middleware.AuditMetaFromRequest(r))
	out, err := d.Store.CreateType(ctx, t.ID, p)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			httperror.Write(w, http.StatusConflict, "key_taken", "object type key already exists")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetType(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	out, err := d.Store.GetType(r.Context(), t.ID, id)
	if err != nil {
		d.writeNotFoundOrErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateType(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	var p UpdateTypeParams
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := validateUpdateTypeParams(p); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	ctx := withMutationAuditMeta(r.Context(), middleware.AuditMetaFromRequest(r))
	out, err := d.Store.UpdateType(ctx, t.ID, id, p)
	if err != nil {
		d.writeMutationError(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteType(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	var p DeleteTypeParams
	if err := httpbody.DecodeJSON(w, r, 4096, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := validateDeleteTypeParams(p); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	ctx := withMutationAuditMeta(r.Context(), middleware.AuditMetaFromRequest(r))
	if err := d.Store.DeleteType(ctx, t.ID, id, p); err != nil {
		d.writeMutationError(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": true, "id": id, "expectedVersion": p.ExpectedVersion,
	})
}

func (d *Deps) ListRecords(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	q := r.URL.Query()
	for key := range q {
		if key != "limit" {
			if key == "property" || key == "value" {
				httperror.Write(w, http.StatusBadRequest, "unsafe_filter_transport", "Property filters must be sent to the records search endpoint so values do not enter URLs or logs.")
				return
			}
			httperror.Write(w, http.StatusBadRequest, "unknown_query_parameter", "The records request contains an unsupported query parameter.")
			return
		}
	}
	limit, err := parseRecordLimit(q.Get("limit"))
	if err != nil {
		writeRequestValidationError(w, err)
		return
	}
	out, err := d.Store.ListRecords(r.Context(), t.ID, id, ListRecordsFilter{Limit: limit})
	if err != nil {
		d.writeReadError(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SearchRecords keeps exact property values out of URLs and request logs.
// It is a read despite using POST; clients must omit Idempotency-Key and issue
// it online so the global mutation outbox never queues a stale search.
func (d *Deps) SearchRecords(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	var body struct {
		Property string `json:"property"`
		Value    string `json:"value"`
		Limit    int    `json:"limit,omitempty"`
	}
	if err := httpbody.DecodeJSON(w, r, 16<<10, &body); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	filter, err := validateListRecordsFilter(ListRecordsFilter{
		PropertyKey: body.Property, PropertyValue: body.Value, Limit: body.Limit,
	})
	if err != nil {
		writeRequestValidationError(w, err)
		return
	}
	out, err := d.Store.ListRecords(r.Context(), t.ID, id, filter)
	if err != nil {
		d.writeReadError(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpsertRecord(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	typeID := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(typeID); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	var p UpsertRecordParams
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := validateUpsertRecordParams(p); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	// The Store re-reads and validates the schema in the same transaction as
	// the write; doing it here would leave a schema-change race window.
	ctx := withMutationAuditMeta(r.Context(), middleware.AuditMetaFromRequest(r))
	out, err := d.Store.UpsertRecord(ctx, t.ID, typeID, p)
	if err != nil {
		var validation ValidationErrors
		if errors.As(err, &validation) && validation.HasErrors() {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": map[string]any{
					"code":    "validation_failed",
					"message": "Record properties do not satisfy the current type schema.",
					"fields":  validation,
				},
			})
			return
		}
		d.writeMutationError(w, r.Context(), err)
		return
	}
	status := http.StatusOK
	if p.ExpectedVersion == 0 {
		status = http.StatusCreated
	}
	writeJSON(w, status, out)
}

func (d *Deps) GetRecord(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	out, err := d.Store.GetRecord(r.Context(), t.ID, id)
	if err != nil {
		d.writeNotFoundOrErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteRecord(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := validateCanonicalUUID(id); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	var p DeleteRecordParams
	if err := httpbody.DecodeJSON(w, r, 16<<10, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if err := validateDeleteRecordParams(p); err != nil {
		writeRequestValidationError(w, err)
		return
	}
	ctx := withMutationAuditMeta(r.Context(), middleware.AuditMetaFromRequest(r))
	if err := d.Store.DeleteRecord(ctx, t.ID, id, p); err != nil {
		d.writeMutationError(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": true, "id": id, "expectedVersion": p.ExpectedVersion,
	})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (d *Deps) writeNotFoundOrErr(w http.ResponseWriter, ctx context.Context, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "The custom-object resource was not found.")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, ctx)
}

func (d *Deps) writeReadError(w http.ResponseWriter, ctx context.Context, err error) {
	var validation *RequestValidationError
	if errors.As(err, &validation) {
		writeRequestValidationError(w, validation)
		return
	}
	d.writeNotFoundOrErr(w, ctx, err)
}

func (d *Deps) writeMutationError(w http.ResponseWriter, ctx context.Context, err error) {
	var validation *RequestValidationError
	if errors.As(err, &validation) {
		writeRequestValidationError(w, validation)
		return
	}
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "The custom-object resource was not found.")
	case errors.Is(err, ErrStale):
		httperror.Write(w, http.StatusConflict, "stale_version", "The resource changed or the create-only natural key is already present. Refresh before trying again.")
	case errors.Is(err, ErrConfirmationMismatch):
		httperror.Write(w, http.StatusConflict, "confirmation_mismatch", "The deletion confirmation did not match the current resource.")
	case errors.Is(err, ErrTypeDisabled):
		httperror.Write(w, http.StatusConflict, "type_disabled", "This custom-object type is disabled and cannot accept record writes.")
	case errors.Is(err, ErrConflict):
		httperror.Write(w, http.StatusConflict, "conflict", "The custom-object mutation conflicts with an existing resource.")
	default:
		httperror.WriteInternal(w, d.Logger, err, ctx)
	}
}

func writeRequestValidationError(w http.ResponseWriter, err error) {
	var validation *RequestValidationError
	if !errors.As(err, &validation) {
		httperror.Write(w, http.StatusBadRequest, "invalid_request", "The custom-object request is invalid.")
		return
	}
	status := http.StatusBadRequest
	if validation.Code == "precondition_required" {
		status = http.StatusPreconditionRequired
	} else if validation.Code == "schema_too_large" {
		status = http.StatusRequestEntityTooLarge
	}
	httperror.Write(w, status, validation.Code, validation.Message)
}

func parseRecordLimit(raw string) (int, error) {
	if raw == "" {
		return defaultRecordPageSize, nil
	}
	if raw != strings.TrimSpace(raw) || len(raw) > 3 {
		return 0, invalid("invalid_limit", "limit must be a whole number from 1 to 500.")
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, invalid("invalid_limit", "limit must be a whole number from 1 to 500.")
		}
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxRecordPageSize {
		return 0, invalid("invalid_limit", "limit must be a whole number from 1 to 500.")
	}
	return value, nil
}

func protectCustomObjectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
