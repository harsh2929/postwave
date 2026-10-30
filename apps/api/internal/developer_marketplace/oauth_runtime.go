package developer_marketplace

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	oauthAuthorizationCodeTTL = 10 * time.Minute
	oauthAccessTokenTTL       = 90 * 24 * time.Hour
	oauthRequestMaxBodyBytes  = 16 << 10
)

type OAuthAuthorizeInput struct {
	ResponseType        string `json:"response_type"`
	ClientID            string `json:"client_id"`
	RedirectURI         string `json:"redirect_uri"`
	Scope               string `json:"scope,omitempty"`
	State               string `json:"state"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	InstalledBy         string `json:"installed_by,omitempty"`
}

type OAuthAuthorizeResponse struct {
	Code           string       `json:"code"`
	State          string       `json:"state,omitempty"`
	RedirectURI    string       `json:"redirect_uri"`
	RedirectURL    string       `json:"redirect_url"`
	AppID          string       `json:"app_id"`
	InstallationID string       `json:"installation_id"`
	GrantedScopes  []string     `json:"granted_scopes"`
	ExpiresAt      time.Time    `json:"expires_at"`
	Installation   Installation `json:"installation"`
}

type OAuthTokenRequest struct {
	GrantType    string `json:"grant_type"`
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	CodeVerifier string `json:"code_verifier"`
}

type OAuthTokenResponse struct {
	AccessToken    string    `json:"access_token"`
	TokenType      string    `json:"token_type"`
	ExpiresIn      int       `json:"expires_in"`
	Scope          string    `json:"scope"`
	AppID          string    `json:"app_id"`
	InstallationID string    `json:"installation_id"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type OAuthRevokeRequest struct {
	Token        string `json:"token"`
	ClientID     string `json:"client_id,omitempty"`
	ClientSecret string `json:"client_secret,omitempty"`
}

type OAuthRevokeResponse struct {
	Revoked bool   `json:"revoked"`
	Status  string `json:"status"`
}

type oauthErrorBody struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description,omitempty"`
}

func (d *Deps) AuthorizeOAuthApp(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in OAuthAuthorizeInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.AuthorizeOAuthApp(r.Context(), tenantID, in)
	if err != nil {
		writeOAuthRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ExchangeOAuthToken(w http.ResponseWriter, r *http.Request) {
	in, err := parseOAuthTokenRequest(r)
	if err != nil {
		writeOAuthError(w, httpbody.StatusCode(err), "invalid_request", httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.ExchangeOAuthCode(r.Context(), in)
	if err != nil {
		writeOAuthRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) RevokeOAuthToken(w http.ResponseWriter, r *http.Request) {
	in, err := parseOAuthRevokeRequest(r)
	if err != nil {
		writeOAuthError(w, httpbody.StatusCode(err), "invalid_request", httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.RevokeOAuthAccessToken(r.Context(), in)
	if err != nil {
		writeOAuthRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func parseOAuthTokenRequest(r *http.Request) (OAuthTokenRequest, error) {
	if strings.Contains(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		r.Body = http.MaxBytesReader(nil, r.Body, oauthRequestMaxBodyBytes)
		if err := r.ParseForm(); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return OAuthTokenRequest{}, httpbody.ErrTooLarge
			}
			return OAuthTokenRequest{}, fmt.Errorf("request form is invalid")
		}
		return OAuthTokenRequest{
			GrantType:    r.Form.Get("grant_type"),
			Code:         r.Form.Get("code"),
			RedirectURI:  r.Form.Get("redirect_uri"),
			ClientID:     r.Form.Get("client_id"),
			ClientSecret: r.Form.Get("client_secret"),
			CodeVerifier: r.Form.Get("code_verifier"),
		}, nil
	}
	var in OAuthTokenRequest
	if err := httpbody.DecodeJSON(nil, r, oauthRequestMaxBodyBytes, &in); err != nil {
		return OAuthTokenRequest{}, err
	}
	return in, nil
}

func parseOAuthRevokeRequest(r *http.Request) (OAuthRevokeRequest, error) {
	if strings.Contains(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		r.Body = http.MaxBytesReader(nil, r.Body, oauthRequestMaxBodyBytes)
		if err := r.ParseForm(); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return OAuthRevokeRequest{}, httpbody.ErrTooLarge
			}
			return OAuthRevokeRequest{}, fmt.Errorf("request form is invalid")
		}
		return OAuthRevokeRequest{
			Token:        r.Form.Get("token"),
			ClientID:     r.Form.Get("client_id"),
			ClientSecret: r.Form.Get("client_secret"),
		}, nil
	}
	var in OAuthRevokeRequest
	if err := httpbody.DecodeJSON(nil, r, oauthRequestMaxBodyBytes, &in); err != nil {
		return OAuthRevokeRequest{}, err
	}
	return in, nil
}

func validateOAuthAuthorizeInput(in OAuthAuthorizeInput) error {
	if strings.TrimSpace(in.ResponseType) != "code" {
		return fmt.Errorf("response_type must be code")
	}
	if strings.TrimSpace(in.ClientID) == "" {
		return fmt.Errorf("client_id is required")
	}
	if strings.TrimSpace(in.RedirectURI) == "" {
		return fmt.Errorf("redirect_uri is required")
	}
	if strings.TrimSpace(in.State) == "" {
		return fmt.Errorf("state is required")
	}
	if strings.TrimSpace(in.CodeChallenge) == "" {
		return fmt.Errorf("code_challenge is required")
	}
	if strings.TrimSpace(in.CodeChallengeMethod) != "S256" {
		return fmt.Errorf("code_challenge_method must be S256")
	}
	return nil
}

func validateOAuthTokenRequest(in OAuthTokenRequest) error {
	if strings.TrimSpace(in.GrantType) != "authorization_code" {
		return fmt.Errorf("grant_type must be authorization_code")
	}
	for name, value := range map[string]string{
		"code":          in.Code,
		"redirect_uri":  in.RedirectURI,
		"client_id":     in.ClientID,
		"client_secret": in.ClientSecret,
		"code_verifier": in.CodeVerifier,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	return nil
}

func validateOAuthRevokeRequest(in OAuthRevokeRequest) error {
	if strings.TrimSpace(in.Token) == "" {
		return fmt.Errorf("token is required")
	}
	if (strings.TrimSpace(in.ClientID) == "") != (strings.TrimSpace(in.ClientSecret) == "") {
		return fmt.Errorf("client_id and client_secret must be supplied together")
	}
	return nil
}

func resolveOAuthScopes(requestedRaw string, clientScopes, appScopes []string) ([]string, error) {
	clientSet := stringSet(cleanStrings(clientScopes))
	appSet := stringSet(cleanStrings(appScopes))
	requested := cleanStrings(strings.Fields(requestedRaw))
	if len(requested) == 0 {
		for _, scope := range cleanStrings(clientScopes) {
			if appSet[scope] {
				requested = append(requested, scope)
			}
		}
	}
	if len(requested) == 0 {
		return nil, fmt.Errorf("at least one granted scope is required")
	}
	for _, scope := range requested {
		if !clientSet[scope] || !appSet[scope] {
			return nil, fmt.Errorf("requested scope %q is not allowed for this app", scope)
		}
	}
	return requested, nil
}

func exactRedirectAllowed(redirectURI string, allowed []string) bool {
	redirectURI = strings.TrimSpace(redirectURI)
	for _, candidate := range allowed {
		if redirectURI == strings.TrimSpace(candidate) {
			return true
		}
	}
	return false
}

func buildOAuthRedirectURL(redirectURI, code, state string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(redirectURI))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("redirect_uri is invalid")
	}
	u.Fragment = ""
	q := u.Query()
	q.Set("code", code)
	if strings.TrimSpace(state) != "" {
		q.Set("state", state)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func verifyPKCES256(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(got), []byte(challenge)) == 1
}

func constantTimeHashMatch(secret, expectedHash string) bool {
	got := sha256Hex(secret)
	return subtle.ConstantTimeCompare([]byte(got), []byte(strings.TrimSpace(expectedHash))) == 1
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func newOpaqueSecret(prefix string, n int) (string, error) {
	if n <= 0 {
		n = 32
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buf), nil
}

func scopeString(scopes []string) string {
	return strings.Join(cleanStrings(scopes), " ")
}

func stringSet(values []string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		out[value] = true
	}
	return out
}

func writeOAuthRuntimeError(w http.ResponseWriter, err error) {
	message := err.Error()
	switch {
	case strings.Contains(message, "not found"):
		writeOAuthError(w, http.StatusNotFound, "invalid_request", "resource not found")
	case strings.Contains(message, "expired"), strings.Contains(message, "consumed"), strings.Contains(message, "invalid"), strings.Contains(message, "required"), strings.Contains(message, "not allowed"), strings.Contains(message, "must be"):
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", message)
	default:
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "OAuth runtime error")
	}
}

func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, oauthErrorBody{Error: code, ErrorDescription: description})
}
