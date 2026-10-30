// SPDX-License-Identifier: AGPL-3.0-only

package notification_feed

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The delivery read surface must be MOUNTED, not merely written. A handler
// nobody routes to is the same unreachable layer this work exists to remove, so
// the assertion runs against the package's real MountRoutes rather than calling
// the handler function directly.
func TestMountRoutes_RegistersTheDeliveryReadPath(t *testing.T) {
	router := chi.NewRouter()
	(&Deps{}).MountRoutes(router)

	for _, target := range []string{
		"/api/v1/notifications/deliveries",
		"/api/v1/notifications/00000000-0000-4000-8000-000000000001/deliveries",
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code == http.StatusNotFound || rec.Code == http.StatusMethodNotAllowed {
			t.Errorf("GET %s is not routed (status %d)", target, rec.Code)
			continue
		}
		// Routed is what the check above proves; 401 is the correct answer for a
		// per-person surface reached without a session.
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401 without a session", target, rec.Code)
		}
	}
}

// An unknown filter value must be a 422, not a silently empty page. An empty
// page here reads as "nothing was suppressed", which is the exact wrong answer
// to give somebody asking why they were never notified.
func TestListDeliveries_RejectsUnknownFilters(t *testing.T) {
	d := &Deps{} // no Repo: every case must return before touching the DB.
	cases := []struct {
		name  string
		query string
		code  string
	}{
		{"channel", "?channel=carrier-pigeon", "invalid_channel"},
		{"outcome", "?outcome=probably", "invalid_outcome"},
		{"notification id", "?notification_id=not-a-uuid", "invalid_notification_id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			d.ListDeliveries(rec, withSession(http.MethodGet, "/api/v1/notifications/deliveries"+tc.query))
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (body %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.code) {
				t.Errorf("body = %s, want error code %q", rec.Body.String(), tc.code)
			}
		})
	}
}

// A malformed id in the path is a 404, not a 500 from a failed uuid cast.
func TestNotificationDeliveries_MalformedIDIsNotFound(t *testing.T) {
	rec := httptest.NewRecorder()
	req := withRouteParam(withSession(http.MethodGet, "/api/v1/notifications/nope/deliveries"), "id", "nope")
	(&Deps{}).NotificationDeliveries(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}
}

// redactReason is the last thing between a stored failure message and an HTTP
// response. The notification webhook records `postErr.Error()`, and for a Slack
// Incoming Webhook the URL PATH is the credential.
func TestRedactReason(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "slack transport error keeps the host and drops the secret path",
			in:   `Post "https://hooks.slack.com/services/T1/B2/S3cr3t": dial tcp: i/o timeout`,
			want: `Post "https://hooks.slack.com/[redacted]": dial tcp: i/o timeout`,
		},
		{
			name: "bare host has no path to redact",
			in:   "connect to https://example.test failed",
			want: "connect to https://example.test failed",
		},
		{
			name: "userinfo credentials never survive",
			in:   "post to https://user:hunter2@example.test/hook failed",
			want: "post to https://example.test/[redacted] failed",
		},
		{
			name: "query strings go too",
			in:   "https://example.test/hook?token=abc123",
			want: "https://example.test/[redacted]",
		},
		{
			name: "provider status codes pass through untouched",
			in:   "notification webhook returned status 500",
			want: "notification webhook returned status 500",
		},
		{"quiet hours is not a url", "quiet_hours", "quiet_hours"},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := redactReason(tc.in); got != tc.want {
				t.Errorf("redactReason(%q)\n got %q\nwant %q", tc.in, got, tc.want)
			}
		})
	}
}

// withRouteParam attaches a chi URL parameter to a request built outside a
// router.
func withRouteParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}
