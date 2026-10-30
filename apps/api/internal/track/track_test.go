package track

// Track-handler tests. The Repo methods need postgres so we cover the
// HTTP-level branches that gate the DB call: tenant required, JSON
// validity, missing event_name, missing subscriber identity.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestTrack_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/track",
		strings.NewReader(`{"event_name":"opened","email":"a@b.co"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Track(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestTrack_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/track", strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Track(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestTrack_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"event_name":"opened","email":"a@b.co","properties":{"blob":"` +
		strings.Repeat("x", int(trackJSONMaxBodyBytes)) + `"}}`
	r := httptest.NewRequest("POST", "/api/v1/track", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Track(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
}

func TestTrack_RejectsMissingEventName(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/track",
		strings.NewReader(`{"email":"a@b.co"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Track(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "missing_event_name") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestTrack_RejectsMissingSubscriber(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/track",
		strings.NewReader(`{"event_name":"opened"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Track(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "missing_subscriber") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestListEvents_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/track/events?subscriber_id=x", nil)
	w := httptest.NewRecorder()
	d.ListEvents(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestListEvents_RejectsBadBeforeCursor(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/track/events?before=not-a-date", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.ListEvents(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_before") {
		t.Errorf("body = %q", w.Body.String())
	}
}

// TestAtoiDefault — the local int parser. Defaults on empty/non-digit/zero.
func TestAtoiDefault(t *testing.T) {
	cases := []struct {
		in   string
		def  int
		want int
	}{
		{"", 50, 50},
		{"100", 50, 100},
		{"abc", 50, 50},
		{"0", 50, 50},
		{"7", 50, 7},
	}
	for _, c := range cases {
		if got := atoiDefault(c.in, c.def); got != c.want {
			t.Errorf("atoiDefault(%q,%d) = %d, want %d", c.in, c.def, got, c.want)
		}
	}
}
