// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// HTTP surface for signed-ingest signing keys.
//
// Admin-scoped throughout: holding one of these keys is the ability to write
// conversions as this tenant, so issuing one is a credential-granting act
// rather than a reporting read.

const secretLabelBodyMaxBytes int64 = 1 << 10

const ingestSecretCollectionPath = "/api/v1/conversions/ingest-secrets"

// BypassIngestSecretIssueGlobalReplay keeps the reveal-once issuance response
// out of the generic 24-hour idempotency ledger. The match is deliberately the
// exact method and path: list/revoke keep their ordinary behavior and a sibling
// route can never inherit this credential-specific exception.
//
// An issuance whose transport acknowledgement is lost is intentionally
// ambiguous. Callers must reconcile the metadata register, revoke any newly
// appeared key, and issue a replacement; the plaintext cannot be recovered or
// safely replayed.
func BypassIngestSecretIssueGlobalReplay(r *http.Request, _ []byte) bool {
	return r != nil &&
		r.URL != nil &&
		r.Method == http.MethodPost &&
		r.URL.EscapedPath() == ingestSecretCollectionPath
}

// ProtectIngestSecretResponses makes the private key register and every key
// mutation non-cacheable even when authentication, authorization, routing, or
// another outer middleware returns before a handler. Mount it at the root;
// handlers repeat the preparation for safe standalone composition.
func ProtectIngestSecretResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isIngestSecretResponsePath(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &ingestSecretResponseWriter{ResponseWriter: w}
		prepareIngestSecretResponse(protected)
		r.Header.Del("If-None-Match")
		r.Header.Del("If-Modified-Since")
		next.ServeHTTP(protected, r)
	})
}

func isIngestSecretResponsePath(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := r.URL.EscapedPath()
	if path == ingestSecretCollectionPath {
		return true
	}
	const prefix = ingestSecretCollectionPath + "/"
	const suffix = "/revoke"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return false
	}
	keyID := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	return keyID != "" && !strings.Contains(keyID, "/")
}

func prepareIngestSecretResponse(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Cache-Control", "private, no-store")
	header.Set("Pragma", "no-cache")
	header.Del("ETag")
	header.Del("Last-Modified")
	header.Del("Expires")
	addIngestSecretVary(header, "Authorization")
	addIngestSecretVary(header, "Cookie")
}

func addIngestSecretVary(header http.Header, dimension string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), dimension) {
				return
			}
		}
	}
	header.Add("Vary", dimension)
}

type ingestSecretResponseWriter struct{ http.ResponseWriter }

func (w *ingestSecretResponseWriter) WriteHeader(status int) {
	prepareIngestSecretResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *ingestSecretResponseWriter) Write(body []byte) (int, error) {
	prepareIngestSecretResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

func (w *ingestSecretResponseWriter) Flush() {
	prepareIngestSecretResponse(w.ResponseWriter)
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *ingestSecretResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

type IngestSecretDeps struct {
	Store *IngestSecretStore
}

func MountIngestSecretRoutes(r chi.Router, d *IngestSecretDeps, admin func(http.Handler) http.Handler) {
	if d == nil || d.Store == nil || d.Store.Pool == nil {
		return
	}
	r.With(admin).Post("/api/v1/conversions/ingest-secrets", d.Issue)
	r.With(admin).Get("/api/v1/conversions/ingest-secrets", d.List)
	r.With(admin).Post("/api/v1/conversions/ingest-secrets/{keyID}/revoke", d.Revoke)
}

type issueSecretRequest struct {
	Label string `json:"label,omitempty"`
}

func secretTenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil || strings.TrimSpace(tenant.ID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context is required")
		return "", false
	}
	return tenant.ID, true
}

// Issue returns the secret. This is the only response that ever contains it,
// which is why the handler sets no-store: a cached 201 would leave the key in
// a proxy or a browser's disk cache.
func (d *IngestSecretDeps) Issue(w http.ResponseWriter, r *http.Request) {
	prepareIngestSecretResponse(w)
	// This response contains the only copy of the plaintext signing secret. It
	// must never become a replayable response or invite a blind retry after an
	// ambiguous transport failure. Reject even an empty/duplicate field-line;
	// the exact-path global bypass has already kept it away from the ledger.
	if len(r.Header.Values(idempotency.HeaderName)) != 0 {
		httperror.Write(w, http.StatusBadRequest, "idempotency_not_supported",
			"Idempotency-Key must not be sent when issuing a reveal-once signing secret")
		return
	}
	tenantID, ok := secretTenant(w, r)
	if !ok {
		return
	}
	var input issueSecretRequest
	if err := httpbody.DecodeJSONWith(w, r, secretLabelBodyMaxBytes, &input,
		httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_body", "request body could not be read")
		return
	}
	issued, err := d.Store.Issue(r.Context(), tenantID, input.Label)
	if err != nil {
		if errors.Is(err, ErrSecretLabelInvalid) {
			httperror.Write(w, http.StatusUnprocessableEntity, "invalid_label",
				"the label must be plain text of at most 128 characters")
			return
		}
		if errors.Is(err, ErrSecretLiveLimit) {
			httperror.Write(w, http.StatusConflict, "live_key_limit_reached",
				"revoke an unused signing key before issuing another")
			return
		}
		httperror.Write(w, http.StatusInternalServerError, "issue_failed",
			"the signing key could not be issued")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"secret": issued,
		"notice": "This is the only time the secret is shown. Store it now; it cannot be recovered, only replaced.",
	})
}

func (d *IngestSecretDeps) List(w http.ResponseWriter, r *http.Request) {
	prepareIngestSecretResponse(w)
	tenantID, ok := secretTenant(w, r)
	if !ok {
		return
	}
	rawCursor := r.URL.Query().Get("cursor")
	if len(rawCursor) > MaxSecretCursorBytes {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(
		r.URL.Query(), DefaultSecretListLimit, MaxSecretListLimit,
	)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	page, err := d.Store.ListPage(r.Context(), tenantID, cursor, limit)
	if err != nil {
		httperror.Write(w, http.StatusInternalServerError, "list_failed",
			"signing keys could not be listed")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (d *IngestSecretDeps) Revoke(w http.ResponseWriter, r *http.Request) {
	prepareIngestSecretResponse(w)
	tenantID, ok := secretTenant(w, r)
	if !ok {
		return
	}
	err := d.Store.Revoke(r.Context(), tenantID, chi.URLParam(r, "keyID"))
	if err != nil {
		// One status for absent, already-revoked, and another tenant's key.
		// Separating them would let a caller enumerate key ids by watching
		// which failure comes back.
		if errors.Is(err, ErrSecretNotLive) {
			httperror.Write(w, http.StatusNotFound, "key_not_live",
				"no live signing key with that id")
			return
		}
		httperror.Write(w, http.StatusInternalServerError, "revoke_failed",
			"the signing key could not be revoked")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true})
}
