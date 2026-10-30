// SPDX-License-Identifier: AGPL-3.0-only
package feed_ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func tenantCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
}

func postJSON(t *testing.T, d *Deps, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/feed-sources", strings.NewReader(body)).
		WithContext(tenantCtx())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.CreateSource(rec, req)
	return rec
}

// Validation failures must reject before any repo call — Deps.Repo is
// non-nil but has a nil pool, so reaching the DB would panic/fail the
// test loudly.
func TestCreateSourceValidation(t *testing.T) {
	d := &Deps{Repo: &Repo{}, RequireHTTPS: true}

	cases := map[string]string{
		"missing name":      `{"url":"https://blog.example.com/rss.xml"}`,
		"missing url":       `{"name":"Blog"}`,
		"plaintext http":    `{"name":"Blog","url":"http://blog.example.com/rss.xml"}`,
		"bad scheme":        `{"name":"Blog","url":"ftp://blog.example.com/rss.xml"}`,
		"creds in url":      `{"name":"Blog","url":"https://user:pw@blog.example.com/rss.xml"}`,
		"bad schedule":      `{"name":"Blog","url":"https://b.example.com/rss.xml","schedule":"hourly"}`,
		"non-numeric list":  `{"name":"Blog","url":"https://b.example.com/rss.xml","list_id":"abc"}`,
		"non-uuid segment":  `{"name":"Blog","url":"https://b.example.com/rss.xml","segment_id":"nope"}`,
		"non-uuid template": `{"name":"Blog","url":"https://b.example.com/rss.xml","template_id":"nope"}`,
		"not json":          `{"name":`,
		"long name":         `{"name":"` + strings.Repeat("a", 201) + `","url":"https://b.example.com/rss.xml"}`,
	}
	for name, body := range cases {
		rec := postJSON(t, d, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (body %s)", name, rec.Code, rec.Body.String())
		}
	}
}

func TestCreateSourceAllowsHTTPInDev(t *testing.T) {
	in := CreateInput{Name: "Blog", URL: "http://blog.example.com/rss.xml"}
	if err := validateCreate(&in, false); err != nil {
		t.Fatalf("dev-mode http feed rejected: %v", err)
	}
	if in.Schedule != ScheduleManual {
		t.Errorf("schedule default = %q, want manual", in.Schedule)
	}
	if in.SubjectTemplate != "{{title}}" {
		t.Errorf("subject_template default = %q", in.SubjectTemplate)
	}
}

func TestHandlersRequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{}, Poller: &Poller{}}
	calls := []struct {
		name string
		do   func(rec *httptest.ResponseRecorder, req *http.Request)
	}{
		{"list", func(rec *httptest.ResponseRecorder, req *http.Request) { d.ListSources(rec, req) }},
		{"create", func(rec *httptest.ResponseRecorder, req *http.Request) { d.CreateSource(rec, req) }},
		{"get", func(rec *httptest.ResponseRecorder, req *http.Request) { d.GetSource(rec, req) }},
		{"update", func(rec *httptest.ResponseRecorder, req *http.Request) { d.UpdateSource(rec, req) }},
		{"delete", func(rec *httptest.ResponseRecorder, req *http.Request) { d.DeleteSource(rec, req) }},
		{"poll", func(rec *httptest.ResponseRecorder, req *http.Request) { d.PollSource(rec, req) }},
		{"runs", func(rec *httptest.ResponseRecorder, req *http.Request) { d.ListRuns(rec, req) }},
	}
	for _, c := range calls {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/feed-sources", nil)
		rec := httptest.NewRecorder()
		c.do(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without tenant: status = %d, want 401", c.name, rec.Code)
		}
	}
}

func TestPollSourceWithoutPoller(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/feed-sources/x/poll", nil).
		WithContext(tenantCtx())
	rec := httptest.NewRecorder()
	d.PollSource(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

// Malformed ids must 404 via the uuid pre-check, never reach the
// ::uuid cast (nil pool would otherwise be dialed).
func TestGetSourceBadIDIs404(t *testing.T) {
	r := &Repo{}
	if _, err := r.GetSource(context.Background(), "00000000-0000-0000-0000-000000000001", "not-a-uuid"); err != ErrNotFound {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
	if err := r.DeleteSource(context.Background(), "00000000-0000-0000-0000-000000000001", "not-a-uuid"); err != ErrNotFound {
		t.Errorf("delete err = %v, want ErrNotFound", err)
	}
}
