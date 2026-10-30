// SPDX-License-Identifier: AGPL-3.0-only
//
// admin_signing.go — Standard Webhooks signing-key admin surface.
//
// Endpoints:
//
//   GET    /api/v1/audit-sinks/{id}/signing-keys
//          List active + revoked keys (operator UI shows rotation
//          history; revoked keys are kept around for the grace window
//          so consumers verifying with the JWKS still see the kid).
//
//   POST   /api/v1/audit-sinks/{id}/rotate-key
//          Insert a new HS256 key, revoke the previous one. Returns
//          the new kid.
//
//   GET    /api/v1/audit-sinks/{id}/.well-known/jwks.json
//          Public RFC 7517 JWKS. Returns all non-revoked keys plus
//          recently-revoked keys (within JWKSGracePeriod) so verifiers
//          can pick the right key during rotation.
//
// JWKS notes:
//   - alg=HS256 means we're publishing the symmetric secret — this is
//     only safe because the JWKS is gated by tenant context (it is NOT
//     a public unauthenticated endpoint in Moosewave's deployment; the
//     server enforces middleware.TenantFromContext). Receivers must
//     fetch the JWKS over the same authenticated channel they configured
//     the sink with.
//   - kty=oct + k=<base64url(secret)> matches the JWA RFC 7518 form for
//     symmetric octet keys.

package auditsink

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// JWKSGracePeriod is how long a revoked key stays visible in the JWKS
// after rotation so in-flight verifiers still find it. 30 minutes is
// the standardwebhooks.com SDK's default acceptable signature age.
const JWKSGracePeriod = 30 * time.Minute

// SigningKeyRow is the wire shape for the list endpoint.
type SigningKeyRow struct {
	ID        string  `json:"id"`
	Kid       string  `json:"kid"`
	Alg       string  `json:"alg"`
	RotatedAt string  `json:"rotated_at"`
	RevokedAt *string `json:"revoked_at,omitempty"`
	Status    string  `json:"status"` // "active" | "revoked"
}

// MountSigningKeyRoutes attaches the signing-key endpoints. Separate
// mount so deployments can disable the JWKS surface independently.
func (a *AdminDeps) MountSigningKeyRoutes(r chi.Router) {
	if a == nil || a.Pool == nil {
		return
	}
	readGate := apikeys.RequireScope(apikeys.ScopeAuditRead)
	cfgGate := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	// Signing-key inventory is sink configuration too — key ids, rotation
	// state and the sinks they belong to. Same gate as the sink list, for the
	// same reason. The JWKS endpoint below stays on the read gate: it is the
	// public verification surface these keys exist to serve.
	r.With(cfgGate).Get("/api/v1/audit-sinks/{id}/signing-keys", a.ListSigningKeys)
	// p4d-recordsurface-wire-others: signing-key rotation lives on the
	// auditsink surface alongside the CRUD ops.
	r.With(cfgGate).Post("/api/v1/audit-sinks/{id}/rotate-key", observability.RecordSurfaceFunc("auditsink", "rotate_key", a.RotateSigningKey))
	r.With(readGate).Get("/api/v1/audit-sinks/{id}/.well-known/jwks.json", a.JWKS)
}

// ListSigningKeys GET /api/v1/audit-sinks/{id}/signing-keys.
func (a *AdminDeps) ListSigningKeys(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	sinkID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sinkID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "tx_failed", "an internal error occurred")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, kid, alg, rotated_at::text, revoked_at::text
  FROM audit_sink_signing_keys
 WHERE tenant_id = $1::uuid AND sink_id = $2::uuid
 ORDER BY rotated_at DESC`, t.ID, sinkID)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "query_failed", "an internal error occurred")
		return
	}
	defer rows.Close()
	out := []SigningKeyRow{}
	for rows.Next() {
		var k SigningKeyRow
		var revoked *string
		if err := rows.Scan(&k.ID, &k.Kid, &k.Alg, &k.RotatedAt, &revoked); err != nil {
			writeAdminErr(w, http.StatusInternalServerError, "scan_failed", "an internal error occurred")
			return
		}
		k.RevokedAt = revoked
		if revoked == nil || *revoked == "" {
			k.Status = "active"
		} else {
			k.Status = "revoked"
		}
		out = append(out, k)
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"keys": out})
}

// RotateSigningKey POST /api/v1/audit-sinks/{id}/rotate-key.
//
// Verifies the caller owns the sink (tenant scope), then delegates to
// Deps.RotateKey via SigningDeps (the worker-side dependency carrier).
// If SigningDeps is nil — i.e. the deployment didn't wire the rotation
// path — falls back to an inline implementation that uses the admin
// AdminDeps's Encrypter so the API still ships keys.
func (a *AdminDeps) RotateSigningKey(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	sinkID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sinkID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	// Verify the sink exists + belongs to this tenant before we mint a
	// key. Otherwise a malicious tenant could spam keys for someone
	// else's sink id and bloat the table.
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "tx_failed", "an internal error occurred")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var existingID string
	if err := tx.QueryRow(r.Context(),
		`SELECT id::text FROM audit_sinks
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, sinkID).Scan(&existingID); err != nil {
		writeAdminErr(w, http.StatusNotFound, "not_found", "sink not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "commit_failed", "an internal error occurred")
		return
	}
	d := &Deps{Pool: a.Pool, Cipher: a.Cipher, Encrypter: a.Encrypt}
	kid, err := d.RotateKey(r.Context(), t.ID, sinkID)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "rotate_failed", "an internal error occurred")
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.rotate", "audit_sink", sinkID, nil,
		map[string]any{
			"kid":     kid,
			"alg":     "HS256",
			"sink_id": sinkID,
		}, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{
		"kid":     kid,
		"alg":     "HS256",
		"sink_id": sinkID,
	})
}

// JWK is one entry in the JWKS response, RFC 7517 / RFC 7518.
type JWK struct {
	Kty string `json:"kty"`           // "oct" for symmetric
	Alg string `json:"alg"`           // "HS256"
	Kid string `json:"kid"`           // unique key id
	Use string `json:"use,omitempty"` // "sig"
	K   string `json:"k"`             // base64url(secret), no padding
}

// JWKS GET /api/v1/audit-sinks/{id}/.well-known/jwks.json.
//
// Returns all non-revoked keys plus revoked keys within the grace
// window. Caller must hold ScopeAuditRead — this is NOT a public
// unauthenticated endpoint (HS256 keys are symmetric).
func (a *AdminDeps) JWKS(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	sinkID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sinkID == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "tx_failed", "an internal error occurred")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT kid, alg, secret_envelope
  FROM audit_sink_signing_keys
 WHERE tenant_id = $1::uuid
   AND sink_id  = $2::uuid
   AND (revoked_at IS NULL OR revoked_at > now() - $3::interval)
 ORDER BY rotated_at DESC`,
		t.ID, sinkID, JWKSGracePeriod.String())
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "query_failed", "an internal error occurred")
		return
	}
	defer rows.Close()
	d := &Deps{Pool: a.Pool, Cipher: a.Cipher, Encrypter: a.Encrypt}
	keys := []JWK{}
	for rows.Next() {
		var kid, alg string
		var envelope []byte
		if err := rows.Scan(&kid, &alg, &envelope); err != nil {
			writeAdminErr(w, http.StatusInternalServerError, "scan_failed", "an internal error occurred")
			return
		}
		secret, derr := d.decryptSecret(r.Context(), envelope)
		if derr != nil {
			// Skip — don't crash JWKS just because one key won't decrypt.
			continue
		}
		keys = append(keys, JWK{
			Kty: "oct",
			Alg: alg,
			Kid: kid,
			Use: "sig",
			K:   base64.RawURLEncoding.EncodeToString(secret),
		})
	}
	w.Header().Set("Content-Type", "application/jwk-set+json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
}
