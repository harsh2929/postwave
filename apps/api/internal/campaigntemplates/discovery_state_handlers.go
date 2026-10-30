// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func (d *Deps) discoveryRepository() (templateDiscoveryRepository, bool) {
	repository, ok := d.Repo.(templateDiscoveryRepository)
	return repository, ok
}

func discoveryRequestContext(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return "", "", false
	}
	user, ok := middleware.UserFromContext(r.Context())
	if !ok || user == nil || strings.TrimSpace(user.ID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_user",
			"personal template library state requires an authenticated user")
		return "", "", false
	}
	return tenant.ID, user.ID, true
}

func requireDiscoveryIdempotencyKey(
	w http.ResponseWriter,
	r *http.Request,
) (string, bool) {
	values := r.Header.Values(idempotency.HeaderName)
	if len(values) == 0 || (len(values) == 1 && strings.TrimSpace(values[0]) == "") {
		httperror.WriteValidation(
			w,
			"idempotency_key_required",
			"Exactly one Idempotency-Key is required for ambiguous create recovery.",
		)
		return "", false
	}
	if len(values) != 1 {
		httperror.WriteValidation(
			w,
			"invalid_idempotency_key",
			"Idempotency-Key must be supplied exactly once as 1-255 valid UTF-8 bytes without control characters.",
		)
		return "", false
	}
	key, err := normalizeDiscoveryIdempotencyKey(values[0])
	if err != nil {
		httperror.WriteValidation(
			w,
			"invalid_idempotency_key",
			"Idempotency-Key must be supplied exactly once as 1-255 valid UTF-8 bytes without control characters.",
		)
		return "", false
	}
	return key, true
}

func requireDiscoveryIfMatch(
	w http.ResponseWriter,
	r *http.Request,
	resource, id string,
) (int64, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 ||
		(len(values) == 1 &&
			(strings.TrimSpace(values[0]) == "" || strings.TrimSpace(values[0]) == "*")) {
		httpcache.WritePreconditionRequired(w)
		return 0, false
	}
	raw := ""
	if len(values) == 1 {
		raw = strings.TrimSpace(values[0])
	}
	prefix := `"` + resource + `:` + id + `:v`
	if len(values) != 1 || strings.HasPrefix(raw, "W/") ||
		strings.Contains(raw, ",") || !strings.HasPrefix(raw, prefix) ||
		!strings.HasSuffix(raw, `"`) {
		httpcache.WritePreconditionFailed(w)
		return 0, false
	}
	versionText := strings.TrimSuffix(strings.TrimPrefix(raw, prefix), `"`)
	version, err := strconv.ParseInt(versionText, 10, 64)
	if err != nil || version < 1 ||
		raw != httpcache.ETagStrong(resource, id, version) {
		httpcache.WritePreconditionFailed(w)
		return 0, false
	}
	return version, true
}

func writeDiscoveryError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	switch {
	case errors.Is(err, ErrCollectionNotFound), errors.Is(err, ErrSavedSearchNotFound),
		errors.Is(err, ErrNotFound), errors.Is(err, ErrTemplateIdentifierMissing):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrDiscoveryNameConflict):
		httperror.Write(w, http.StatusConflict, "name_conflict", "A personal library item with that name already exists.")
	case errors.Is(err, ErrDiscoveryPrecondition):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrDiscoveryIdempotencyReuse):
		httperror.Write(
			w,
			http.StatusUnprocessableEntity,
			"idempotency_key_request_mismatch",
			"Idempotency-Key was already used with a different create request.",
		)
	case errors.Is(err, ErrDiscoveryIdempotencyKey):
		httperror.WriteValidation(
			w,
			"invalid_idempotency_key",
			"Idempotency-Key must be supplied exactly once as 1-255 valid UTF-8 bytes without control characters.",
		)
	case errors.Is(err, ErrInvalidCollectionItems):
		httperror.WriteValidation(w, "invalid_template_ids", "template_ids must contain at most 100 unique template UUIDs")
	case errors.Is(err, ErrInvalidCompareSelection):
		httperror.WriteValidation(w, "invalid_compare_selection", "Provide two to four unique template IDs or slugs.")
	case errors.Is(err, ErrInvalidDiscoveryName):
		httperror.WriteValidation(w, "invalid_name", "name must contain 1 to 120 characters and description at most 1000")
	case errors.Is(err, ErrInvalidSavedSearch), errors.Is(err, ErrInvalidGoal),
		errors.Is(err, ErrInvalidTemplateKind), errors.Is(err, ErrInvalidArchiveFilter),
		errors.Is(err, ErrInvalidCatalogSort), errors.Is(err, ErrInvalidCatalogCursor):
		httperror.WriteValidation(w, "invalid_saved_search", "saved search filters are invalid")
	case errors.Is(err, ErrDiscoveryUserRequired):
		httperror.Write(w, http.StatusUnauthorized, "no_user", "personal template library state requires an authenticated user")
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func projectRecentViewsForRequest(ctx context.Context, views []RecentTemplateView) {
	for index := range views {
		projectTemplateForRequest(ctx, &views[index].Template)
	}
}

func projectCollectionForRequest(ctx context.Context, collection *CampaignTemplateCollection) {
	for index := range collection.Items {
		projectTemplateForRequest(ctx, &collection.Items[index])
	}
}

func (d *Deps) RecordRecentView(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, ok := d.discoveryRepository()
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	view, err := repository.RecordRecentView(r.Context(), tenantID, userID, chi.URLParam(r, "id"))
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectTemplateForRequest(r.Context(), &view.Template)
	writeJSON(w, http.StatusOK, view)
}

func (d *Deps) ListRecentViews(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, ok := d.discoveryRepository()
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	views, err := repository.ListRecentViews(
		r.Context(), tenantID, userID,
		intQuery(r.URL.Query().Get("limit"), defaultRecentTemplateLimit),
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectRecentViewsForRequest(r.Context(), views)
	writeJSON(w, http.StatusOK, map[string]any{"items": views})
}

func (d *Deps) ClearRecentViews(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, ok := d.discoveryRepository()
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	count, err := repository.ClearRecentViews(
		r.Context(), tenantID, userID, chi.URLParam(r, "id"),
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cleared": count})
}

func (d *Deps) ListCollections(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	items, err := repository.ListCollections(r.Context(), tenantID, userID)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) GetCollection(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	collection, err := repository.GetCollection(
		r.Context(), tenantID, userID, chi.URLParam(r, "id"),
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectCollectionForRequest(r.Context(), collection)
	w.Header().Set("ETag", collection.ETag)
	writeJSON(w, http.StatusOK, collection)
}

func (d *Deps) CreateCollection(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	idempotencyKey, ok := requireDiscoveryIdempotencyKey(w, r)
	if !ok {
		return
	}
	var in CreateCampaignTemplateCollectionInput
	if err := httpbody.DecodeJSON(w, r, discoveryStateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	collection, err := repository.CreateCollectionIdempotent(
		r.Context(), tenantID, userID, idempotencyKey, in,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectCollectionForRequest(r.Context(), collection)
	w.Header().Set("ETag", collection.ETag)
	writeJSON(w, http.StatusCreated, collection)
}

func (d *Deps) UpdateCollection(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	expectedVersion, ok := requireDiscoveryIfMatch(
		w, r, "campaign-template-collection", id,
	)
	if !ok {
		return
	}
	var in UpdateCampaignTemplateCollectionInput
	if err := httpbody.DecodeJSON(w, r, discoveryStateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	collection, err := repository.UpdateCollectionIfVersion(
		r.Context(), tenantID, userID, id, expectedVersion, in,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectCollectionForRequest(r.Context(), collection)
	w.Header().Set("ETag", collection.ETag)
	writeJSON(w, http.StatusOK, collection)
}

func (d *Deps) ReplaceCollectionItems(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	expectedVersion, ok := requireDiscoveryIfMatch(
		w, r, "campaign-template-collection", id,
	)
	if !ok {
		return
	}
	var in ReplaceCampaignTemplateCollectionItemsInput
	if err := httpbody.DecodeJSON(w, r, discoveryStateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	collection, err := repository.ReplaceCollectionItemsIfVersion(
		r.Context(), tenantID, userID, id, expectedVersion, in.TemplateIDs,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectCollectionForRequest(r.Context(), collection)
	w.Header().Set("ETag", collection.ETag)
	writeJSON(w, http.StatusOK, collection)
}

func (d *Deps) DeleteCollection(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	expectedVersion, ok := requireDiscoveryIfMatch(
		w, r, "campaign-template-collection", id,
	)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	deleted, err := repository.DeleteCollectionIfVersion(
		r.Context(), tenantID, userID, id, expectedVersion,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (d *Deps) ListSavedSearches(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	items, err := repository.ListSavedSearches(r.Context(), tenantID, userID)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) GetSavedSearch(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	saved, err := repository.GetSavedSearch(
		r.Context(), tenantID, userID, chi.URLParam(r, "id"),
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	w.Header().Set("ETag", saved.ETag)
	writeJSON(w, http.StatusOK, saved)
}

func (d *Deps) CreateSavedSearch(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	idempotencyKey, ok := requireDiscoveryIdempotencyKey(w, r)
	if !ok {
		return
	}
	var in CreateCampaignTemplateSavedSearchInput
	if err := httpbody.DecodeJSON(w, r, discoveryStateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	saved, err := repository.CreateSavedSearchIdempotent(
		r.Context(), tenantID, userID, idempotencyKey, in,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	w.Header().Set("ETag", saved.ETag)
	writeJSON(w, http.StatusCreated, saved)
}

func (d *Deps) UpdateSavedSearch(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	expectedVersion, ok := requireDiscoveryIfMatch(
		w, r, "campaign-template-saved-search", id,
	)
	if !ok {
		return
	}
	var in UpdateCampaignTemplateSavedSearchInput
	if err := httpbody.DecodeJSON(w, r, discoveryStateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	saved, err := repository.UpdateSavedSearchIfVersion(
		r.Context(), tenantID, userID, id, expectedVersion, in,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	w.Header().Set("ETag", saved.ETag)
	writeJSON(w, http.StatusOK, saved)
}

func (d *Deps) DeleteSavedSearch(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	expectedVersion, ok := requireDiscoveryIfMatch(
		w, r, "campaign-template-saved-search", id,
	)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	deleted, err := repository.DeleteSavedSearchIfVersion(
		r.Context(), tenantID, userID, id, expectedVersion,
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (d *Deps) SavedSearchResults(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := discoveryRequestContext(w, r)
	if !ok {
		return
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	saved, err := repository.GetSavedSearch(
		r.Context(), tenantID, userID, chi.URLParam(r, "id"),
	)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	filter := saved.Filters.SearchFilter(userID)
	filter.Cursor = r.URL.Query().Get("cursor")
	filter.PerPage = intQuery(r.URL.Query().Get("per_page"), defaultCatalogPageSize)
	result, err := d.Repo.Search(r.Context(), tenantID, filter)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	projectTemplatesForRequest(r.Context(), result.Items)
	writeJSON(w, http.StatusOK, result)
}

func (d *Deps) CompareTemplates(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	userID := ""
	if user, ok := middleware.UserFromContext(r.Context()); ok && user != nil {
		userID = user.ID
	}
	identifiers := r.URL.Query()["template"]
	if len(identifiers) == 0 {
		identifiers = strings.Split(r.URL.Query().Get("templates"), ",")
	}
	repository, configured := d.discoveryRepository()
	if !configured {
		httperror.Write(w, http.StatusServiceUnavailable, "discovery_state_unavailable", "")
		return
	}
	result, err := repository.CompareTemplates(r.Context(), tenant.ID, userID, identifiers)
	if err != nil {
		writeDiscoveryError(w, r, d, err)
		return
	}
	for index := range result.Items {
		projectTemplateForRequest(r.Context(), &result.Items[index].Template)
	}
	writeJSON(w, http.StatusOK, result)
}
