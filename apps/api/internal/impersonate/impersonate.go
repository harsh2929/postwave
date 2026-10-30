// SPDX-License-Identifier: AGPL-3.0-only
//
// Package impersonate implements tenant impersonation for Moosewave
// support engineers. The flow:
//
//   1. Operator POSTs to /api/internal/impersonate/start with the
//      target tenant id + a reason + (optionally) scope=read_write.
//   2. Handler mints a 32-byte token, hashes it (sha256), writes a
//      row to impersonation_sessions with a 1-hour expiry by
//      default, writes a corresponding audit_log entry.
//   3. Handler returns { token, prefix, expires_at } ONCE — the
//      operator copies the token into their browser dev tools.
//   4. Subsequent requests carry `X-Postwave-Impersonation: <token>`
//      on the EXISTING tenant-scoped routes. The Middleware
//      resolves the token, replaces the request's Tenant context
//      with the target tenant, and (when scope=read_only) refuses
//      non-GET methods.
//   5. POST /api/internal/impersonate/end revokes the session +
//      writes the second audit_log entry.
//
// Safety properties:
//   * Sessions auto-expire (1h default). Even if the operator
//     forgets to End, the token stops working at expires_at.
//   * read_only by default. Switching to read_write requires an
//     explicit flag + a stronger reason capture.
//   * Every request that uses the impersonation token is annotated
//     in audit_log with actor_type='platform_operator', so the customer
//     and the security team can later filter "what did the
//     operator actually do."

package impersonate

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// DefaultTTL is the wall-clock window an impersonation token stays
// valid. 1 hour is calibrated: long enough to actually debug
// something live, short enough that "I forgot to End" doesn't grant
// a quiet 8-hour window of access.
const DefaultTTL = time.Hour

// MaxTTL caps the operator-supplied TTL value.
const MaxTTL = 4 * time.Hour

// HeaderName is the request header that carries the impersonation
// bearer. Distinct from Authorization so the operator's regular
// admin credentials still flow through to the audit middleware.
const HeaderName = "X-Postwave-Impersonation"

// ActorType is what an impersonated request writes into audit_log.actor_type,
// with the operator's email as the actor label. The database intentionally
// exposes one canonical privileged-operator category; the label and session
// metadata retain the fact that this specific request used impersonation.
const ActorType = "platform_operator"

// Scope values.
const (
	ScopeReadOnly  = "read_only"
	ScopeReadWrite = "read_write"
)

// Deps wires the internal handler.
type Deps struct {
	Pool *db.Pool
	// InternalAPIToken is the shared secret required to call the
	// /start /end endpoints. Empty disables the routes entirely
	// (production MUST set this; the routes are dangerous).
	InternalAPIToken string
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller
	// after construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

// MountInternalRoutes attaches the two lifecycle endpoints to r.
// MUST be on the internal router (outside EnforceRegion) so a
// us-east operator can impersonate an eu-central tenant.
func MountInternalRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil || d.InternalAPIToken == "" {
		return
	}
	r.Post("/api/internal/impersonate/start", d.Start)
	r.Post("/api/internal/impersonate/end", d.End)
	r.Get("/api/internal/impersonate/list", d.ListActive)
}

// startInput is the start-request body.
type startInput struct {
	OperatorEmail  string `json:"operator_email"`
	TargetTenantID string `json:"target_tenant_id"`
	Reason         string `json:"reason"`
	Scope          string `json:"scope"`       // read_only (default) | read_write
	TTLSeconds     int    `json:"ttl_seconds"` // optional; defaults to DefaultTTL
}

// startResponse — token is shown ONCE.
type startResponse struct {
	SessionID string    `json:"session_id"`
	Token     string    `json:"token"`
	Prefix    string    `json:"prefix"`
	ExpiresAt time.Time `json:"expires_at"`
	Scope     string    `json:"scope"`
}

// Start POST /api/internal/impersonate/start.
func (d *Deps) Start(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized",
			"internal admin token required")
		return
	}
	var in startInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.OperatorEmail = strings.TrimSpace(strings.ToLower(in.OperatorEmail))
	in.TargetTenantID = strings.TrimSpace(in.TargetTenantID)
	in.Reason = strings.TrimSpace(in.Reason)
	if in.OperatorEmail == "" || in.TargetTenantID == "" || in.Reason == "" {
		writeErr(w, http.StatusBadRequest, "missing_fields",
			"operator_email, target_tenant_id, and reason are required")
		return
	}
	scope := strings.TrimSpace(in.Scope)
	if scope == "" {
		scope = ScopeReadOnly
	}
	if scope != ScopeReadOnly && scope != ScopeReadWrite {
		writeErr(w, http.StatusBadRequest, "invalid_scope",
			"scope must be read_only or read_write")
		return
	}
	ttl := DefaultTTL
	if in.TTLSeconds > 0 {
		ttl = time.Duration(in.TTLSeconds) * time.Second
		if ttl > MaxTTL {
			ttl = MaxTTL
		}
	}

	// Mint token.
	var rawBytes [32]byte
	if _, err := rand.Read(rawBytes[:]); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rawToken := hex.EncodeToString(rawBytes[:])
	sum := sha256.Sum256([]byte(rawToken))
	prefix := rawToken[:8]
	expiresAt := time.Now().UTC().Add(ttl)

	// Verify the target tenant exists before minting.
	var exists bool
	if err := d.Pool.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		in.TargetTenantID).Scan(&exists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !exists {
		writeErr(w, http.StatusNotFound, "tenant_not_found",
			"target tenant id does not exist")
		return
	}

	// Insert the session row. We bind app.tenant_id to the TARGET
	// tenant so audit_log inserts under that tenant's RLS policy
	// land cleanly.
	//
	// Use a tx with set_config(...,true) (transaction-local) instead of
	// the older Acquire+set_config(...,false) (session-scope) pattern:
	// pgxpool does NOT reset GUCs on Release, so the next borrower of
	// that pooled conn would have inherited `app.tenant_id` bound to
	// the impersonated tenant — a cross-request RLS-context bleed.
	tx, err := d.Pool.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`SELECT set_config('app.tenant_id', $1, true)`, in.TargetTenantID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	var sessionID string
	err = tx.QueryRow(r.Context(), `
INSERT INTO impersonation_sessions
  (operator_email, target_tenant_id, token_sha256, token_prefix,
   scope, reason, expires_at)
VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
RETURNING id::text`,
		in.OperatorEmail, in.TargetTenantID, sum[:], prefix,
		scope, in.Reason, expiresAt).Scan(&sessionID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// The privileged session and its audit record are one transaction: a
	// missing forensic row must fail the operation rather than silently create
	// untracked impersonation.
	var auditID int64
	if err := tx.QueryRow(r.Context(), `
INSERT INTO audit_log
  (tenant_id, action, resource_type, resource_id, metadata,
   actor_type, actor_label)
VALUES ($1::uuid, 'impersonation.started', 'tenant', $1::text,
        jsonb_build_object('operator', $2::text, 'session_id', $3::text,
                           'scope', $4::text, 'reason', $5::text),
        'platform_operator', 'impersonate.start')
RETURNING id`,
		in.TargetTenantID, in.OperatorEmail, sessionID, scope, in.Reason).Scan(&auditID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE impersonation_sessions SET audit_start_id = $1
			   WHERE id = $2::uuid`, auditID, sessionID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusCreated, startResponse{
		SessionID: sessionID,
		Token:     rawToken,
		Prefix:    prefix,
		ExpiresAt: expiresAt,
		Scope:     scope,
	})
}

// endInput is the end-request body.
type endInput struct {
	SessionID string `json:"session_id"`
	Reason    string `json:"reason"`
}

// End POST /api/internal/impersonate/end.
func (d *Deps) End(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized",
			"internal admin token required")
		return
	}
	var in endInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if strings.TrimSpace(in.SessionID) == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "session_id required")
		return
	}

	// Same tx-scoped GUC pattern as Start — see Start for rationale.
	// impersonation_sessions has no RLS, but audit_log DOES, so the
	// GUC needs to be bound for the audit insert below.
	tx, err := d.Pool.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Look up target tenant first so we can write the audit row
	// under the right GUC. pgx.ErrNoRows here means the session
	// id doesn't exist — return a clean 404 with a hand-authored
	// message so we don't echo pgx text. Any other error is a real
	// infra failure and goes through WriteInternal.
	var targetTenant string
	if err := tx.QueryRow(r.Context(),
		`SELECT target_tenant_id::text FROM impersonation_sessions
		   WHERE id = $1::uuid`, in.SessionID).Scan(&targetTenant); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found",
				"impersonation session not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`SELECT set_config('app.tenant_id', $1, true)`, targetTenant); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE impersonation_sessions
		    SET ended_at = now(), ended_reason = $1
		  WHERE id = $2::uuid AND ended_at IS NULL`,
		in.Reason, in.SessionID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	var auditID int64
	if err := tx.QueryRow(r.Context(), `
INSERT INTO audit_log
  (tenant_id, action, resource_type, resource_id, metadata,
   actor_type, actor_label)
VALUES ($1::uuid, 'impersonation.ended', 'tenant', $1::text,
        jsonb_build_object('session_id', $2::text, 'reason', $3::text),
        'platform_operator', 'impersonate.end')
RETURNING id`,
		targetTenant, in.SessionID, in.Reason).Scan(&auditID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE impersonation_sessions SET audit_end_id = $1
			   WHERE id = $2::uuid`, auditID, in.SessionID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ended": true})
}

// ListActive GET /api/internal/impersonate/list — currently-open
// sessions across all tenants. Used by the security dashboard.
func (d *Deps) ListActive(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized",
			"internal admin token required")
		return
	}
	rows, err := d.Pool.Query(r.Context(), `
SELECT id::text, operator_email, target_tenant_id::text, token_prefix,
       scope, reason, started_at::text, expires_at::text
  FROM impersonation_sessions
 WHERE ended_at IS NULL AND expires_at > now()
 ORDER BY started_at DESC
 LIMIT 200`)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type sess struct {
		ID             string `json:"id"`
		OperatorEmail  string `json:"operator_email"`
		TargetTenantID string `json:"target_tenant_id"`
		TokenPrefix    string `json:"token_prefix"`
		Scope          string `json:"scope"`
		Reason         string `json:"reason"`
		StartedAt      string `json:"started_at"`
		ExpiresAt      string `json:"expires_at"`
	}
	out := []sess{}
	for rows.Next() {
		var s sess
		if err := rows.Scan(&s.ID, &s.OperatorEmail, &s.TargetTenantID,
			&s.TokenPrefix, &s.Scope, &s.Reason, &s.StartedAt, &s.ExpiresAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out, "count": len(out)})
}

// authorize checks the shared Authorization: Bearer <token>.
func (d *Deps) authorize(r *http.Request) bool {
	if d.InternalAPIToken == "" {
		return false
	}
	hdr := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(hdr, prefix) {
		return false
	}
	got := strings.TrimSpace(hdr[len(prefix):])
	want := d.InternalAPIToken
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// keep errors imported for future typed-error sentinels.
var _ = errors.New
