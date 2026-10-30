// SPDX-License-Identifier: AGPL-3.0-only
//
// cli_auth.go — the CLI / editor login flow: OAuth 2.0 authorization-code with
// PKCE over a loopback redirect (RFC 8252 + 7636). Replaces the reverted
// drive-by auto-minter. Two endpoints:
//
//	POST /api/v1/auth/cli/authorize  (session-authed) — the browser /cli/auth
//	    page calls this ONLY after the signed-in user clicks "Authorize". It
//	    records a pending grant (binding the CLI's PKCE code_challenge + state +
//	    loopback port to the user's tenant) and returns a short-lived one-time
//	    CODE. No API key is minted here.
//
//	POST /api/v1/auth/cli/token      (public) — the CLI exchanges {code,
//	    code_verifier, state} directly with the backend. The grant is consumed
//	    atomically (one shot), PKCE + state are checked, and only THEN is the
//	    API key minted and returned. The key never passes through the browser;
//	    an intercepted code is useless without the verifier (which never leaves
//	    the CLI).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"

	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

var (
	errCLIInsufficientRole = errors.New("cli auth: role cannot mint a CLI credential")
	errCLIMFARequired      = errors.New("cli auth: MFA step-up required")
)

// CLI credentials inherit the approving session's effective role. In
// particular, viewer-mode must remain read-only: a durable API key must never
// become an escape hatch from a session downgrade. Write/send grants are
// intentionally step-up protected because they outlive the browser session.
var cliReadScopes = []string{
	"read:subscribers",
	"read:campaigns",
	"read:reports",
}

var cliEditorScopes = []string{
	"read:subscribers", "write:subscribers",
	"read:campaigns", "write:campaigns",
	"read:reports",
}

var cliAdminScopes = []string{
	"read:subscribers", "write:subscribers",
	"read:campaigns", "write:campaigns",
	"read:reports", "send:transactional",
}

func cliScopesForPrincipal(me MeContext) ([]string, error) {
	durableRole := strings.ToLower(strings.TrimSpace(me.UserRole))
	effectiveRole := strings.ToLower(strings.TrimSpace(me.EffectiveRole))
	// Re-apply the session resolver's down-only invariant at this durable-
	// credential boundary. Even a malformed context can narrow authority but
	// cannot present a viewer/editor as admin and mint a stronger API key.
	role := resolveEffectiveRole(durableRole, effectiveRole)
	switch role {
	case "viewer":
		return append([]string(nil), cliReadScopes...), nil
	case "editor":
		if !me.MFASatisfied {
			return nil, errCLIMFARequired
		}
		return append([]string(nil), cliEditorScopes...), nil
	case "admin", "owner":
		if !me.MFASatisfied {
			return nil, errCLIMFARequired
		}
		return append([]string(nil), cliAdminScopes...), nil
	default:
		return nil, errCLIInsufficientRole
	}
}

func writeCLIPrincipalError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errCLIMFARequired):
		// Through the shared contract. `cliErr` produced the same
		// {"error":{"code","message"}} envelope, so the added classification
		// keys are a strict superset and no existing CLI consumer breaks.
		writeCLIMFARequiredDenial(w)
	default:
		writeCLIInsufficientRoleDenial(w)
	}
}

const (
	cliGrantTTL      = 5 * time.Minute
	cliCodeBytes     = 32
	cliChallengeS256 = "S256"
)

// MountCLIAuthorizeRoute registers the session-authed authorize endpoint. Mount
// inside the protected (session-required) group.
func (d *Deps) MountCLIAuthorizeRoute(r chi.Router) {
	r.Post("/api/v1/auth/cli/authorize", d.CLIAuthorize)
}

// MountCLITokenRoute registers the public token-exchange endpoint. Mount with
// the public auth routes (no session).
func (d *Deps) MountCLITokenRoute(r chi.Router) {
	r.Post("/api/v1/auth/cli/token", d.CLIToken)
}

type cliAuthorizeRequest struct {
	State           string `json:"state"`
	CodeChallenge   string `json:"code_challenge"`
	ChallengeMethod string `json:"challenge_method"`
	Port            int    `json:"port"`
}

func (d *Deps) CLIAuthorize(w http.ResponseWriter, r *http.Request) {
	if d.MeContextLookup == nil || d.MintCLIKey == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "CLI auth not configured"))
		return
	}
	me, ok := d.MeContextLookup(r)
	if !ok || me.TenantID == "" {
		writeAuthJSON(w, http.StatusUnauthorized, cliErr("no_session", "sign in first"))
		return
	}
	scopes, scopeErr := cliScopesForPrincipal(me)
	if scopeErr != nil {
		writeCLIPrincipalError(w, scopeErr)
		return
	}
	var req cliAuthorizeRequest
	if err := httpbody.DecodeJSON(w, r, 8<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if len(req.State) < 16 || len(req.State) > 256 {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_state", "state must be 16-256 chars"))
		return
	}
	if len(req.CodeChallenge) < 32 || len(req.CodeChallenge) > 256 {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_challenge", "invalid code_challenge"))
		return
	}
	if req.ChallengeMethod != cliChallengeS256 {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_method", "only S256 is supported"))
		return
	}
	if req.Port < 1 || req.Port > 65535 {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("bad_port", "port out of range"))
		return
	}

	code, scopeErr := randToken(cliCodeBytes)
	if scopeErr != nil {
		writeAuthJSON(w, http.StatusInternalServerError, cliErr("rand", "an internal error occurred"))
		return
	}
	expiresAt := time.Now().Add(cliGrantTTL)
	if err := d.Repo.createCLIGrant(r.Context(), cliGrant{
		TenantID:        me.TenantID,
		UserID:          me.UserID,
		Email:           me.UserEmail,
		CodeHash:        sha256hex(code),
		CodeChallenge:   req.CodeChallenge,
		ChallengeMethod: req.ChallengeMethod,
		State:           req.State,
		Port:            req.Port,
		Scopes:          scopes,
		ExpiresAt:       expiresAt,
	}); err != nil {
		writeAuthJSON(w, http.StatusInternalServerError, cliErr("grant_failed", "an internal error occurred"))
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{
		"code":       code,
		"port":       req.Port,
		"scopes":     scopes,
		"expires_in": int(cliGrantTTL.Seconds()),
	})
}

type cliTokenRequest struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"code_verifier"`
	State        string `json:"state"`
}

func (d *Deps) CLIToken(w http.ResponseWriter, r *http.Request) {
	if d.MintCLIKey == nil {
		writeAuthJSON(w, http.StatusServiceUnavailable, cliErr("unavailable", "CLI auth not configured"))
		return
	}
	var req cliTokenRequest
	if err := httpbody.DecodeJSON(w, r, 8<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if req.Code == "" || req.CodeVerifier == "" || req.State == "" {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("missing_fields", "code, code_verifier, state required"))
		return
	}
	// Consume the grant atomically (one shot) BEFORE verifying — so a stolen
	// code can't be brute-forced against the verifier; one attempt burns it.
	grant, err := d.Repo.consumeCLIGrant(r.Context(), sha256hex(req.Code))
	if err != nil {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("invalid_code", "code is invalid, expired, or already used"))
		return
	}
	if subtle.ConstantTimeCompare([]byte(grant.State), []byte(req.State)) != 1 {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("state_mismatch", "state does not match"))
		return
	}
	if !pkceMatches(req.CodeVerifier, grant.CodeChallenge) {
		writeAuthJSON(w, http.StatusBadRequest, cliErr("pkce_mismatch", "code_verifier does not match challenge"))
		return
	}
	plaintext, err := d.MintCLIKey(r.Context(), grant.TenantID, "Moosewave CLI (login)", grant.Scopes)
	if err != nil {
		writeAuthJSON(w, http.StatusInternalServerError, cliErr("mint_failed", "an internal error occurred"))
		return
	}
	writeAuthJSON(w, http.StatusOK, map[string]any{
		"api_key":   plaintext,
		"tenant_id": grant.TenantID,
		"email":     grant.Email,
	})
}

func cliErr(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}

func randToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// pkceMatches reports whether code_verifier hashes (S256) to the stored
// code_challenge — base64url(SHA256(verifier)) == challenge, compared in
// constant time.
func pkceMatches(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(challenge)) == 1
}

// --- grant store (direct pool; looked up by unguessable code_hash) ---

type cliGrant struct {
	TenantID        string
	UserID          string
	Email           string
	CodeHash        string
	CodeChallenge   string
	ChallengeMethod string
	State           string
	Port            int
	Scopes          []string
	ExpiresAt       time.Time
}

func (r *Repo) createCLIGrant(ctx context.Context, g cliGrant) error {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.cli_grant_hash', $1, true)", g.CodeHash); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO cli_auth_grants
			(tenant_id, user_id, email, code_hash, code_challenge, challenge_method,
			 state, port, scopes, expires_at)
		VALUES ($1::uuid, $2::uuid, NULLIF($3,''), $4, $5, $6, $7, $8, $9::text[], $10)`,
		g.TenantID, g.UserID, g.Email, g.CodeHash, g.CodeChallenge, g.ChallengeMethod,
		g.State, g.Port, g.Scopes, g.ExpiresAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// consumeCLIGrant atomically flips a pending, unexpired grant to consumed and
// returns its bound fields. A missing/expired/already-consumed code yields an
// error (and no row is mutated), so the code is strictly one-shot.
func (r *Repo) consumeCLIGrant(ctx context.Context, codeHash string) (cliGrant, error) {
	var g cliGrant
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return g, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.cli_grant_hash', $1, true)", codeHash); err != nil {
		return g, err
	}
	txErr = tx.QueryRow(ctx, `
		UPDATE cli_auth_grants
		   SET status = 'consumed', consumed_at = now()
		 WHERE code_hash = $1 AND status = 'pending' AND expires_at > now()
		RETURNING tenant_id::text, user_id::text, COALESCE(email,''),
		          code_challenge, challenge_method, state, scopes`,
		codeHash).Scan(&g.TenantID, &g.UserID, &g.Email,
		&g.CodeChallenge, &g.ChallengeMethod, &g.State, &g.Scopes)
	if txErr != nil {
		return g, txErr
	}
	return g, tx.Commit(ctx)
}
