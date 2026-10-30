package subscribers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsTruthy(t *testing.T) {
	for _, s := range []string{"1", "true", "TRUE", "yes", "on", " true "} {
		if !isTruthy(s) {
			t.Errorf("isTruthy(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "0", "false", "no", "off", "nope"} {
		if isTruthy(s) {
			t.Errorf("isTruthy(%q) = true, want false", s)
		}
	}
}

// Archive handler: missing tenant → 401 (no DB touched).
func TestArchive_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/subscribers/abc/archive", nil)
	rec := httptest.NewRecorder()
	d.Archive(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// Unarchive handler: missing tenant → 401.
func TestUnarchive_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/subscribers/abc/unarchive", nil)
	rec := httptest.NewRecorder()
	d.Unarchive(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestArchiveMutationsRequireExactIfMatchBeforeDatabase(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, tc := range []struct {
		name   string
		path   string
		call   func(http.ResponseWriter, *http.Request)
		header string
	}{
		{name: "archive missing", path: "/api/v1/subscribers/abc/archive", call: d.Archive},
		{name: "archive wildcard", path: "/api/v1/subscribers/abc/archive", call: d.Archive, header: "*"},
		{name: "unarchive missing", path: "/api/v1/subscribers/abc/unarchive", call: d.Unarchive},
		{name: "unarchive wildcard", path: "/api/v1/subscribers/abc/unarchive", call: d.Unarchive, header: "*"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := subscriberTenantRequest(http.MethodPatch, tc.path, "")
			if tc.header != "" {
				req.Header.Set("If-Match", tc.header)
			}
			rec := httptest.NewRecorder()
			tc.call(rec, req)
			if rec.Code != http.StatusPreconditionRequired {
				t.Fatalf("status = %d, want 428; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// GetRetentionPolicy handler: missing tenant → 401.
func TestGetRetentionPolicy_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/retention-policy", nil)
	rec := httptest.NewRecorder()
	d.GetRetentionPolicy(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// SetRetentionPolicy handler: negative values → 400 validation (no DB).
func TestSetRetentionPolicy_RejectsNegative(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.SetRetentionPolicy(rec, subscriberTenantRequest(http.MethodPut, "/api/v1/subscribers/retention-policy", `{"retention_days":-1}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// The default ListOptions must NOT include archived rows; an explicit
// opt-in flips it. This guards the soft-delete default-hiding contract
// at the option level (the SQL filter is gated on IncludeArchived).
func TestListOptions_DefaultExcludesArchived(t *testing.T) {
	var zero ListOptions
	if zero.IncludeArchived {
		t.Fatal("zero ListOptions must default IncludeArchived=false (hide archived)")
	}
}
