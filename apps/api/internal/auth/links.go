// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

var errAuthLinkSigningKey = errors.New("auth-link signing key is not configured safely")

const (
	authLinkVersion        = 1
	authLinkAudienceWeb    = "web"
	authLinkAudienceMobile = "mobile"
	authLinkFlowMagic      = "magic"
	authLinkFlowReset      = "reset"
	authLinkStateMaxBytes  = 256
	magicLinkStateMaxBytes = authLinkStateMaxBytes
)

// AuthLinkStartFields selects the v1 delivery audience. Browser callers use
// audience=web with no state. Native callers use audience=mobile and a
// cryptographically random, device-local state value. The start endpoint
// echoes that state only inside an HMAC-bound link envelope.
type AuthLinkStartFields struct {
	LinkVersion  int    `json:"link_version,omitempty"`
	LinkAudience string `json:"link_audience,omitempty"`
	State        string `json:"state,omitempty"`
}

// AuthLinkProofFields is returned in the email URL and must be submitted
// unchanged when the one-time token is consumed. The signature binds every
// field plus the endpoint's expected flow, so an attacker cannot turn a
// device-bound mobile link into a browser link or swap its pending state.
type AuthLinkProofFields struct {
	LinkVersion   int    `json:"link_version"`
	LinkFlow      string `json:"link_flow"`
	LinkAudience  string `json:"link_audience"`
	State         string `json:"state,omitempty"`
	LinkSignature string `json:"link_signature"`
}

type authLinkBinding struct {
	Version  int
	Flow     string
	Audience string
	State    string
}

func normalizeAuthLinkStart(fields AuthLinkStartFields) (authLinkBinding, error) {
	version := fields.LinkVersion
	audience := strings.TrimSpace(fields.LinkAudience)
	state := fields.State

	// Rolling-upgrade compatibility applies only to START requests. Every
	// emitted link is still a signed v1 link. The old web client sent neither
	// field; the old native client sent only state.
	if version == 0 && audience == "" {
		version = authLinkVersion
		if state == "" {
			audience = authLinkAudienceWeb
		} else {
			audience = authLinkAudienceMobile
		}
	}
	if version != authLinkVersion {
		return authLinkBinding{}, fmt.Errorf("unsupported auth-link version")
	}
	if audience != authLinkAudienceWeb && audience != authLinkAudienceMobile {
		return authLinkBinding{}, fmt.Errorf("invalid auth-link audience")
	}
	if audience == authLinkAudienceWeb {
		if state != "" {
			return authLinkBinding{}, fmt.Errorf("browser auth links must not carry device state")
		}
		return authLinkBinding{Version: version, Audience: audience}, nil
	}
	state, ok := sanitizeAuthLinkState(state)
	if !ok || state == "" {
		return authLinkBinding{}, fmt.Errorf("mobile auth links require safe device state")
	}
	return authLinkBinding{Version: version, Audience: audience, State: state}, nil
}

func sanitizeAuthLinkState(raw string) (string, bool) {
	if raw == "" || raw != strings.TrimSpace(raw) || len(raw) > authLinkStateMaxBytes || !utf8.ValidString(raw) {
		return "", false
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	return raw, true
}

func (d *Deps) buildVersionedAuthPublicLink(actionPath, token, flow string, binding authLinkBinding) (string, error) {
	binding.Flow = flow
	signature, err := signAuthLink(d.AuthLinkSigningKey, token, binding)
	if err != nil {
		return "", err
	}
	extra := map[string]string{
		"v":    strconv.Itoa(binding.Version),
		"flow": binding.Flow,
		"aud":  binding.Audience,
		"sig":  signature,
	}
	if binding.State != "" {
		extra["state"] = binding.State
	}
	return buildAuthPublicLink(d.PublicBaseURL, actionPath, token, extra)
}

func (d *Deps) verifyAuthLinkProof(token, expectedFlow string, proof AuthLinkProofFields) error {
	if proof.LinkVersion != authLinkVersion || proof.LinkFlow != expectedFlow {
		return fmt.Errorf("invalid auth-link contract")
	}
	binding := authLinkBinding{
		Version:  proof.LinkVersion,
		Flow:     proof.LinkFlow,
		Audience: strings.TrimSpace(proof.LinkAudience),
		State:    proof.State,
	}
	if binding.Audience != authLinkAudienceWeb && binding.Audience != authLinkAudienceMobile {
		return fmt.Errorf("invalid auth-link audience")
	}
	if binding.Audience == authLinkAudienceWeb {
		if binding.State != "" {
			return fmt.Errorf("invalid browser auth-link state")
		}
	} else {
		state, ok := sanitizeAuthLinkState(binding.State)
		if !ok || state == "" {
			return fmt.Errorf("invalid mobile auth-link state")
		}
		binding.State = state
	}
	provided, err := base64.RawURLEncoding.DecodeString(proof.LinkSignature)
	if err != nil || len(provided) != sha256.Size {
		return fmt.Errorf("invalid auth-link signature")
	}
	want, err := authLinkMAC(d.AuthLinkSigningKey, token, binding)
	if err != nil {
		return err
	}
	if !hmac.Equal(provided, want) {
		return fmt.Errorf("invalid auth-link signature")
	}
	return nil
}

func signAuthLink(key []byte, token string, binding authLinkBinding) (string, error) {
	mac, err := authLinkMAC(key, token, binding)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(mac), nil
}

func authLinkMAC(key []byte, token string, binding authLinkBinding) ([]byte, error) {
	if len(key) < 32 {
		return nil, errAuthLinkSigningKey
	}
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("auth-link token is empty")
	}
	// NUL-delimited, domain-separated fields avoid concatenation ambiguity and
	// keep this use independent from session/API-key HMAC payloads even when
	// deployments derive all three keys from one secret manager value.
	payload := strings.Join([]string{
		"postwave-auth-link",
		"v1",
		strconv.Itoa(binding.Version),
		binding.Flow,
		binding.Audience,
		binding.State,
		token,
	}, "\x00")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil), nil
}

func buildAuthPublicLink(publicBaseURL, actionPath, token string, extraQuery ...map[string]string) (string, error) {
	base, err := safeAuthPublicBaseURL(publicBaseURL)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/" + strings.TrimLeft(actionPath, "/")
	u.RawPath = ""
	u.RawQuery = ""
	q := u.Query()
	q.Set("token", token)
	for _, fields := range extraQuery {
		for k, v := range fields {
			if strings.TrimSpace(k) != "" && v != "" {
				q.Set(k, v)
			}
		}
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func safeAuthPublicBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeOAuthRedirectBytes(raw) {
		return "", fmt.Errorf("public base URL is not configured safely")
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("public base URL must be an absolute http(s) URL without credentials")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme == "http" {
		if !isLocalOAuthRedirectHost(u.Hostname()) {
			return "", fmt.Errorf("public base URL must use https outside local development")
		}
	} else if u.Scheme != "https" {
		return "", fmt.Errorf("public base URL must use http(s)")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.RawPath = ""
	return strings.TrimRight(u.String(), "/"), nil
}
