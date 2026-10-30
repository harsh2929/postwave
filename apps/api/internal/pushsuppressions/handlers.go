// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pushtoken"
)

var hashPrefixPattern = regexp.MustCompile(`^[0-9a-f]{8,16}$`)

type Deps struct {
	Pool             *db.Pool
	Logger           *slog.Logger
	AuthorityStore   AuthorityStore
	CursorSigningKey []byte
}

func (d *Deps) store() AuthorityStore {
	if d.AuthorityStore != nil {
		return d.AuthorityStore
	}
	return &Store{Pool: d.Pool}
}

// ProtectResponses is the route-local defense in depth: it stamps successful
// handler output and every exact-admin refusal in standalone composition. The
// production composition root mounts ProtectRoute43Responses outside all
// earlier credential, tenant, version, replay, and body-limit middleware.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protected := &privateResponseWriter{ResponseWriter: w}
		preparePrivateResponse(protected)
		next.ServeHTTP(protected, r)
	})
}

func preparePrivateResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Del("ETag")
}

// privateResponseWriter restamps at the commit boundary so an inner auth or
// error writer cannot weaken the route-local confidentiality policy.
type privateResponseWriter struct{ http.ResponseWriter }

func (w *privateResponseWriter) WriteHeader(status int) {
	preparePrivateResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *privateResponseWriter) Write(body []byte) (int, error) {
	preparePrivateResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

// FlushError is what http.ResponseController calls to flush. A flush commits
// the headers, so the private policy is stamped first: a flush that reached
// net/http through Unwrap alone would skip it. The underlying writer's answer
// is returned as-is, so this claims no streaming capability it lacks.
func (w *privateResponseWriter) FlushError() error {
	preparePrivateResponse(w.ResponseWriter)
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *privateResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (d *Deps) MountRoutes(r chi.Router) {
	admin := []func(http.Handler) http.Handler{ProtectResponses, apikeys.RequireExactTenantAdmin}
	r.With(admin...).Get("/api/v1/push/suppressions", d.List)
	r.With(admin...).Post("/api/v1/push/suppressions", d.Add)
	r.With(admin...).Post("/api/v1/push/suppressions/bulk-import", d.BulkImport)
	r.With(admin...).Post("/api/v1/push/suppressions/bulk-remove", d.BulkRemove)
	r.With(admin...).Delete("/api/v1/push/suppressions/{id}", d.Delete)
}

type listEnvelope struct {
	TenantID   string `json:"tenantId"`
	Items      []Row  `json:"items"`
	Total      int64  `json:"total"`
	NextCursor string `json:"nextCursor,omitempty"`
	SnapshotAt string `json:"snapshotAt"`
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := validatedTenant(w, r)
	if !ok {
		return
	}
	if !validCursorSigningKey(d.CursorSigningKey) {
		writeError(w, http.StatusServiceUnavailable, "push_suppressions_unavailable", "Push suppression pagination signing is unavailable.", "")
		return
	}
	filter, err := parseListFilter(r.URL.RawQuery, tenantID, d.CursorSigningKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error(), "")
		return
	}
	if !d.configured() {
		writeError(w, http.StatusServiceUnavailable, "push_suppressions_unavailable", "Push suppression storage is unavailable.", "")
		return
	}
	result, err := d.store().List(r.Context(), tenantID, filter, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeStoreError(w, r, err)
		return
	}
	filter.SnapshotAt = result.SnapshotAt
	filter.SnapshotRevision = result.SnapshotRevision
	next := ""
	if result.HasMore && len(result.Items) > 0 {
		next, err = encodeCursor(d.CursorSigningKey, tenantID, filter, result.Items[len(result.Items)-1])
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	if err := writeJSON(w, http.StatusOK, listEnvelope{
		TenantID: tenantID, Items: result.Items, Total: result.Total,
		NextCursor: next, SnapshotAt: result.SnapshotAt.UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

type addInput struct {
	DeviceToken string         `json:"device_token"`
	Platform    string         `json:"platform"`
	Reason      optionalReason `json:"reason,omitempty"`
}

type optionalReason struct {
	Value string
	Set   bool
}

func (r *optionalReason) UnmarshalJSON(body []byte) error {
	if string(body) == "null" {
		return errors.New("reason must be a string when supplied")
	}
	var value string
	if err := json.Unmarshal(body, &value); err != nil {
		return errors.New("reason must be a string when supplied")
	}
	r.Value, r.Set = value, true
	return nil
}

func (d *Deps) Add(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := validatedTenant(w, r)
	if !ok || !requireNoQuery(w, r) {
		return
	}
	var in addInput
	if !decodeJSON(w, r, maxSingleJSONBodyBytes, &in) {
		return
	}
	manual, err := validateAddInput(in)
	if err != nil {
		writeValidationError(w, err)
		return
	}
	if !d.configured() {
		writeError(w, http.StatusServiceUnavailable, "push_suppressions_unavailable", "Push suppression storage is unavailable.", "")
		return
	}
	result, err := d.store().AddManual(r.Context(), tenantID, manual, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeStoreError(w, r, err)
		return
	}
	status := http.StatusCreated
	if !result.Created {
		status = http.StatusOK
	}
	if err := writeJSON(w, status, result.Row); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

type removeInput struct {
	ExpectedVersion int64 `json:"expected_version"`
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := validatedTenant(w, r)
	if !ok || !requireNoQuery(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !canonicalUUID(id, true) {
		writeError(w, http.StatusUnprocessableEntity, "invalid_push_suppression_id", "Push suppression id must be a canonical UUIDv4.", "")
		return
	}
	var in removeInput
	if !decodeJSON(w, r, maxSingleJSONBodyBytes, &in) {
		return
	}
	if in.ExpectedVersion < 1 {
		writeError(w, http.StatusUnprocessableEntity, "invalid_expected_version", "expected_version must be a positive integer.", "")
		return
	}
	if !d.configured() {
		writeError(w, http.StatusServiceUnavailable, "push_suppressions_unavailable", "Push suppression storage is unavailable.", "")
		return
	}
	receipt, err := d.store().RemoveManual(r.Context(), tenantID, RemoveRequest{ID: id, ExpectedVersion: in.ExpectedVersion}, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeStoreError(w, r, err)
		return
	}
	if err := writeJSON(w, http.StatusOK, receipt); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

type bulkImportInput struct {
	Items []addInput `json:"items"`
}

type bulkImportReceipt struct {
	OK       bool   `json:"ok"`
	TenantID string `json:"tenantId"`
	Created  int    `json:"created"`
	Existing int    `json:"existing"`
	Items    []Row  `json:"items"`
}

func (d *Deps) BulkImport(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := validatedTenant(w, r)
	if !ok || !requireNoQuery(w, r) {
		return
	}
	var in bulkImportInput
	if !decodeJSON(w, r, maxBulkJSONBodyBytes, &in) {
		return
	}
	if len(in.Items) == 0 || len(in.Items) > maxBulkItems {
		writeError(w, http.StatusUnprocessableEntity, "invalid_bulk_size", "items must contain between 1 and 100 entries.", "")
		return
	}
	items := make([]ManualAdd, len(in.Items))
	seen := make(map[string]struct{}, len(in.Items))
	for i, item := range in.Items {
		validated, err := validateAddInput(item)
		if err != nil {
			writeValidationError(w, fmt.Errorf("items[%d]: %w", i, err))
			return
		}
		digest := sha256.Sum256([]byte(validated.DeviceToken))
		key := validated.Platform + ":" + hex.EncodeToString(digest[:])
		if _, duplicate := seen[key]; duplicate {
			writeError(w, http.StatusUnprocessableEntity, "duplicate_bulk_item", "items must not repeat a platform and device token.", "")
			return
		}
		seen[key] = struct{}{}
		items[i] = validated
	}
	if !d.configured() {
		writeError(w, http.StatusServiceUnavailable, "push_suppressions_unavailable", "Push suppression storage is unavailable.", "")
		return
	}
	result, err := d.store().BulkAddManual(r.Context(), tenantID, items, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeStoreError(w, r, err)
		return
	}
	if err := writeJSON(w, http.StatusOK, bulkImportReceipt{
		OK: true, TenantID: tenantID, Created: result.Created,
		Existing: result.Existing, Items: result.Rows,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

type bulkRemoveInput struct {
	Items []RemoveRequest `json:"items"`
}

type bulkRemoveReceipt struct {
	OK              bool            `json:"ok"`
	TenantID        string          `json:"tenantId"`
	Removed         int             `json:"removed"`
	StillSuppressed int             `json:"stillSuppressed"`
	Items           []RemoveReceipt `json:"items"`
}

func (d *Deps) BulkRemove(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := validatedTenant(w, r)
	if !ok || !requireNoQuery(w, r) {
		return
	}
	var in bulkRemoveInput
	if !decodeJSON(w, r, maxBulkJSONBodyBytes, &in) {
		return
	}
	if len(in.Items) == 0 || len(in.Items) > maxBulkItems {
		writeError(w, http.StatusUnprocessableEntity, "invalid_bulk_size", "items must contain between 1 and 100 entries.", "")
		return
	}
	seen := make(map[string]struct{}, len(in.Items))
	for i := range in.Items {
		if !canonicalUUID(in.Items[i].ID, true) {
			writeError(w, http.StatusUnprocessableEntity, "invalid_push_suppression_id", "Every id must be a canonical UUIDv4.", "")
			return
		}
		if in.Items[i].ExpectedVersion < 1 {
			writeError(w, http.StatusUnprocessableEntity, "invalid_expected_version", "Every expected_version must be a positive integer.", "")
			return
		}
		if _, duplicate := seen[in.Items[i].ID]; duplicate {
			writeError(w, http.StatusUnprocessableEntity, "duplicate_bulk_item", "items must not repeat an id.", "")
			return
		}
		seen[in.Items[i].ID] = struct{}{}
	}
	if !d.configured() {
		writeError(w, http.StatusServiceUnavailable, "push_suppressions_unavailable", "Push suppression storage is unavailable.", "")
		return
	}
	result, err := d.store().BulkRemoveManual(r.Context(), tenantID, in.Items, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeStoreError(w, r, err)
		return
	}
	if err := writeJSON(w, http.StatusOK, bulkRemoveReceipt{
		OK: true, TenantID: tenantID, Removed: result.Removed,
		StillSuppressed: result.StillSuppressed, Items: result.Receipts,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func parseListFilter(rawQuery, tenantID string, cursorKey []byte) (ListFilter, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return ListFilter{}, errors.New("query string is malformed")
	}
	allowed := map[string]bool{"platform": true, "reason": true, "hash_prefix": true, "cursor": true, "limit": true}
	for key, entries := range values {
		if !allowed[key] {
			return ListFilter{}, fmt.Errorf("unknown query parameter %q", key)
		}
		if len(entries) != 1 || entries[0] == "" {
			return ListFilter{}, fmt.Errorf("query parameter %q must appear exactly once with a value", key)
		}
	}
	platform := first(values, "platform")
	reason := first(values, "reason")
	hashPrefix := first(values, "hash_prefix")
	if platform != "" && !validPlatforms[platform] {
		return ListFilter{}, errors.New("platform must be one of apns, fcm, web")
	}
	if reason != "" && !validReasons[reason] {
		return ListFilter{}, errors.New("reason is not a recognized suppression reason")
	}
	if hashPrefix != "" && !hashPrefixPattern.MatchString(hashPrefix) {
		return ListFilter{}, errors.New("hash_prefix must be 8 to 16 lowercase hexadecimal characters")
	}
	limit := defaultPageLimit
	if raw := first(values, "limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxPageLimit || strconv.Itoa(parsed) != raw {
			return ListFilter{}, errors.New("limit must be a canonical integer from 1 to 100")
		}
		limit = parsed
	}
	filter := ListFilter{Platform: platform, Reason: reason, HashPrefix: hashPrefix, Limit: limit}
	if raw := first(values, "cursor"); raw != "" {
		decoded, err := decodeCursor(cursorKey, raw, tenantID, platform, reason, hashPrefix)
		if err != nil {
			return ListFilter{}, errors.New("cursor is invalid or does not match this tenant and filter set")
		}
		decoded.Limit = limit
		filter = decoded
	}
	return filter, nil
}

func first(values url.Values, key string) string {
	if entries := values[key]; len(entries) == 1 {
		return entries[0]
	}
	return ""
}

func validateAddInput(in addInput) (ManualAdd, error) {
	if !validPlatforms[in.Platform] {
		return ManualAdd{}, errors.New("platform must be one of apns, fcm, web")
	}
	reason := "manual"
	if in.Reason.Set {
		reason = in.Reason.Value
	}
	if reason != "manual" {
		return ManualAdd{}, errors.New("dashboard writes may create only manual suppression authority")
	}
	if err := validateToken(in.DeviceToken); err != nil {
		return ManualAdd{}, err
	}
	return ManualAdd{DeviceToken: in.DeviceToken, Platform: in.Platform}, nil
}

func validateToken(token string) error {
	return pushtoken.ValidateExact(token)
}

func validatedTenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "no_tenant", "A tenant is required.", "")
		return "", false
	}
	if !canonicalUUID(tenant.ID, false) {
		writeError(w, http.StatusServiceUnavailable, "tenant_identity_unavailable", "The tenant identity is unavailable.", "")
		return "", false
	}
	return tenant.ID, true
}

func requireNoQuery(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery == "" {
		return true
	}
	if _, err := url.ParseQuery(r.URL.RawQuery); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", "Query string is malformed.", "")
	} else {
		writeError(w, http.StatusBadRequest, "invalid_query", "This operation does not accept query parameters.", "")
	}
	return false
}

func decodeJSON(w http.ResponseWriter, r *http.Request, max int64, dst any) bool {
	if err := httpbody.DecodeJSON(w, r, max, dst); err != nil {
		writeError(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err), "")
		return false
	}
	return true
}

func writeValidationError(w http.ResponseWriter, err error) {
	code := "validation_failed"
	if strings.Contains(err.Error(), "only manual suppression authority") {
		code = "manual_authority_required"
	}
	writeError(w, http.StatusUnprocessableEntity, code, err.Error(), "")
}

func (d *Deps) configured() bool { return d.AuthorityStore != nil || d.Pool != nil }

func (d *Deps) writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, errInvalidCursor):
		writeError(w, http.StatusBadRequest, "invalid_cursor", "Cursor snapshot is invalid for this request.", "")
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "push_suppression_not_found", "Push suppression authority was not found.", "")
	case errors.Is(err, ErrStale):
		writeError(w, http.StatusConflict, "push_suppression_stale", "Push suppression authority changed; refresh before retrying.", "")
	default:
		var locked *LockedError
		if errors.As(err, &locked) {
			writeError(w, http.StatusConflict, "push_suppression_locked", "This suppression authority requires reviewed reconciliation.", locked.Reason)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	LockedReason string `json:"locked_reason,omitempty"`
}

func writeError(w http.ResponseWriter, status int, code, message, lockedReason string) {
	_ = writeJSON(w, status, errorEnvelope{Error: errorBody{Code: code, Message: message, LockedReason: lockedReason}})
}

func writeJSON(w http.ResponseWriter, status int, body any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	preparePrivateResponse(w)
	w.WriteHeader(status)
	_, err = w.Write(append(encoded, '\n'))
	return err
}
