// SPDX-License-Identifier: AGPL-3.0-only
package emailpreview

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

// EngineRenderer renders HTML through the separately operated upstream
// Listmonk process over HTTP — the template pipeline campaign sends use.
//
// Listmonk exposes POST /api/templates/preview: a form-encoded body
// ("body" + "template_type=campaign") that compiles the template with
// dummy campaign/subscriber data and returns the rendered HTML. Using
// it here means previews honour the same template functions, default
// wrapper, and compile errors as a real send, instead of the local
// regex pass-through.
//
// The renderer is OPTIONAL by design: a nil *EngineRenderer (or an
// unreachable engine) downgrades the preview to the explicit
// pass-through fallback, which the HTTP response labels with
// "renderer": "fallback" so the client can tell the user.
type EngineRenderer struct {
	destination func(context.Context) (listmonk.Config, error)
	baseURL     string
	username    string
	password    string
	client      *http.Client
}

func NewTenantEngineRenderer(destination func(context.Context) (listmonk.Config, error)) *EngineRenderer {
	return &EngineRenderer{destination: destination, client: &http.Client{Timeout: renderTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// engineMaxResponseBytes caps how much rendered HTML we read back. The
// input is capped at 1 MiB; the default template wrapper adds a few KB,
// so 4 MiB is generous without letting a misbehaving engine OOM us.
const engineMaxResponseBytes = 4 << 20

// NewEngineRenderer builds a renderer for the engine at baseURL (e.g.
// http://listmonk:9000) using the same basic-auth credentials the rest
// of the gateway uses. Returns nil when baseURL is empty so callers can
// wire it unconditionally and let nil mean "not configured".
func NewEngineRenderer(baseURL, username, password string) *EngineRenderer {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	return &EngineRenderer{
		baseURL:  baseURL,
		username: username,
		password: password,
		client:   &http.Client{Timeout: renderTimeout},
	}
}

// Render sends html through the engine's template preview endpoint and
// returns the fully rendered document.
func (e *EngineRenderer) Render(ctx context.Context, html string) (string, error) {
	if e == nil {
		return "", errors.New("emailpreview: engine renderer not configured")
	}
	base, user, password := e.baseURL, e.username, e.password
	if e.destination != nil {
		destination, err := e.destination(ctx)
		if err != nil {
			return "", err
		}
		base, user, password = destination.BaseURL, destination.Username, destination.Password
	}
	form := url.Values{}
	form.Set("body", html)
	form.Set("template_type", "campaign")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/api/templates/preview", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if user != "" || password != "" {
		req.SetBasicAuth(user, password)
	}
	cctx, cancel := context.WithTimeout(ctx, renderTimeout)
	defer cancel()
	resp, err := e.client.Do(req.WithContext(cctx))
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, engineMaxResponseBytes))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// The engine returns its compile error in the body; keep a short
		// prefix for the caller's warning without echoing pages of HTML.
		msg := strings.TrimSpace(string(body))
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		return "", fmt.Errorf("engine preview returned %d: %s", resp.StatusCode, msg)
	}
	out := string(body)
	if strings.TrimSpace(out) == "" {
		return "", errors.New("engine preview returned an empty document")
	}
	return out, nil
}
