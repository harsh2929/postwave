// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles the assets handler dependencies.
type Deps struct {
	Repo    *Repo
	Storage Storage
	// Logger is used by httperror.WriteInternal to record server-side
	// detail for 5xx errors without echoing raw err.Error() text in the
	// HTTP response. May be nil in tests; httperror tolerates that.
	Logger *slog.Logger

	// Narrow test seams keep storage compensation and checked-delete failure
	// behaviour unit-testable without replacing the public concrete Repo field.
	insertRepo assetInserter
	deleteRepo checkedAssetDeleter
}

type assetInserter interface {
	Insert(context.Context, string, Asset) (*Asset, error)
}

type checkedAssetDeleter interface {
	DeleteChecked(context.Context, string, string, int64, bool) (int64, int, []Referrer, error)
}

const (
	assetMultipartMaxBodyBytes int64 = MaxBytes + 1024
	assetJSONMaxBodyBytes      int64 = 2 * MaxBytes
	assetPatchMaxBodyBytes     int64 = 8 * 1024
)

// MountRoutes registers the asset library admin endpoints + blob server.
//
// Scope policy (mirrors landing-pages / campaign-templates):
//   - Reads (List/GetByID/GetUsage/Blob): ScopeReadCampaigns — assets
//     are campaign content; viewers reading campaigns must render them.
//   - Writes (Upload/Patch/Delete): ScopeWriteCampaigns — matches the
//     desktop frontend's `useCanWrite` gate (admin or editor). Without
//     these wrappers, the frontend permission check was cosmetic only
//     and any authenticated key could mutate the library.
//
// Refined Library (PR 1) added:
//   - GET    /api/v1/assets/{id}            single-asset read with refreshed usage
//   - GET    /api/v1/assets/{id}/usage      live referrer list
//   - PATCH  /api/v1/assets/{id}            edits alt_text only
//   - DELETE /api/v1/assets/{id} accepts {expected_version, force} and gates on references_count
//   - GET    /api/v1/assets?q&sort&filter   new query params; response gains `counts`
func (d *Deps) MountRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(write).Post("/api/v1/assets", d.Upload)
	r.With(read).Get("/api/v1/assets", d.List)
	r.With(read).Get("/api/v1/assets/{id}", d.GetByID)
	r.With(read).Get("/api/v1/assets/{id}/usage", d.GetUsage)
	r.With(write).Patch("/api/v1/assets/{id}", d.Patch)
	r.With(write).Delete("/api/v1/assets/{id}", d.Delete)
	r.With(read).Get("/api/v1/assets/{id}/blob", d.Blob)
	// Workstream 4 (Mailchimp parity polish): asset tag CRUD.
	// Reads scope to read_campaigns (tags are surfaced alongside the
	// asset list); writes piggyback on the same scope as PATCH alt_text.
	r.With(read).Get("/api/v1/assets/tags", d.ListTenantTags)
	r.With(read).Get("/api/v1/assets/{id}/tags", d.GetTags)
	r.With(write).Post("/api/v1/assets/{id}/tags", d.AddTags)
	r.With(write).Delete("/api/v1/assets/{id}/tags/{tag}", d.RemoveTag)
}

// Upload accepts a multipart upload (field "file") OR a JSON body
// {filename, mime, content_base64} for SDK callers that prefer JSON.
func (d *Deps) Upload(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var (
		filename        string
		body            []byte
		declared        string
		expectedVersion *int64
	)
	ct := r.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(ct, "multipart/form-data"):
		if r.ContentLength > assetMultipartMaxBodyBytes {
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "asset upload exceeds maximum multipart request size"))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, assetMultipartMaxBodyBytes)
		// #nosec G120 -- MaxBytesReader above caps the entire encoded request,
		// while ParseMultipartForm independently caps memory-backed parts.
		if err := r.ParseMultipartForm(assetMultipartMaxBodyBytes); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "asset upload exceeds maximum multipart request size"))
				return
			}
			// stdlib multipart errors can be noisy; keep a stable
			// operator-authored message rather than echoing the
			// raw parser text.
			httperror.Write(w, http.StatusBadRequest, "bad_form", "multipart form could not be parsed")
			return
		}
		f, fh, err := r.FormFile("file")
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "missing_file", "multipart request is missing the required \"file\" field")
			return
		}
		defer func() { _ = f.Close() }()
		body, err = io.ReadAll(io.LimitReader(f, MaxBytes+1))
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		filename = fh.Filename
		declared = fh.Header.Get("Content-Type")
		if values, present := r.MultipartForm.Value["expected_version"]; present && len(values) == 1 {
			parsed, parseErr := strconv.ParseInt(values[0], 10, 64)
			if parseErr == nil {
				expectedVersion = &parsed
			}
		}
	default:
		var in struct {
			Filename        string `json:"filename"`
			Mime            string `json:"mime"`
			ContentBase64   string `json:"content_base64"`
			ExpectedVersion *int64 `json:"expected_version"`
		}
		if r.ContentLength > assetJSONMaxBodyBytes {
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "asset JSON upload exceeds maximum request size"))
			return
		}
		if err := httpbody.DecodeJSON(w, r, assetJSONMaxBodyBytes, &in); err != nil {
			// httpbody.DecodeJSON returns operator-safe text and codes
			// (bad_json / payload_too_large) that are in the
			// httperror.IsValidationCode allowlist.
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
		decoded, err := DecodeBase64(in.ContentBase64)
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "bad_base64", "content_base64 is not valid base64")
			return
		}
		body = decoded
		filename = in.Filename
		declared = in.Mime
		expectedVersion = in.ExpectedVersion
	}
	if expectedVersion == nil || *expectedVersion != 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be 0 for an asset create"))
		return
	}
	// Distinct unavailability codes preserved for the HTTP contract; checked
	// before delegating so UploadBytes' own ErrNotConfigured guard (for the
	// request-less tool path) need not be disambiguated here.
	if !d.canInsert() {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	if d.Storage == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("storage_unavailable", "asset storage is not configured"))
		return
	}
	saved, err := d.UploadBytes(r.Context(), t.ID, filename, declared, body)
	if err != nil {
		var storageErr *StorageLimitError
		switch {
		case errors.Is(err, errEmpty), errors.Is(err, errTooBig), errors.Is(err, errBadType):
			// ValidateUpload sentinels — operator-authored, safe to surface.
			httperror.WriteValidation(w, "validation_failed", err.Error())
		case errors.Is(err, ErrNotConfigured):
			writeJSON(w, http.StatusServiceUnavailable, errEnv("unavailable", "an internal error occurred"))
		case errors.As(err, &storageErr):
			limit, current := storageErr.Limit, storageErr.Current
			entitlement.Write(w, entitlement.Denial{Subject: "workspace", Reason: entitlement.ReasonQuota, Code: "asset_storage_limit_exceeded", Message: "Asset storage allowance reached.", Resource: string(limits.ResourceAssetStorage), Limit: &limit, Current: &current})
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

// UploadBytes validates, stores, and records an uploaded asset from raw
// bytes. It is the request-less core shared by the HTTP Upload handler and
// the native upload_asset agent tool — keeping the storage-key generation,
// filename sanitisation, image validation, blob Put, and row Insert in one
// place. Returns the ValidateUpload sentinels (errEmpty/errTooBig/errBadType)
// for bad input, ErrNotConfigured when storage/repo are unwired, and the
// underlying Storage.Put / Repo.Insert error otherwise.
func (d *Deps) UploadBytes(ctx context.Context, tenantID, filename, _ string, body []byte) (*Asset, error) {
	validated, err := validateAndSanitizeUpload(ctx, body)
	if err != nil {
		return nil, err
	}
	mime, width, height := validated.mime, validated.width, validated.height
	body = validated.body
	if filename == "" {
		filename = "upload" + extForMime(mime)
	}
	filename = sanitizeAssetFilename(filename, mime)
	if d == nil || !d.canInsert() || d.Storage == nil {
		return nil, ErrNotConfigured
	}
	asset := Asset{
		ID:       uuid.NewString(),
		Filename: filename,
		Mime:     mime,
		Bytes:    int64(len(body)),
		Width:    width,
		Height:   height,
	}
	asset.StorageKey = asset.ID + "/" + filename
	publicURL, err := d.Storage.Put(ctx, asset.StorageKey, mime, body)
	if err != nil {
		return nil, err
	}
	asset.URL = publicURL
	saved, err := d.insertAsset(ctx, tenantID, asset)
	if err == nil {
		return saved, nil
	}
	// The blob is not reachable through a committed asset row. Compensate with
	// a bounded context that survives a request cancellation during commit.
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if cleanupErr := d.Storage.Delete(cleanupCtx, asset.StorageKey); cleanupErr != nil && d.Logger != nil {
		d.Logger.ErrorContext(ctx, "asset upload compensation failed", "storage_key", asset.StorageKey, "error", cleanupErr)
	}
	return nil, err
}

func (d *Deps) canInsert() bool {
	return d != nil && (d.insertRepo != nil || d.Repo != nil && d.Repo.Pool != nil)
}

func (d *Deps) insertAsset(ctx context.Context, tenantID string, asset Asset) (*Asset, error) {
	if d.insertRepo != nil {
		return d.insertRepo.Insert(ctx, tenantID, asset)
	}
	return d.Repo.Insert(ctx, tenantID, asset)
}

func (d *Deps) checkedDelete(ctx context.Context, tenantID, id string, expectedVersion int64, force bool) (int64, int, []Referrer, error) {
	if d.deleteRepo != nil {
		return d.deleteRepo.DeleteChecked(ctx, tenantID, id, expectedVersion, force)
	}
	return d.Repo.DeleteChecked(ctx, tenantID, id, expectedVersion, force)
}

func (d *Deps) canDelete() bool {
	return d != nil && (d.deleteRepo != nil || d.Repo != nil && d.Repo.Pool != nil)
}

// List GET /api/v1/assets?limit&before&q&sort&filter
//
// Response envelope: {"items": [...], "counts": {...}, "nextCursor": string|null}.
// Counts describe the FULL tenant asset set (ignoring filter/limit/before) so
// smart-filter chip totals stay stable across paginations.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	query := r.URL.Query()
	allowed := map[string]struct{}{
		"limit": {}, "before": {}, "q": {}, "sort": {}, "filter": {}, "tag": {}, "folder_id": {},
	}
	for key, values := range query {
		if _, ok := allowed[key]; !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("unknown_query", "asset list contains an unsupported query parameter"))
			return
		}
		if len(values) != 1 {
			writeJSON(w, http.StatusBadRequest, errEnv("duplicate_query", "asset list query parameters may appear only once"))
			return
		}
	}
	limit := 50
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be an integer from 1 to 500"))
			return
		}
		limit = parsed
	}
	p := ListParams{
		Limit:  limit,
		Before: r.URL.Query().Get("before"),
		Query:  strings.TrimSpace(r.URL.Query().Get("q")),
		Sort:   r.URL.Query().Get("sort"),
		Filter: r.URL.Query().Get("filter"),
		Tag:    strings.TrimSpace(r.URL.Query().Get("tag")),
	}
	if !validAssetSearch(p.Query) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", "q must be at most 200 valid characters"))
		return
	}
	if p.Before != "" && !isCanonicalAssetUUID(p.Before) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "before must be a canonical lowercase UUID"))
		return
	}
	switch p.Sort {
	case "", "newest", "oldest", "largest", "name", "most-used":
	default:
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_sort", "sort must be newest, oldest, largest, name, or most-used"))
		return
	}
	switch p.Filter {
	case "", "all", "recent", "in-use", "unused", "large":
	default:
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_filter", "filter must be all, recent, in-use, unused, or large"))
		return
	}
	if p.Tag != "" && !validTagInput(p.Tag) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_tag", "tag must be 1 to 64 valid characters"))
		return
	}
	// Folder filter — empty / absent = no scoping; "root" = the
	// Uncategorised bucket (folder_id IS NULL); any other value is
	// taken as a folder uuid. Mailchimp-parity follow-up.
	if raw := strings.TrimSpace(r.URL.Query().Get("folder_id")); raw != "" {
		if raw == folderRootSentinel {
			empty := ""
			p.FolderID = &empty
		} else {
			if !isCanonicalAssetUUID(raw) {
				writeJSON(w, http.StatusBadRequest, errEnv("invalid_folder", "folder_id must be root or a canonical lowercase UUID"))
				return
			}
			v := raw
			p.FolderID = &v
		}
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	items, counts, nextCursor, err := d.Repo.ListPageWithCounts(r.Context(), t.ID, p)
	if err != nil {
		if errors.Is(err, ErrInvalidCursor) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "before does not identify a current asset in this tenant"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var next any
	if nextCursor != "" {
		next = nextCursor
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "counts": counts, "nextCursor": next})
}

// GetByID GET /api/v1/assets/{id} — returns the asset plus a freshly-computed
// referrer list. The on-demand recompute makes the response authoritative at
// the moment of the read (the periodic refresher's cached scalar may lag).
func (d *Deps) GetByID(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "asset id must be a canonical lowercase UUID"))
		return
	}
	a, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Usage is part of this response's contract; do not label a cached scalar
	// as current when the authoritative recompute failed.
	count, refs, err := d.Repo.RecomputeReferenceCount(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	a.ReferencesCount = count
	if refs == nil {
		refs = []Referrer{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"asset": a, "usage": refs})
}

// GetUsage GET /api/v1/assets/{id}/usage — referrer list only.
func (d *Deps) GetUsage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "asset id must be a canonical lowercase UUID"))
		return
	}
	_, refs, err := d.Repo.RecomputeReferenceCount(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if refs == nil {
		refs = []Referrer{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": refs})
}

// Patch PATCH /api/v1/assets/{id} — accepts only {"alt_text": "..."}. Any
// other field is a 400. alt_text is capped at 1024 chars.
func (d *Deps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in map[string]any
	if err := httpbody.DecodeJSON(w, r, assetPatchMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes
		// (bad_json / payload_too_large) that are in the
		// httperror.IsValidationCode allowlist.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	for k := range in {
		if k != "alt_text" && k != "expected_version" {
			writeJSON(w, http.StatusBadRequest, errEnv("unknown_field", "PATCH accepts only alt_text and expected_version"))
			return
		}
	}
	altRaw, present := in["alt_text"]
	if !present {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_alt_text", "alt_text is required"))
		return
	}
	altText, ok := altRaw.(string)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_type", "alt_text must be a string"))
		return
	}
	if !utf8.ValidString(altText) || utf8.RuneCountInString(altText) > 1024 {
		writeJSON(w, http.StatusBadRequest, errEnv("alt_too_long", "alt_text must be <= 1024 characters"))
		return
	}
	expectedVersion, ok := exactPositiveJSONInteger(in["expected_version"])
	if !ok {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be a positive integer"))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "asset id must be a canonical lowercase UUID"))
		return
	}
	a, err := d.Repo.UpdateAltText(r.Context(), t.ID, id, altText, expectedVersion)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrStale):
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "asset changed after it was read"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// Delete DELETE /api/v1/assets/{id} — soft-deletes the asset. If the asset
// is currently referenced by a live draft and the caller did not pass
// force=true in the exact-version JSON body, returns 409 with the referrer list so the UI can present a
// confirm-anyway flow.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if !d.canDelete() {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "asset id must be a canonical lowercase UUID"))
		return
	}
	if r.URL.Query().Has("force") {
		writeJSON(w, http.StatusBadRequest, errEnv("unsafe_force_transport", "force must be supplied in the request body"))
		return
	}
	var in struct {
		ExpectedVersion *int64 `json:"expected_version"`
		Force           bool   `json:"force"`
	}
	raw, decodeErr := httpbody.ReadJSONAtMost(r, assetPatchMaxBodyBytes, httpbody.Options{AllowEmptyBody: true})
	if decodeErr != nil {
		httperror.Write(w, httpbody.StatusCode(decodeErr), httpbody.ErrorCode(decodeErr), httpbody.PublicMessage(decodeErr))
		return
	}
	if len(raw) > 0 {
		if decodeErr := httpbody.DecodeJSONValue(raw, &in, httpbody.Options{}); decodeErr != nil {
			httperror.Write(w, httpbody.StatusCode(decodeErr), httpbody.ErrorCode(decodeErr), httpbody.PublicMessage(decodeErr))
			return
		}
	}
	if in.ExpectedVersion == nil || *in.ExpectedVersion <= 0 {
		writeJSON(w, http.StatusPreconditionRequired, errEnv("expected_version_required", "expected_version must be a positive integer"))
		return
	}
	version, count, refs, err := d.checkedDelete(r.Context(), t.ID, id, *in.ExpectedVersion, in.Force)
	if err != nil {
		switch {
		case errors.Is(err, ErrHasReferences):
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": map[string]any{
					"code":    "has_references",
					"message": "asset is used by live drafts; confirm force in the request body to delete anyway",
					"count":   count,
					"usage":   refs,
					"version": version,
				},
			})
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		case errors.Is(err, ErrStale):
			writeJSON(w, http.StatusPreconditionFailed, errEnv("stale_version", "asset changed after it was read"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "version": version})
}

// Blob GET /api/v1/assets/{id}/blob — only used by the FS fallback storage.
func (d *Deps) Blob(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", "asset repository is not configured"))
		return
	}
	if d.Storage == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("storage_unavailable", "asset storage is not configured"))
		return
	}
	id := chi.URLParam(r, "id")
	if !isCanonicalAssetUUID(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "asset id must be a canonical lowercase UUID"))
		return
	}
	a, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rc, _, err := d.Storage.Open(r.Context(), a.StorageKey)
	if err != nil {
		// Storage errors here may reveal backend implementation
		// detail (filesystem paths, S3 SDK error text); keep the
		// 404 status but emit a stable operator-authored message.
		httperror.Write(w, http.StatusNotFound, "blob_missing", "blob is not available")
		return
	}
	defer func() { _ = rc.Close() }()
	w.Header().Set("Content-Type", safeAssetContentType(a.Mime))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if a.Bytes >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(a.Bytes, 10))
	}
	_, _ = io.Copy(w, rc)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func exactPositiveJSONInteger(value any) (int64, bool) {
	number, ok := value.(float64)
	if !ok || number < 1 || number > float64(1<<53-1) || number != float64(int64(number)) {
		return 0, false
	}
	return int64(number), true
}

func readExpectedVersionBody(w http.ResponseWriter, r *http.Request, maxBytes int64) (int64, bool) {
	var in struct {
		ExpectedVersion *int64 `json:"expected_version"`
	}
	raw, err := httpbody.ReadJSONAtMost(r, maxBytes, httpbody.Options{AllowEmptyBody: true})
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
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func extForMime(m string) string {
	switch m {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	}
	return ""
}

func sanitizeAssetFilename(name, mime string) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == "/" || name == "\\" {
		name = "upload"
	}
	// Never retain a caller-controlled or MIME-mismatched suffix. The stored
	// filename and object key always advertise the decoder-confirmed type.
	name = strings.TrimSuffix(name, filepath.Ext(name))
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	for strings.Contains(out, "..") {
		out = strings.ReplaceAll(out, "..", ".")
	}
	out = strings.TrimLeft(out, ".")
	if out == "" {
		out = "upload"
	}
	ext := extForMime(mime)
	if len(out) > 128-len(ext) {
		out = out[:128-len(ext)]
	}
	return out + ext
}

func safeAssetContentType(mime string) string {
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return mime
	default:
		return "application/octet-stream"
	}
}

func validAssetSearch(value string) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 200 {
		return false
	}
	for _, current := range value {
		if current < 0x20 || current == 0x7f || current >= 0x202a && current <= 0x202e || current >= 0x2066 && current <= 0x2069 {
			return false
		}
	}
	return true
}
