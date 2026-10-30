// SPDX-License-Identifier: AGPL-3.0-only
//
// Slack OAuth flow for the approval-bot integration.
//
// /api/v1/slack/oauth/start (auth-required)
//   - Redirects the caller to Slack's `/oauth/v2/authorize` with the
//     configured client_id, our requested scope set, and a signed
//     state token that carries the tenant id + a nonce + a 5-minute
//     expiry. The state is HMAC'd with the same KEK we use for the
//     approvals signed-link, so an attacker cannot mint a state value
//     for a different tenant.
//
// /api/v1/slack/oauth/callback (no auth — Slack hits this)
//   - Verifies the state HMAC + expiry, exchanges the `code` for a bot
//     token via `oauth.v2.access`, encrypts the bot token with the
//     existing envelope cipher (sending.EnvelopeEncryptor — same one
//     the rest of slackint already uses for webhook URLs), and upserts
//     a row into slack_workspace_connections.
//
// We deliberately do not store the user-token Slack returns alongside
// the bot token. The approval-bot only needs `chat:write` (post and
// update messages) plus `commands` and `channels:read` to render the
// pick-a-channel screen — all bot-scoped. Holding a user token would
// be a privilege we never use.
package slackint

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// Slack OAuth scopes the bot needs. `chat:write` posts + updates the
// approval message; `commands` registers /moosewave; `channels:read`
// powers the channel picker.
const SlackBotScopes = "chat:write,commands,channels:read,groups:read,im:write"

// stateTTL bounds how long an OAuth start URL stays redeemable.
const stateTTL = 5 * time.Minute

// OAuthDeps wires the OAuth handlers. Constructed in main.go from the
// shared envCipher + pool.
type OAuthDeps struct {
	Pool         *db.Pool
	Cipher       sending.EnvelopeEncryptor
	HMACKey      []byte
	ClientID     string
	ClientSecret string
	RedirectURL  string
	HTTPClient   *http.Client
	// SuccessRedirect is where we send the browser after a successful
	// install. Empty -> 200 JSON.
	SuccessRedirect string
	// Logger is used by httperror.WriteInternal to record server-side
	// detail for unexpected errors that we deliberately do not surface to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// NewOAuthDepsFromEnv pulls the standard env vars; main.go can override
// any field after construction.
func NewOAuthDepsFromEnv(pool *db.Pool, cipher sending.EnvelopeEncryptor, hmacKey []byte) *OAuthDeps {
	return &OAuthDeps{
		Pool:            pool,
		Cipher:          cipher,
		HMACKey:         hmacKey,
		ClientID:        os.Getenv("SLACK_CLIENT_ID"),
		ClientSecret:    os.Getenv("SLACK_CLIENT_SECRET"),
		RedirectURL:     os.Getenv("SLACK_OAUTH_REDIRECT_URL"),
		HTTPClient:      &http.Client{Timeout: 10 * time.Second},
		SuccessRedirect: os.Getenv("SLACK_OAUTH_SUCCESS_REDIRECT"),
	}
}

// signState produces an opaque token of the form
// `<tenantID>.<nonce>.<expUnix>.<sig>`. The caller MUST round-trip it
// through verifyState and confirm the embedded tenantID matches the
// one they expect.
func (d *OAuthDeps) signState(tenantID string) (string, error) {
	if len(d.HMACKey) == 0 {
		return "", errors.New("slackint: oauth HMAC key not configured")
	}
	nonceBytes := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonceBytes); err != nil {
		return "", err
	}
	nonce := hex.EncodeToString(nonceBytes)
	exp := strconv.FormatInt(time.Now().Add(stateTTL).Unix(), 10)
	payload := tenantID + "." + nonce + "." + exp
	mac := hmac.New(sha256.New, d.HMACKey)
	_, _ = mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig, nil
}

func (d *OAuthDeps) verifyState(token string) (tenantID string, err error) {
	if len(d.HMACKey) == 0 {
		return "", errors.New("slackint: oauth HMAC key not configured")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 4 {
		return "", errors.New("slackint: bad state format")
	}
	tenantID, nonce, expStr, sig := parts[0], parts[1], parts[2], parts[3]
	payload := tenantID + "." + nonce + "." + expStr
	mac := hmac.New(sha256.New, d.HMACKey)
	_, _ = mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return "", errors.New("slackint: bad state signature")
	}
	exp, perr := strconv.ParseInt(expStr, 10, 64)
	if perr != nil {
		return "", errors.New("slackint: bad state exp")
	}
	if time.Now().Unix() > exp {
		return "", errors.New("slackint: state expired")
	}
	if tenantID == "" {
		return "", errors.New("slackint: empty tenant in state")
	}
	return tenantID, nil
}

// OAuthStartHandler implements GET /api/v1/slack/oauth/start. Caller
// must be tenant-authenticated; the resolved tenant id is baked into
// the state token.
func (d *OAuthDeps) OAuthStartHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant context required"))
		return
	}
	if d.ClientID == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("slack_unconfigured",
			"this Moosewave deployment has no SLACK_CLIENT_ID set"))
		return
	}
	state, err := d.signState(t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	v := url.Values{}
	v.Set("client_id", d.ClientID)
	v.Set("scope", SlackBotScopes)
	v.Set("state", state)
	if d.RedirectURL != "" {
		v.Set("redirect_uri", d.RedirectURL)
	}
	authorize := "https://slack.com/oauth/v2/authorize?" + v.Encode()
	http.Redirect(w, r, authorize, http.StatusFound)
}

// AvailabilityHandler implements
// GET /api/v1/integrations/slack/availability (desktop-audit gap A16).
//
//	→ {"requires_session": true, "configured": bool}
//
// Why this exists instead of stream-token auth on /slack/oauth/start:
// the start route is admin-tier (it initiates a workspace-level OAuth
// install) and responds with a 302 the caller must follow in a real
// browser. Stream tokens (pws_) are URL-carried credentials minted for
// EventSource/download routes where Authorization headers are
// impossible — they can leak through logs, referrers and proxies,
// which is a tolerable tradeoff for short-lived read streams but NOT
// for an install-grant route. Allow-listing the start route for
// stream tokens would let a leaked URL credential bind a Slack
// workspace to the tenant. So the desktop instead probes this
// read-only endpoint with its API key and, when requires_session is
// true (always, today), deep-links the operator to the dashboard in a
// browser where the pw_session cookie authenticates the start route.
//
// Auth: API-key and session-cookie principals only. This path is NOT
// on the stream-token allowlist (apikeys.StreamTokenAllowedPath), so
// pws_ tokens cannot reach it either — the desktop's API key is what
// authenticates the probe in practice.
//
// configured=false means this deployment has no SLACK_CLIENT_ID — the
// Connect button should say "not configured" rather than open a
// browser that will land on a 503.
func (d *OAuthDeps) AvailabilityHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant context required"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"requires_session": true,
		"configured":       d.ClientID != "",
	})
}

// slackOAuthV2AccessResponse mirrors the subset of the
// `oauth.v2.access` response we care about.
type slackOAuthV2AccessResponse struct {
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	AccessToken string `json:"access_token"` // bot token (xoxb-…)
	TokenType   string `json:"token_type"`
	BotUserID   string `json:"bot_user_id"`
	AppID       string `json:"app_id"`
	Team        struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"team"`
	IncomingWebhook struct {
		ChannelID string `json:"channel_id"`
		Channel   string `json:"channel"`
	} `json:"incoming_webhook"`
}

// OAuthCallbackHandler implements GET /api/v1/slack/oauth/callback. No
// auth gate — Slack signs the callback with the state token we issued
// at start time.
func (d *OAuthDeps) OAuthCallbackHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		writeJSON(w, http.StatusBadRequest, errEnv("slack_denied", e))
		return
	}
	code := q.Get("code")
	state := q.Get("state")
	if code == "" || state == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_params", "code and state required"))
		return
	}
	tenantID, err := d.verifyState(state)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "bad_state", "invalid or expired state token")
		return
	}
	if d.ClientID == "" || d.ClientSecret == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("slack_unconfigured",
			"SLACK_CLIENT_ID + SLACK_CLIENT_SECRET must be set"))
		return
	}
	exch, err := d.exchangeCode(r.Context(), code)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !exch.OK {
		writeJSON(w, http.StatusBadGateway, errEnv("exchange_error", exch.Error))
		return
	}
	if exch.AccessToken == "" || exch.Team.ID == "" {
		writeJSON(w, http.StatusBadGateway, errEnv("exchange_incomplete",
			"slack returned an empty bot token or team id"))
		return
	}
	if d.Cipher == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("kek_unconfigured",
			"envelope cipher not configured; cannot encrypt bot token"))
		return
	}
	encrypted, err := d.Cipher.Encrypt(r.Context(), []byte(exch.AccessToken))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.upsertConnection(r.Context(), tenantID, exch, encrypted); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if successRedirect := safeOAuthSuccessRedirect(d.SuccessRedirect); successRedirect != "" {
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, successRedirect, http.StatusFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"team_id":      exch.Team.ID,
		"team_name":    exch.Team.Name,
		"channel_id":   exch.IncomingWebhook.ChannelID,
		"channel_name": exch.IncomingWebhook.Channel,
	})
}

func safeOAuthSuccessRedirect(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeOAuthRedirectBytes(raw) {
		return ""
	}
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		u, err := url.Parse(raw)
		if err != nil || u.Fragment != "" || u.User != nil {
			return ""
		}
		return u.String()
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" || u.User != nil {
		return ""
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme == "http" {
		if !isLocalOAuthRedirectHost(u.Hostname()) {
			return ""
		}
	} else if u.Scheme != "https" {
		return ""
	}
	u.Fragment = ""
	return u.String()
}

func containsUnsafeOAuthRedirectBytes(raw string) bool {
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "%0d") || strings.Contains(lower, "%0a") {
		return true
	}
	return strings.ContainsAny(raw, "\x00\r\n")
}

func isLocalOAuthRedirectHost(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (d *OAuthDeps) exchangeCode(ctx context.Context, code string) (*slackOAuthV2AccessResponse, error) {
	form := url.Values{}
	form.Set("client_id", d.ClientID)
	form.Set("client_secret", d.ClientSecret)
	form.Set("code", code)
	if d.RedirectURL != "" {
		form.Set("redirect_uri", d.RedirectURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://slack.com/api/oauth.v2.access",
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post oauth.v2.access: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, err
	}
	var out slackOAuthV2AccessResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode oauth response: %w (%s)", err, strings.TrimSpace(string(body)))
	}
	return &out, nil
}

func (d *OAuthDeps) upsertConnection(ctx context.Context, tenantID string, exch *slackOAuthV2AccessResponse, encrypted []byte) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Belt-and-suspenders WHERE on tenant_id even though RLS already
	// filters; mirrors the rest of slackint.Repo.
	_, err = tx.Exec(ctx, `
INSERT INTO slack_workspace_connections (
    tenant_id, slack_team_id, slack_team_name,
    bot_token_encrypted, default_channel_id, default_channel_name
)
VALUES ($1::uuid, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, slack_team_id) DO UPDATE SET
    slack_team_name      = EXCLUDED.slack_team_name,
    bot_token_encrypted  = EXCLUDED.bot_token_encrypted,
    default_channel_id   = COALESCE(NULLIF(EXCLUDED.default_channel_id, ''), slack_workspace_connections.default_channel_id),
    default_channel_name = COALESCE(NULLIF(EXCLUDED.default_channel_name, ''), slack_workspace_connections.default_channel_name),
    updated_at           = now()
WHERE slack_workspace_connections.tenant_id = $1::uuid`,
		tenantID, exch.Team.ID, exch.Team.Name,
		encrypted, exch.IncomingWebhook.ChannelID, exch.IncomingWebhook.Channel,
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ----------------------------------------------------------------------
// Connection lookup helpers — used by approvals/interactions/commands.
// ----------------------------------------------------------------------

// WorkspaceConnection mirrors the slack_workspace_connections row, with
// the bot token decrypted in-memory only (never serialized).
type WorkspaceConnection struct {
	ID                 string
	TenantID           string
	SlackTeamID        string
	SlackTeamName      string
	DefaultChannelID   string
	DefaultChannelName string
	BotToken           string // decrypted; do NOT log or serialize
}

// LoadConnectionByTenant returns the active workspace connection for a
// tenant (or nil if not connected).
func LoadConnectionByTenant(ctx context.Context, pool *db.Pool, cipher sending.EnvelopeEncryptor, tenantID string) (*WorkspaceConnection, error) {
	if tenantID == "" {
		return nil, errors.New("slackint: tenantID required")
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var c WorkspaceConnection
	var encrypted []byte
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slack_team_id, slack_team_name,
       COALESCE(default_channel_id, ''), COALESCE(default_channel_name, ''),
       bot_token_encrypted
  FROM slack_workspace_connections
 WHERE tenant_id = $1::uuid
 ORDER BY updated_at DESC
 LIMIT 1`, tenantID).Scan(
		&c.ID, &c.TenantID, &c.SlackTeamID, &c.SlackTeamName,
		&c.DefaultChannelID, &c.DefaultChannelName, &encrypted,
	)
	if err != nil {
		if isNoRows(err) {
			_ = tx.Commit(ctx)
			return nil, nil
		}
		return nil, err
	}
	if cipher == nil {
		return nil, errors.New("slackint: cipher unconfigured")
	}
	plain, err := cipher.Decrypt(ctx, encrypted, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt bot token: %w", err)
	}
	c.BotToken = string(plain)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

// LoadConnectionByTeam looks up a workspace connection by its Slack
// team id. Used by inbound webhooks (interactions/commands) which do
// not run inside a tenant context — the team id IS the tenant binding.
//
// Runs under the `app.slack_team_lookup` RLS guard from migration 0080.
func LoadConnectionByTeam(ctx context.Context, pool *db.Pool, cipher sending.EnvelopeEncryptor, slackTeamID string) (*WorkspaceConnection, error) {
	if slackTeamID == "" {
		return nil, errors.New("slackint: slackTeamID required")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.slack_team_lookup', $1, true)`, slackTeamID); err != nil {
		return nil, err
	}
	var c WorkspaceConnection
	var encrypted []byte
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slack_team_id, slack_team_name,
       COALESCE(default_channel_id, ''), COALESCE(default_channel_name, ''),
       bot_token_encrypted
  FROM slack_workspace_connections
 WHERE slack_team_id = $1
 ORDER BY updated_at DESC
 LIMIT 1`, slackTeamID).Scan(
		&c.ID, &c.TenantID, &c.SlackTeamID, &c.SlackTeamName,
		&c.DefaultChannelID, &c.DefaultChannelName, &encrypted,
	)
	if err != nil {
		if isNoRows(err) {
			_ = tx.Commit(ctx)
			return nil, nil
		}
		return nil, err
	}
	if cipher == nil {
		return nil, errors.New("slackint: cipher unconfigured")
	}
	plain, err := cipher.Decrypt(ctx, encrypted, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt bot token: %w", err)
	}
	c.BotToken = string(plain)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}
