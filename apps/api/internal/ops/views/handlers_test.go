package views

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeLister struct {
	rows   []TenantRow
	err    error
	search string
	limit  int
	calls  int
}

func (f *fakeLister) ListTenants(_ context.Context, search string, limit int) ([]TenantRow, error) {
	f.search = search
	f.limit = limit
	f.calls++
	return f.rows, f.err
}

func TestTenantsHandler_ReturnsJSONArray(t *testing.T) {
	fake := &fakeLister{rows: []TenantRow{
		{TenantID: "t1", Name: "Acme", Tier: "pro", Health: HealthOK},
	}}
	h := TenantsHandler(fake)
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/views/tenants?search=%20Acme%20&limit=500", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body struct {
		Tenants []TenantRow `json:"tenants"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Tenants) != 1 || body.Tenants[0].TenantID != "t1" {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
	if fake.search != "Acme" || fake.limit != 500 {
		t.Fatalf("ListTenants args = (%q, %d), want (Acme, 500)", fake.search, fake.limit)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

// A failed read must be a loud 500, never an empty 200 — an empty ops surface
// reads as "zero tenants" (the falsely-green bug the console exists to prevent).
func TestTenantsHandler_ErrorIs500NotEmpty(t *testing.T) {
	h := TenantsHandler(&fakeLister{err: context.DeadlineExceeded})
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/views/tenants", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want JSON", got)
	}
}

func TestTenantsHandler_RejectsInvalidSearchBeforeReading(t *testing.T) {
	tests := map[string]string{
		"too long":        strings.Repeat("x", maxTenantSearchRunes+1),
		"multibyte bytes": strings.Repeat("界", 43),
		"escaped bytes":   strings.Repeat("%", 65),
		"newline control": "Acme\nOther",
		"null control":    "Acme\x00Other",
		"invalid UTF-8":   string([]byte{0xff}),
	}
	for name, search := range tests {
		t.Run(name, func(t *testing.T) {
			fake := &fakeLister{}
			h := TenantsHandler(fake)
			r := httptest.NewRequest("GET", "/views/tenants", nil)
			query := r.URL.Query()
			query.Set("search", search)
			r.URL.RawQuery = query.Encode()
			w := httptest.NewRecorder()

			h(w, r)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", w.Code)
			}
			if fake.calls != 0 {
				t.Fatalf("ListTenants calls = %d, want 0", fake.calls)
			}
			if got := w.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
				t.Fatalf("Content-Type = %q, want JSON", got)
			}
		})
	}
}
