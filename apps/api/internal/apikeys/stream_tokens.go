// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const streamTokenPrefix = "pws_"

var (
	ErrStreamTokenSecret  = errors.New("stream token secret is not configured")
	ErrStreamTokenShape   = errors.New("stream token has invalid shape")
	ErrStreamTokenSig     = errors.New("stream token signature mismatch")
	ErrStreamTokenExpired = errors.New("stream token expired")
)

// StreamTokenTTL is intentionally short. These tokens exist only to let
// browser/EventSource clients authenticate one SSE connection without placing a
// long-lived API key in the URL.
const StreamTokenTTL = 2 * time.Minute

// RealtimeStreamRoutePatterns is the allow-list for URL-query stream tokens.
// Keep every future EventSource/SSE endpoint represented here before mounting
// it in main.go. Long-lived API keys in query strings are legacy/local only.
//
// The audit export entries are not SSE — they are anchor-click /
// window.open CSV downloads (desktop-audit gap A15). EventSource and
// <a download> share the same constraint: neither can set an
// Authorization header, so in cookieless contexts (Electron webview)
// the short-lived pws_ token in the URL is the only viable auth. The
// desktop's auditExportUrlAuthed / auditExportJobDownloadUrlAuthed
// build exactly these paths via buildStreamUrl.
var RealtimeStreamRoutePatterns = []string{
	"/api/v1/events",
	"/api/v1/dashboard/live",
	"/api/v1/campaigns/{id}/events",
	"/api/v1/migrations/{id}/events",
	"/api/v1/audit/export",
	"/api/v1/audit/export-jobs/{id}/download",
	"/api/v1/audit/stream",
	"/api/v1/audit/investigations/{id}/stream",
	"/api/v1/mcp/executions/stream",
	"/api/v1/forms/{id}/submissions.csv",
	"/api/v1/subscriber-imports/{id}/progress",
	"/api/v1/track/stream",
	"/api/v1/track/events.csv",
}

// StreamTokenClaims is the signed, base64-readable payload in pws_ tokens. New
// tokens deliberately carry only opaque identifiers, effective scopes,
// expiry, and nonce: URL/access logs often outlive the two-minute credential.
// Legacy presentation fields remain decode-only for rolling compatibility and
// are never populated by StreamTokenHandler.
type StreamTokenClaims struct {
	TenantID    string  `json:"tenant_id"`
	PrincipalID string  `json:"principal_id,omitempty"`
	ActorType   string  `json:"actor_type,omitempty"`
	Scopes      []Scope `json:"scopes,omitempty"`
	ExpiresAt   int64   `json:"exp"`
	Nonce       string  `json:"nonce"`

	// Deprecated rolling-decode fields. The issuer leaves every field empty.
	TenantSlug string `json:"tenant_slug,omitempty"`
	TenantName string `json:"tenant_name,omitempty"`
	TenantTier string `json:"tenant_tier,omitempty"`
	UserID     string `json:"user_id,omitempty"`
	UserEmail  string `json:"user_email,omitempty"`
	UserRole   string `json:"user_role,omitempty"`
	ActorLabel string `json:"actor_label,omitempty"`
}

type StreamTokenResponse struct {
	Token      string `json:"token"`
	ExpiresAt  string `json:"expires_at"`
	TTLSeconds int64  `json:"ttl_seconds"`
}

// IssueStreamToken signs claims with HMAC-SHA256. It is tamper-evident, not
// opaque: callers and infrastructure logs can base64-decode the payload.
func IssueStreamToken(secret []byte, claims StreamTokenClaims, now time.Time, ttl time.Duration) (string, error) {
	if len(secret) == 0 {
		return "", ErrStreamTokenSecret
	}
	if ttl <= 0 {
		ttl = StreamTokenTTL
	}
	if claims.TenantID == "" {
		return "", fmt.Errorf("stream token: tenant id required")
	}
	claims.ExpiresAt = now.Add(ttl).Unix()
	if claims.Nonce == "" {
		nonce, err := randomStreamNonce()
		if err != nil {
			return "", err
		}
		claims.Nonce = nonce
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	sig := signStreamPayload(secret, payload)
	return streamTokenPrefix + enc(payload) + "." + enc(sig), nil
}

// ParseStreamToken verifies and decodes a pws_ stream token.
func ParseStreamToken(secret []byte, token string, now time.Time) (*StreamTokenClaims, error) {
	if len(secret) == 0 {
		return nil, ErrStreamTokenSecret
	}
	token = strings.TrimSpace(token)
	if !strings.HasPrefix(token, streamTokenPrefix) {
		return nil, ErrStreamTokenShape
	}
	raw := strings.TrimPrefix(token, streamTokenPrefix)
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, ErrStreamTokenShape
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrStreamTokenShape
	}
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrStreamTokenShape
	}
	wantSig := signStreamPayload(secret, payload)
	if !hmac.Equal(gotSig, wantSig) {
		return nil, ErrStreamTokenSig
	}
	var claims StreamTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, ErrStreamTokenShape
	}
	if claims.TenantID == "" || claims.ExpiresAt <= 0 {
		return nil, ErrStreamTokenShape
	}
	if now.Unix() >= claims.ExpiresAt {
		return nil, ErrStreamTokenExpired
	}
	return &claims, nil
}

// StreamTokenHandler issues a signed token for authenticated clients that need
// to open an EventSource stream. Mount it behind TenantMiddleware and
// RequireScope(ScopeReadReports).
func StreamTokenHandler(secret []byte, ttl time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, errEnv("method_not_allowed", "POST required"))
			return
		}
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok || t == nil {
			writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
			return
		}
		actorType, _ := middleware.ActorFromContext(r.Context())
		var principalID string
		var user *middleware.User
		if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
			user = u
			principalID = u.ID
		} else {
			principalID = middleware.APIKeyIDFromContext(r.Context())
		}
		scopes := ScopesFromContext(r.Context())
		if !middleware.IsAPIKeyAuth(r.Context()) {
			// A URL token becomes API-key-authenticated downstream, so copying
			// ScopeAdmin into every session token would turn a viewer who may
			// read reports into an administrator on every allowlisted download.
			// Preserve full authority only for an effective owner/admin; all
			// other session roles receive the read permission that admitted
			// them to this mint route plus any explicit non-admin grants already
			// resolved onto the request context.
			scopes = sessionStreamTokenScopes(r.Context(), user)
		}
		now := time.Now().UTC()
		token, err := IssueStreamToken(secret, StreamTokenClaims{
			TenantID:    t.ID,
			PrincipalID: principalID,
			ActorType:   actorType,
			Scopes:      scopes,
		}, now, ttl)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errEnv("stream_token_failed", "could not issue stream token"))
			return
		}
		writeJSON(w, http.StatusOK, StreamTokenResponse{
			Token:      token,
			ExpiresAt:  now.Add(ttl).UTC().Format(time.RFC3339),
			TTLSeconds: int64(ttl / time.Second),
		})
	}
}

func sessionStreamTokenScopes(ctx context.Context, user *middleware.User) []Scope {
	role := ""
	if user != nil {
		role = strings.ToLower(strings.TrimSpace(user.EffectiveRoleOrDurable()))
	}
	if role == "owner" || role == "admin" {
		return []Scope{ScopeAdmin}
	}
	// Product Events live-tail and CSV routes expose subscriber-linked raw
	// events and require both permissions downstream. Session users who are
	// not effective administrators receive exactly those baseline read scopes;
	// any additional already-resolved non-admin grants remain additive.
	out := []Scope{ScopeReadReports, ScopeReadSubscribers}
	seen := map[Scope]struct{}{
		ScopeReadReports:     {},
		ScopeReadSubscribers: {},
	}
	for _, scope := range ScopesFromContext(ctx) {
		if scope == ScopeAdmin {
			continue
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		out = append(out, scope)
	}
	return out
}

func streamTokenFromRequest(r *http.Request) string {
	if tok := r.URL.Query().Get("stream_token"); tok != "" {
		return tok
	}
	return r.URL.Query().Get("sse_token")
}

func StreamTokenAllowedPath(path string) bool {
	if path == "/api/v1/events" || path == "/api/v1/dashboard/live" {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/campaigns/") && strings.HasSuffix(path, "/events") {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/migrations/") && strings.HasSuffix(path, "/events") {
		return true
	}
	// Audit CSV export downloads (desktop-audit gap A15). Exact match
	// for the synchronous export; for the async job download require
	// exactly one non-empty id segment between the prefix and
	// "/download" so sibling job routes (status GET, list) stay
	// header-auth only.
	if path == "/api/v1/audit/export" {
		return true
	}
	if id, ok := strings.CutPrefix(path, "/api/v1/audit/export-jobs/"); ok {
		if id, ok := strings.CutSuffix(id, "/download"); ok {
			return id != "" && !strings.Contains(id, "/")
		}
	}
	// Audit live-tail SSE + per-investigation SSE (D13#1) and forms
	// submissions CSV download (D08#3): all use buildStreamUrl in the
	// Electron webview, which can't set an Authorization header, so the
	// short-lived pws_ token in the URL is the only viable auth. Scope
	// enforcement still runs downstream on each route.
	if path == "/api/v1/audit/stream" {
		return true
	}
	// MCP execution history is an admin-only EventSource surface used by the
	// desktop webview. The downstream ScopeAdmin gate still applies to the
	// short-lived token, so adding this exact path does not broaden viewer
	// access or allow query credentials on sibling MCP routes.
	if path == "/api/v1/mcp/executions/stream" {
		return true
	}
	if id, ok := strings.CutPrefix(path, "/api/v1/audit/investigations/"); ok {
		if id, ok := strings.CutSuffix(id, "/stream"); ok {
			return id != "" && !strings.Contains(id, "/")
		}
	}
	if id, ok := strings.CutPrefix(path, "/api/v1/forms/"); ok {
		if id, ok := strings.CutSuffix(id, "/submissions.csv"); ok {
			return id != "" && !strings.Contains(id, "/")
		}
	}
	if id, ok := strings.CutPrefix(path, "/api/v1/subscriber-imports/"); ok {
		if id, ok := strings.CutSuffix(id, "/progress"); ok {
			return id != "" && !strings.Contains(id, "/")
		}
	}
	// Product Events live-tail and CSV export use EventSource/native download
	// transports that cannot attach Authorization headers in cookieless desktop
	// sessions. Keep these exact so sibling Track reads and ingestion never
	// accept query credentials.
	if path == "/api/v1/track/stream" || path == "/api/v1/track/events.csv" {
		return true
	}
	return false
}

func streamTokenAllowedPath(path string) bool {
	return StreamTokenAllowedPath(path)
}

func signStreamPayload(secret, payload []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("postwave-stream-token-v1\n"))
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func enc(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func randomStreamNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("stream token nonce: %w", err)
	}
	return enc(b[:]), nil
}
