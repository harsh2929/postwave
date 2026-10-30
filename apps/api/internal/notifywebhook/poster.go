// SPDX-License-Identifier: AGPL-3.0-only
//
// Package notifywebhook is the SSRF-safe poster for the SETC-037 notification
// webhook channel. It lives outside notifyfanout because it imports
// outbound_webhooks, which itself imports notifyfanout (an import cycle if it
// lived there). It satisfies notifyfanout.WebhookPoster.
package notifywebhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

const responseMaxBytes = 1 << 16

// Poster posts a Slack-compatible {text} payload (which generic consumers also
// parse) with an SSRF-safe client: public host only, refuses redirects, 10s
// timeout, and a dialer that blocks private/reserved IPs after DNS resolution.
type Poster struct {
	Client *http.Client
}

// New builds the default poster.
func New() *Poster {
	return &Poster{Client: outbound_webhooks.NewSecureHTTPClient(nil)}
}

// Post implements notifyfanout.WebhookPoster. A nil poster/client or empty url
// no-ops. kind selects the payload shape: "slack" (or empty) sends the canonical
// Slack Incoming-Webhook body {"text": …}; "generic" adds a structured "event"
// field so a non-Slack receiver can route without parsing the text line. Both
// carry the same content-light, PII-free text.
func (p *Poster) Post(ctx context.Context, url, kind, text, eventType string) error {
	if p == nil || p.Client == nil || strings.TrimSpace(url) == "" {
		return nil
	}
	// Re-validate at delivery time (defense in depth against DNS rebinding on a
	// URL that passed validation at save time).
	if err := outbound_webhooks.ValidateURL(url, true); err != nil {
		return err
	}
	payload := map[string]any{"text": text}
	if kind == "generic" && eventType != "" {
		payload["event"] = eventType
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, responseMaxBytes))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("notification webhook returned status %d", resp.StatusCode)
	}
	return nil
}
