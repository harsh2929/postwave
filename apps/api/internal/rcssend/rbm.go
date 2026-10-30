// SPDX-License-Identifier: AGPL-3.0-only
package rcssend

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	defaultRBMBaseURL = "https://rcsbusinessmessaging.googleapis.com/v1"
	rbmRequestTimeout = 10 * time.Second
	maxRBMRespBytes   = 64 << 10
)

// TokenSource returns a fresh (or cached) OAuth2 bearer access token scoped
// for the Google RBM API (scope https://www.googleapis.com/auth/rcsbusinessmessaging).
// It is injected rather than baked into this adapter so the composition root
// can supply whatever the platform's Google service-account token machinery
// already produces — a cached JWT-exchange token in production, or a static
// token from an env var in dev. A nil TokenSource is treated identically to
// a missing AgentID: RBM is "not configured".
type TokenSource func(ctx context.Context) (string, error)

// StaticToken returns a TokenSource that always yields token unchanged — the
// simplest wiring for local/dev use or for a long-lived agent-level API key.
// Returns nil (not "not configured") when token is empty, so
// NewRBMAdapterFromEnv can compose it directly.
func StaticToken(token string) TokenSource {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil
	}
	return func(context.Context) (string, error) { return token, nil }
}

// RBMAdapter is a real Google RBM (Rich Business Messaging) HTTP client. It
// implements RBMProvider. Until both AgentID and TokenSource are wired,
// SendRCS returns a clear "RBM agent not configured" error — it never
// silently no-ops or fakes a delivery.
type RBMAdapter struct {
	AgentID     string
	TokenSource TokenSource
	BaseURL     string // defaults to defaultRBMBaseURL
	HTTPClient  *http.Client
}

// NewRBMAdapterFromEnv builds an RBMAdapter from environment configuration:
//   - RBM_AGENT_ID          — the Google RBM agent id (required)
//   - RBM_ACCESS_TOKEN      — a static bearer token (simplest wiring; a real
//     production deployment can instead construct RBMAdapter directly with a
//     TokenSource backed by a service-account JWT exchange)
//   - RBM_BASE_URL          — override for testing (defaults to the real
//     Google RBM endpoint)
//
// Returns an adapter that is "not configured" (Configured() == false) when
// either credential is absent — inert until real creds land, never fake.
func NewRBMAdapterFromEnv() *RBMAdapter {
	return &RBMAdapter{
		AgentID:     strings.TrimSpace(os.Getenv("RBM_AGENT_ID")),
		TokenSource: StaticToken(os.Getenv("RBM_ACCESS_TOKEN")),
		BaseURL:     strings.TrimSpace(os.Getenv("RBM_BASE_URL")),
		HTTPClient:  &http.Client{Timeout: rbmRequestTimeout},
	}
}

// Configured reports whether both an agent id and a token source are present.
func (a *RBMAdapter) Configured() bool {
	return a != nil && a.AgentID != "" && a.TokenSource != nil
}

// rbmContentMessage mirrors Google RBM's agentMessage.contentMessage shape:
// exactly one of text or richCard is set per message.
type rbmContentMessage struct {
	Text     string `json:"text,omitempty"`
	RichCard any    `json:"richCard,omitempty"`
}

type rbmAgentMessage struct {
	ContentMessage rbmContentMessage `json:"contentMessage"`
	MessageID      string            `json:"messageId"`
}

type rbmErrorEnvelope struct {
	Error struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}

// SendRCS posts one agent message to Google RBM:
//
//	POST {baseURL}/phones/{phone}/agentMessages?agentId={agentID}
//	Authorization: Bearer {token}
//
// delivered=true means Google's API accepted the message (HTTP 2xx with a
// valid message id echoed back). A non-2xx response or a malformed body
// returns delivered=false with the upstream detail in err — RCSSender treats
// both identically (fall back to SMS), so this never needs to distinguish
// "retryable" from "terminal" on its own.
func (a *RBMAdapter) SendRCS(ctx context.Context, phone, message string, richCard any) (bool, error) {
	if !a.Configured() {
		return false, fmt.Errorf("RBM agent not configured")
	}
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return false, fmt.Errorf("rbm: phone number is required")
	}
	message = strings.TrimSpace(message)
	if message == "" && richCard == nil {
		return false, fmt.Errorf("rbm: message body is required")
	}

	token, err := a.TokenSource(ctx)
	if err != nil {
		return false, fmt.Errorf("rbm: token source: %w", err)
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return false, fmt.Errorf("RBM agent not configured")
	}

	msgID, err := newMessageID()
	if err != nil {
		return false, fmt.Errorf("rbm: generate message id: %w", err)
	}
	body := rbmAgentMessage{MessageID: msgID}
	if richCard != nil {
		body.ContentMessage.RichCard = richCard
	} else {
		body.ContentMessage.Text = message
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return false, fmt.Errorf("rbm: encode request: %w", err)
	}

	base := strings.TrimSpace(a.BaseURL)
	if base == "" {
		base = defaultRBMBaseURL
	}
	endpoint := fmt.Sprintf("%s/phones/%s/agentMessages?agentId=%s",
		strings.TrimRight(base, "/"), url.PathEscape(phone), url.QueryEscape(a.AgentID))

	reqCtx, cancel := context.WithTimeout(ctx, rbmRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return false, fmt.Errorf("rbm: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := a.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: rbmRequestTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, fmt.Errorf("rbm: request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRBMRespBytes+1))
	if err != nil {
		return false, fmt.Errorf("rbm: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var envelope rbmErrorEnvelope
		_ = json.Unmarshal(raw, &envelope)
		if envelope.Error.Message != "" {
			return false, fmt.Errorf("rbm: HTTP %d: %s", resp.StatusCode, envelope.Error.Message)
		}
		return false, fmt.Errorf("rbm: HTTP %d", resp.StatusCode)
	}
	return true, nil
}

func newMessageID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
