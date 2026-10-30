// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// collectionJSONMaxBodyBytes caps the complete create/update request envelope.
// The persisted data array has the tighter MaxDataBytes response-safety cap.
const collectionJSONMaxBodyBytes int64 = 4 << 20 // 4 MiB

// Deps bundles the repo for handler wiring.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log the
	// underlying error server-side while returning a generic envelope.
	Logger *slog.Logger
}

// MountRoutes registers the reference-collection CRUD endpoints. Metadata
// listing remains read:subscribers-scoped for compatibility. A full detail
// response can contain confidential lookup values, so detail and mutations
// require write:subscribers until a dedicated collection-data scope exists.
func MountRoutes(r chi.Router, d *Deps) {
	if r == nil {
		panic("collections: router is required")
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		panic("collections: repository pool is required")
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/collections", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Get("/api/v1/collections/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/collections", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch("/api/v1/collections/{id}", d.Update)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/collections/{id}", d.Delete)
}

// List GET /api/v1/collections
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	setCollectionResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	opts, queryErr := parseListOptions(r.URL.Query(), t.ID)
	if queryErr != nil {
		httperror.WriteValidation(w, queryErr.Code, queryErr.Message)
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID, opts)
	if err != nil {
		if errors.Is(err, pagination.ErrInvalidCursor) {
			httperror.WriteValidation(w, "invalid_cursor", "cursor is malformed")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Get GET /api/v1/collections/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	setCollectionResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := readCollectionID(w, r)
	if !ok {
		return
	}
	c, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "collection not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// Create POST /api/v1/collections
//
// Accepts a JSON body: { name, collection_type, source_type, data }.
// `data` is the parsed rows array — a multipart CSV/JSON upload is parsed
// client-side (or by a thin gateway shim) into this rows array before
// hitting this endpoint, so the persistence path is a single shape.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	setCollectionResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateInput
	raw, err := httpbody.DecodeJSONBytes(r, collectionJSONMaxBodyBytes, &in, httpbody.Options{UseNumber: true})
	if err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		writeJSONShapeError(w, err)
		return
	}
	var probe map[string]json.RawMessage
	if err := httpbody.DecodeJSONValue(raw, &probe, httpbody.Options{AllowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if rawJSONIsNull(probe["collection_type"]) || rawJSONIsNull(probe["source_type"]) {
		httperror.WriteValidation(w, "invalid_type", "collection_type and source_type must not be null")
		return
	}
	if rawJSONIsNull(probe["data"]) {
		httperror.WriteValidation(w, "invalid_data", "data must be an array of objects; use [] to clear it")
		return
	}
	in, err = normalizeCreateInput(in)
	if err != nil {
		writeInputValidationError(w, err)
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion != 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be 0 for a collection create"))
		return
	}
	c, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrNameConflict) {
			httperror.Write(w, http.StatusConflict, "collection_name_conflict", "a collection with this name already exists")
			return
		}
		if isInputValidationError(err) {
			writeInputValidationError(w, err)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

// Update PATCH /api/v1/collections/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	setCollectionResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := readCollectionID(w, r)
	if !ok {
		return
	}
	// Decode into a raw map first so we can tell "data omitted" from a present
	// replacement. Null is rejected; [] is the explicit clear operation.
	opts := httpbody.Options{AllowEmptyBody: true}
	raw, err := httpbody.ReadJSONAtMost(r, collectionJSONMaxBodyBytes, opts)
	if err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(raw) == 0 {
		httperror.WriteValidation(w, "invalid_update", "update body must contain at least one mutable field")
		return
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		writeJSONShapeError(w, err)
		return
	}
	var probe map[string]json.RawMessage
	if err := httpbody.DecodeJSONValue(raw, &probe, httpbody.Options{AllowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSONValue(raw, &in, httpbody.Options{UseNumber: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(probe) == 0 {
		httperror.WriteValidation(w, "invalid_update", "update body must contain at least one mutable field")
		return
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be a positive integer"))
		return
	}
	mutableFields := 0
	for _, field := range []string{"name", "collection_type", "source_type", "data"} {
		if _, present := probe[field]; present {
			mutableFields++
		}
	}
	if mutableFields == 0 {
		httperror.WriteValidation(w, "invalid_update", "update body must contain at least one mutable field")
		return
	}
	for _, field := range []string{"name", "collection_type", "source_type"} {
		if value, present := probe[field]; present && rawJSONIsNull(value) {
			httperror.WriteValidation(w, "invalid_update", field+" must not be null")
			return
		}
	}
	_, in.dataSet = probe["data"]
	if in.dataSet && rawJSONIsNull(probe["data"]) {
		httperror.WriteValidation(w, "invalid_data", "data must be an array of objects; use [] to clear it")
		return
	}

	in, err = normalizeUpdateInput(in)
	if err != nil {
		writeInputValidationError(w, err)
		return
	}
	c, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "collection not found"))
			return
		}
		if errors.Is(err, ErrNameConflict) {
			httperror.Write(w, http.StatusConflict, "collection_name_conflict", "a collection with this name already exists")
			return
		}
		if errors.Is(err, ErrStale) {
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "collection changed after it was read"))
			return
		}
		if isInputValidationError(err) {
			writeInputValidationError(w, err)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// Delete DELETE /api/v1/collections/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	setCollectionResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id, ok := readCollectionID(w, r)
	if !ok {
		return
	}
	expectedVersion, ok := readCollectionExpectedVersion(w, r)
	if !ok {
		return
	}
	version, err := d.Repo.Delete(r.Context(), t.ID, id, expectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "collection not found"))
		case errors.Is(err, ErrStale):
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "collection changed after it was read"))
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "version": version})
}

type listQueryError struct {
	Code    string
	Message string
}

func writeInputValidationError(w http.ResponseWriter, err error) {
	var validationErr *inputValidationError
	if errors.As(err, &validationErr) {
		httperror.WriteValidation(w, validationErr.Code, validationErr.Message)
		return
	}
	httperror.WriteValidation(w, "invalid_collection", "collection input is invalid")
}

func isInputValidationError(err error) bool {
	var validationErr *inputValidationError
	return errors.As(err, &validationErr)
}

func writeJSONShapeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDuplicateJSONKey):
		httperror.WriteValidation(w, "duplicate_json_key", errDuplicateJSONKey.Error())
	case errors.Is(err, errJSONNestingTooDeep):
		httperror.WriteValidation(w, "invalid_json_depth", errJSONNestingTooDeep.Error())
	case errors.Is(err, errInvalidJSONUnicode):
		httperror.WriteValidation(w, "invalid_json_unicode", errInvalidJSONUnicode.Error())
	default:
		httperror.WriteValidation(w, "invalid_json", "request body must contain one valid JSON value")
	}
}

func parseListOptions(query url.Values, tenantID string) (ListOptions, *listQueryError) {
	allowed := map[string]struct{}{
		"include_data":    {},
		"limit":           {},
		"cursor":          {},
		"q":               {},
		"collection_type": {},
	}
	for key := range query {
		if _, ok := allowed[key]; !ok {
			return ListOptions{}, &listQueryError{"invalid_query_parameter", "request contains an unsupported collection list query parameter"}
		}
	}
	if values, present := query["include_data"]; present {
		if len(values) != 1 {
			return ListOptions{}, &listQueryError{"invalid_include_data", "include_data must be specified once as true or false"}
		}
		switch values[0] {
		case "true":
			return ListOptions{}, &listQueryError{
				"include_data_not_supported",
				"collection lists are metadata-only; fetch one collection detail with write access",
			}
		case "false":
		default:
			return ListOptions{}, &listQueryError{"invalid_include_data", "include_data must be true or false"}
		}
	}
	defaultLimit, maxLimit := DefaultListLimit, MaxListLimit
	limit := defaultLimit
	if values, present := query["limit"]; present {
		if len(values) != 1 {
			return ListOptions{}, &listQueryError{"invalid_limit", "limit must be specified once"}
		}
		parsed, err := strconv.Atoi(values[0])
		if err != nil || parsed < 1 || parsed > maxLimit {
			return ListOptions{}, &listQueryError{"invalid_limit", fmt.Sprintf("limit must be an integer from 1 to %d", maxLimit)}
		}
		limit = parsed
	}
	if values := query["cursor"]; len(values) > 1 {
		return ListOptions{}, &listQueryError{"invalid_cursor", "cursor must be specified once"}
	}
	queryText := ""
	if values, present := query["q"]; present {
		if len(values) != 1 {
			return ListOptions{}, &listQueryError{"invalid_query", "q must be specified once"}
		}
		queryText = strings.TrimSpace(values[0])
		if utf8.RuneCountInString(queryText) > MaxListSearchLength {
			return ListOptions{}, &listQueryError{"invalid_query", fmt.Sprintf("q must be %d characters or fewer", MaxListSearchLength)}
		}
		for _, r := range queryText {
			if isUnsafeTextRune(r) {
				return ListOptions{}, &listQueryError{"invalid_query", "q must not contain control or bidirectional formatting characters"}
			}
		}
	}
	collectionType := ""
	if values, present := query["collection_type"]; present {
		if len(values) != 1 {
			return ListOptions{}, &listQueryError{"invalid_collection_type", "collection_type must be specified once"}
		}
		collectionType = strings.TrimSpace(values[0])
		if collectionType != "" && !isValidCollectionType(collectionType) {
			return ListOptions{}, &listQueryError{"invalid_collection_type", "collection_type must be one of: " + validCollectionTypeList}
		}
	}
	opts := ListOptions{
		Limit:          limit,
		Query:          queryText,
		CollectionType: collectionType,
	}
	cursor, err := decodeCollectionCursor(query.Get("cursor"), opts, tenantID)
	if err != nil {
		return ListOptions{}, &listQueryError{"invalid_cursor", "cursor is malformed or belongs to different filters"}
	}
	opts.Cursor = cursor
	return opts, nil
}

func readCollectionID(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, "id"))
	if raw == "" {
		httperror.WriteValidation(w, "missing_id", "id required")
		return "", false
	}
	id, err := normalizeCollectionID(raw)
	if err != nil {
		httperror.WriteValidation(w, "invalid_id", "id must be a UUID")
		return "", false
	}
	return id, true
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func setCollectionResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func readCollectionExpectedVersion(w http.ResponseWriter, r *http.Request) (int64, bool) {
	var in struct {
		ExpectedVersion *int64 `json:"expected_version"`
	}
	raw, err := httpbody.ReadJSONAtMost(r, 8*1024, httpbody.Options{AllowEmptyBody: true})
	if err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return 0, false
	}
	if len(raw) > 0 {
		if err := httpbody.DecodeJSONValue(raw, &in, httpbody.Options{}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return 0, false
		}
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be a positive integer"))
		return 0, false
	}
	return *in.ExpectedVersion, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	setCollectionResponseHeaders(w)
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(body)
}
