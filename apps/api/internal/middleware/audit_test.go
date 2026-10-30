package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSkipGenericAudit(t *testing.T) {
	cases := []struct {
		path string
		skip bool
	}{
		// Pure bootstrap/refresh — should be skipped.
		{"/api/v1/streams/token", true},
		{"/api/v1/sms/conversations/search", true},
		{"/api/v1/sms/suppressions/query", true},
		{"/api/v1/outbound-webhooks/018f6d80-9752-7a44-8a4a-542c0f9cb000/playground/fire", true},

		// Genuine user-initiated actions — must still be audited.
		{"/api/v1/subscribers", false},
		{"/api/v1/campaigns/abc/send", false},
		{"/api/v1/forms", false},
		{"/api/v1/streams/token/something-else", false},
		{"/api/v1/sms/suppressions/query/extra", false},
		{"/api/v1/outbound-webhooks/playground/fire", false},
		{"/api/v1/outbound-webhooks/id/nested/playground/fire", false},
		{"/api/v1/outbound-webhooks/id/playground/fire/extra", false},
		{"/", false},
		{"", false},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			if got := skipGenericAudit(tc.path); got != tc.skip {
				t.Fatalf("skipGenericAudit(%q) = %v, want %v", tc.path, got, tc.skip)
			}
		})
	}
}

func TestDeriveActionShapeUnchanged(t *testing.T) {
	// Locks in the existing convention so the frontend's `http.*` filter
	// stays correct: derived actions always start with "http.<method>.".
	r := httptest.NewRequest("POST", "/api/v1/subscribers", nil)
	got := deriveAction(r)
	want := "http.post.api.v1.subscribers"
	if got != want {
		t.Fatalf("deriveAction = %q, want %q", got, want)
	}
}

func TestAuditSafePathTemplatesSMSPhoneAndLegacyTag(t *testing.T) {
	raw := "/api/v1/sms/conversations/+14155551212/tags/customer@example.test%E2%80%AE"
	want := "/api/v1/sms/conversations/{phone}/tags/{tag}"
	if got := auditSafePath(raw); got != want {
		t.Fatalf("auditSafePath = %q, want %q", got, want)
	}
	request := httptest.NewRequest(http.MethodDelete, raw, nil)
	action := deriveAction(request)
	if strings.Contains(action, "+14155551212") || strings.Contains(action, "customer") || strings.Contains(action, "example") {
		t.Fatalf("derived action retained SMS PII/tag content: %q", action)
	}
}

func TestAuditMiddlewarePreservesMutationStatusWithNilPool(t *testing.T) {
	t.Parallel()
	for _, status := range []int{
		http.StatusCreated,
		http.StatusBadRequest,
		http.StatusInternalServerError,
	} {
		status := status
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			handler := AuditMiddleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
			}))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(
				rec,
				httptest.NewRequest(http.MethodPost, "/api/v1/outbound-webhooks", nil),
			)
			if rec.Code != status {
				t.Fatalf("status = %d, want %d", rec.Code, status)
			}
		})
	}
}

func TestStatusCapturingWriterExposesUnderlyingWriter(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	writer := &statusCapturingWriter{ResponseWriter: rec, status: http.StatusOK}
	if writer.Unwrap() != rec {
		t.Fatal("status writer did not expose the underlying response writer")
	}
}

// session-replay-deeplink: AuditMetaFromRequest must surface the
// cookie-derived session id + the per-action counter the SPA sends in
// X-Postwave-Event-Seq so the audit_log row can be linked back to the
// browser session that produced it.
func TestAuditMetaFromRequest_SessionReplayFields(t *testing.T) {
	cases := []struct {
		name        string
		cookieValue string
		header      string
		wantSession string
		wantSeq     int64
	}{
		{
			name:        "happy path: cookie + valid seq",
			cookieValue: "sess-abc-123",
			header:      "42",
			wantSession: "sess-abc-123",
			wantSeq:     42,
		},
		{
			name:        "no cookie, no header",
			cookieValue: "",
			header:      "",
			wantSession: "",
			wantSeq:     0,
		},
		{
			name:        "header zero treated as unset (sentinel)",
			cookieValue: "sess-1",
			header:      "0",
			wantSession: "sess-1",
			wantSeq:     0,
		},
		{
			name:        "garbage header silently ignored",
			cookieValue: "sess-1",
			header:      "not-a-number",
			wantSession: "sess-1",
			wantSeq:     0,
		},
		{
			name:        "negative header silently ignored",
			cookieValue: "sess-1",
			header:      "-7",
			wantSession: "sess-1",
			wantSeq:     0,
		},
		{
			name:        "absurdly long cookie value dropped",
			cookieValue: strings.Repeat("a", 200),
			header:      "1",
			wantSession: "",
			wantSeq:     1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/v1/subscribers", nil)
			if tc.cookieValue != "" {
				r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: tc.cookieValue})
			}
			if tc.header != "" {
				r.Header.Set(EventSeqHeader, tc.header)
			}
			got := AuditMetaFromRequest(r)
			if got.SessionID != tc.wantSession {
				t.Errorf("SessionID = %q, want %q", got.SessionID, tc.wantSession)
			}
			if got.ClientEventSeq != tc.wantSeq {
				t.Errorf("ClientEventSeq = %d, want %d", got.ClientEventSeq, tc.wantSeq)
			}
		})
	}
}
