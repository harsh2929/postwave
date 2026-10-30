// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type auditAlertRoundTripFunc func(*http.Request) (*http.Response, error)

func (f auditAlertRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestNewAuditAlertVerificationRequestBuildsAuthoritativeTarget(t *testing.T) {
	req, err := newAuditAlertVerificationRequest(
		context.Background(),
		"  https://Acme.Example.com/  ",
		"/api/now/table/sys_user",
		map[string][]string{"sysparm_limit": {"1"}},
	)
	if err != nil {
		t.Fatalf("newAuditAlertVerificationRequest: %v", err)
	}
	if req == nil {
		t.Fatal("request is nil")
	}
	if got, want := req.Method, http.MethodGet; got != want {
		t.Fatalf("method = %q, want %q", got, want)
	}
	if got, want := req.URL.String(), "https://Acme.Example.com/api/now/table/sys_user?sysparm_limit=1"; got != want {
		t.Fatalf("URL = %q, want %q", got, want)
	}
}

func TestNewAuditAlertVerificationRequestRejectsInvalidOriginsWithoutRequest(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{name: "malformed escaped path", raw: "https://alerts.example.com/%zz"},
		{name: "HTTP", raw: "http://alerts.example.com"},
		{name: "missing host", raw: "https:///alerts"},
		{name: "userinfo", raw: "https://operator:secret@alerts.example.com"},
		{name: "fragment", raw: "https://alerts.example.com/#ignored"},
		{name: "query", raw: "https://alerts.example.com?redirect=ignored"},
		{name: "non-root path", raw: "https://alerts.example.com/base"},
		{name: "localhost", raw: "https://localhost"},
		{name: "private IPv4", raw: "https://127.0.0.1"},
		{name: "private IPv6", raw: "https://[::1]"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req, err := newAuditAlertVerificationRequest(
				context.Background(),
				test.raw,
				"/rest/api/3/myself",
				nil,
			)
			if err == nil {
				t.Fatalf("origin %q unexpectedly passed", test.raw)
			}
			if req != nil {
				t.Fatalf("request = %#v, want nil when origin validation fails", req)
			}
		})
	}
}

func TestNewAuditAlertVerificationRequestPropagatesRequestConstructionError(t *testing.T) {
	// A nil context is the fault being injected: with a valid origin and a
	// fixed GET method it is the only input that makes
	// http.NewRequestWithContext fail, which is the path under test.
	var nilContext context.Context
	req, err := newAuditAlertVerificationRequest(
		nilContext,
		"https://alerts.example.com",
		"/rest/api/3/myself",
		nil,
	)
	if err == nil {
		t.Fatal("nil request context unexpectedly passed")
	}
	if req != nil {
		t.Fatalf("request = %#v, want nil when request construction fails", req)
	}
}

func TestAuditAlertVerificationHandlersRejectInvalidOriginsAsBounded400(t *testing.T) {
	type verifier func(*AuditAlertChannelHandlers, http.ResponseWriter, *http.Request)
	channels := []struct {
		name   string
		field  string
		code   string
		verify verifier
	}{
		{
			name:  "ServiceNow",
			field: "instance_url",
			code:  "invalid_instance_url",
			verify: func(h *AuditAlertChannelHandlers, w http.ResponseWriter, r *http.Request) {
				h.VerifyServiceNow(w, r)
			},
		},
		{
			name:  "Jira",
			field: "site_url",
			code:  "invalid_site_url",
			verify: func(h *AuditAlertChannelHandlers, w http.ResponseWriter, r *http.Request) {
				h.VerifyJira(w, r)
			},
		},
	}
	origins := []struct {
		name string
		raw  string
	}{
		{name: "malformed escaped URL", raw: "https://alerts.example.com/%zz"},
		{name: "HTTP URL", raw: "http://alerts.example.com"},
		{name: "URL without host", raw: "https:///alerts"},
		{name: "credential-bearing URL", raw: "https://user:pass@alerts.example.com"},
		{name: "fragment-bearing URL", raw: "https://alerts.example.com/#ignored"},
		{name: "query-bearing origin", raw: "https://alerts.example.com?ignored=yes"},
		{name: "path-bearing origin", raw: "https://alerts.example.com/base"},
		{name: "localhost target", raw: "https://app.localhost"},
		{name: "private target", raw: "https://10.0.0.7"},
	}

	for _, channel := range channels {
		for _, origin := range origins {
			t.Run(channel.name+"/"+origin.name, func(t *testing.T) {
				var roundTrips int
				h := &AuditAlertChannelHandlers{
					httpClient: &http.Client{Transport: auditAlertRoundTripFunc(func(req *http.Request) (*http.Response, error) {
						roundTrips++
						return successfulAuditAlertVerificationResponse(req), nil
					})},
				}
				rec := httptest.NewRecorder()
				req := tenantAuditAlertRequest(t, map[string]any{channel.field: origin.raw})

				channel.verify(h, rec, req)

				if got, want := rec.Code, http.StatusBadRequest; got != want {
					t.Fatalf("status = %d, want %d; body=%s", got, want, rec.Body.String())
				}
				if roundTrips != 0 {
					t.Fatalf("outbound round trips = %d, want 0", roundTrips)
				}
				var body struct {
					Error struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					} `json:"error"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("decode error response: %v; body=%s", err, rec.Body.String())
				}
				if got, want := body.Error.Code, channel.code; got != want {
					t.Fatalf("error code = %q, want %q", got, want)
				}
				if body.Error.Message == "" || len(body.Error.Message) > 160 {
					t.Fatalf("error message must be nonempty and bounded, got %q", body.Error.Message)
				}
				if strings.Contains(body.Error.Message, origin.raw) {
					t.Fatalf("error message reflected attacker-controlled URL: %q", body.Error.Message)
				}
			})
		}
	}
}

func TestVerifyServiceNowValidOriginUsesFixedEndpointAndBearerAuth(t *testing.T) {
	var gotRequest *http.Request
	h := &AuditAlertChannelHandlers{
		httpClient: &http.Client{Transport: auditAlertRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotRequest = req.Clone(req.Context())
			return successfulAuditAlertVerificationResponse(req), nil
		})},
	}
	rec := httptest.NewRecorder()
	req := tenantAuditAlertRequest(t, map[string]any{
		"instance_url": "https://acme.service-now.com/",
		"bearer_token": "service-now-token",
	})

	h.VerifyServiceNow(rec, req)

	if got, want := rec.Code, http.StatusOK; got != want {
		t.Fatalf("status = %d, want %d; body=%s", got, want, rec.Body.String())
	}
	if gotRequest == nil {
		t.Fatal("verification request was not sent")
	}
	if got, want := gotRequest.URL.String(), "https://acme.service-now.com/api/now/table/sys_user?sysparm_limit=1"; got != want {
		t.Fatalf("URL = %q, want %q", got, want)
	}
	if got, want := gotRequest.Header.Get("Authorization"), "Bearer service-now-token"; got != want {
		t.Fatalf("Authorization = %q, want %q", got, want)
	}
	if got, want := gotRequest.Header.Get("Accept"), "application/json"; got != want {
		t.Fatalf("Accept = %q, want %q", got, want)
	}
}

func TestVerifyJiraValidOriginUsesFixedEndpointAndBasicAuth(t *testing.T) {
	var gotRequest *http.Request
	h := &AuditAlertChannelHandlers{
		httpClient: &http.Client{Transport: auditAlertRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotRequest = req.Clone(req.Context())
			return successfulAuditAlertVerificationResponse(req), nil
		})},
	}
	rec := httptest.NewRecorder()
	req := tenantAuditAlertRequest(t, map[string]any{
		"site_url":  "https://acme.atlassian.net",
		"email":     "security@example.com",
		"api_token": "jira-token",
	})

	h.VerifyJira(rec, req)

	if got, want := rec.Code, http.StatusOK; got != want {
		t.Fatalf("status = %d, want %d; body=%s", got, want, rec.Body.String())
	}
	if gotRequest == nil {
		t.Fatal("verification request was not sent")
	}
	if got, want := gotRequest.URL.String(), "https://acme.atlassian.net/rest/api/3/myself"; got != want {
		t.Fatalf("URL = %q, want %q", got, want)
	}
	user, password, ok := gotRequest.BasicAuth()
	if !ok || user != "security@example.com" || password != "jira-token" {
		t.Fatalf("BasicAuth = (%q, %q, %t), want supplied Jira credentials", user, password, ok)
	}
	if got, want := gotRequest.Header.Get("Accept"), "application/json"; got != want {
		t.Fatalf("Accept = %q, want %q", got, want)
	}
}

func tenantAuditAlertRequest(t *testing.T, body map[string]any) *http.Request {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audit-alerts/auth", bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"})
	return req.WithContext(ctx)
}

func successfulAuditAlertVerificationResponse(req *http.Request) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		Request:    req,
	}
}
