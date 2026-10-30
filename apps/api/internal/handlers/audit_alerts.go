// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_alerts.go (handlers) — SOC channel auth-verification endpoints.
//
// These endpoints exist purely to let the frontend "Test connection"
// button validate credentials before the operator saves a rule. The
// CRUD endpoints for rules themselves live in
// apps/api/internal/audit_alerts/audit_alerts.go.

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	auditlog "github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// AuditAlertChannelHandlers verifies external SOC credentials before
// they are persisted into audit_alert_rules.channel_config.
type AuditAlertChannelHandlers struct {
	Pool *db.Pool

	// httpClient is intentionally unexported: production verification must use
	// the canonical SSRF-safe client below. Focused package tests may inject a
	// no-network transport to verify the exact outbound request shape.
	httpClient *http.Client
}

// VerifyServiceNow POST /api/v1/audit-alerts/servicenow/auth — pings
// /api/now/table/sys_user?sysparm_limit=1 to confirm credentials work.
func (h *AuditAlertChannelHandlers) VerifyServiceNow(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeAuditAlertErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in map[string]any
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	req, err := newAuditAlertVerificationRequest(
		ctx,
		asStr(in["instance_url"]),
		"/api/now/table/sys_user",
		url.Values{"sysparm_limit": {"1"}},
	)
	if err != nil {
		writeAuditAlertErr(w, http.StatusBadRequest, "invalid_instance_url",
			"instance_url must be a public HTTPS origin without credentials, a path, a query, or a fragment")
		return
	}
	req.Header.Set("Accept", "application/json")
	if tok := asStr(in["bearer_token"]); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	} else {
		req.SetBasicAuth(asStr(in["username"]), asStr(in["password"]))
	}
	resp, err := h.verificationHTTPClient().Do(req)
	if err != nil {
		writeAuditAlertErr(w, http.StatusBadGateway, "upstream_error", "an internal error occurred")
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		writeAuditAlertErr(w, http.StatusBadGateway, "upstream_error", resp.Status)
		return
	}
	auditlog.EmitOrLog(r.Context(), h.Pool, "audit_alert.channel_verify", "audit_alert_channel", "servicenow", nil,
		map[string]any{"channel_kind": "servicenow", "credential_fields": "withheld"}, nil)
	writeAuditAlertJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// VerifyJira POST /api/v1/audit-alerts/jira/auth — pings
// /rest/api/3/myself to confirm credentials work.
func (h *AuditAlertChannelHandlers) VerifyJira(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeAuditAlertErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in map[string]any
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	req, err := newAuditAlertVerificationRequest(
		ctx,
		asStr(in["site_url"]),
		"/rest/api/3/myself",
		nil,
	)
	if err != nil {
		writeAuditAlertErr(w, http.StatusBadRequest, "invalid_site_url",
			"site_url must be a public HTTPS origin without credentials, a path, a query, or a fragment")
		return
	}
	req.Header.Set("Accept", "application/json")
	req.SetBasicAuth(asStr(in["email"]), asStr(in["api_token"]))
	resp, err := h.verificationHTTPClient().Do(req)
	if err != nil {
		writeAuditAlertErr(w, http.StatusBadGateway, "upstream_error", "an internal error occurred")
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		writeAuditAlertErr(w, http.StatusBadGateway, "upstream_error", resp.Status)
		return
	}
	auditlog.EmitOrLog(r.Context(), h.Pool, "audit_alert.channel_verify", "audit_alert_channel", "jira", nil,
		map[string]any{"channel_kind": "jira", "credential_fields": "withheld"}, nil)
	writeAuditAlertJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func newAuditAlertVerificationRequest(
	ctx context.Context,
	rawOrigin string,
	path string,
	query url.Values,
) (*http.Request, error) {
	rawOrigin = strings.TrimSpace(rawOrigin)
	if err := outbound_webhooks.ValidateURL(rawOrigin, true); err != nil {
		return nil, err
	}
	origin, err := url.Parse(rawOrigin)
	if err != nil {
		return nil, err
	}
	if (origin.Path != "" && origin.Path != "/") ||
		origin.RawQuery != "" ||
		origin.ForceQuery ||
		origin.Fragment != "" {
		return nil, outbound_webhooks.ErrInvalidURL
	}

	// Build from parsed components instead of concatenating attacker-controlled
	// text. This keeps the fixed verification path/query authoritative even for
	// inputs with escaped delimiters or a trailing slash.
	origin.Path = path
	origin.RawPath = ""
	origin.RawQuery = query.Encode()
	origin.ForceQuery = false
	origin.Fragment = ""

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin.String(), nil)
	if err != nil {
		return nil, err
	}
	return req, nil
}

func (h *AuditAlertChannelHandlers) verificationHTTPClient() *http.Client {
	if h != nil && h.httpClient != nil {
		return outbound_webhooks.HTTPClientRejectingRedirects(h.httpClient)
	}
	return outbound_webhooks.NewSecureHTTPClient(nil)
}

// VerifyPagerDuty POST /api/v1/audit-alerts/pagerduty/auth — Events
// API tokens have no list endpoint, so we shape-check the routing
// key's documented 32-character length. This does not verify the key with
// PagerDuty or prove delivery.
func (h *AuditAlertChannelHandlers) VerifyPagerDuty(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeAuditAlertErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in map[string]any
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	rk := strings.TrimSpace(asStr(in["routing_key"]))
	if len(rk) != 32 {
		writeAuditAlertErr(w, http.StatusBadRequest, "invalid_routing_key",
			"routing_key must contain 32 characters; this local check does not verify delivery")
		return
	}
	auditlog.EmitOrLog(r.Context(), h.Pool, "audit_alert.channel_verify", "audit_alert_channel", "pagerduty", nil,
		map[string]any{"channel_kind": "pagerduty", "credential_fields": "withheld"}, nil)
	writeAuditAlertJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func asStr(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func writeAuditAlertJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeAuditAlertErr(w http.ResponseWriter, status int, code, msg string) {
	writeAuditAlertJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
