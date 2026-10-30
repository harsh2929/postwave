package lists

// Unit-level tests for the membership write handlers (§A1). As with
// members_test.go, the SQL paths (AddMembers / RemoveMember) are
// exercised by the integration suite against a real Postgres; here we
// cover the request-shape failure modes that need no backing pool.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newMembershipRouter(d *Deps) *chi.Mux {
	router := chi.NewRouter()
	router.Post("/api/v1/lists/{id}/subscribers", d.AddSubscribers)
	router.Delete("/api/v1/lists/{id}/subscribers/{sub_id}", d.RemoveSubscriber)
	return router
}

const testSubUUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

// TestAddSubscribers_RequiresTenant — 401 without a tenant in the
// context, same gate as every other handler in the package.
func TestAddSubscribers_RequiresTenant(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("POST", "/api/v1/lists/7/subscribers",
		strings.NewReader(`{"subscriber_ids":["`+testSubUUID+`"]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// TestAddSubscribers_RejectsBadJSON — body validation runs before the
// repo gate, so a malformed body 400s even with Repo unset.
func TestAddSubscribers_RejectsBadJSON(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("POST", "/api/v1/lists/7/subscribers", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_json") {
		t.Fatalf("body = %q, want bad_json", w.Body.String())
	}
}

// TestAddSubscribers_RejectsEmptyIDs — an empty / all-blank id set is
// a 400 missing_subscriber_ids, not a silent {"added":0}.
func TestAddSubscribers_RejectsEmptyIDs(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`{"subscriber_ids":[]}`,
		`{"subscriber_ids":["", "  "]}`,
	} {
		d := New("http://upstream.invalid", "u", "p")
		req := httptest.NewRequest("POST", "/api/v1/lists/7/subscribers", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		newMembershipRouter(d).ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d, want 400", body, w.Code)
		}
		if !strings.Contains(w.Body.String(), "missing_subscriber_ids") {
			t.Fatalf("body %q: response %q, want missing_subscriber_ids", body, w.Body.String())
		}
	}
}

// TestAddSubscribers_RejectsMalformedID — ids that are neither uuid-
// nor integer-shaped fail closed with 400 rather than being silently
// skipped.
func TestAddSubscribers_RejectsMalformedID(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("POST", "/api/v1/lists/7/subscribers",
		strings.NewReader(`{"subscriber_ids":["banana"]}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_subscriber_ids") {
		t.Fatalf("body = %q, want bad_subscriber_ids", w.Body.String())
	}
}

// TestAddSubscribers_RejectsOversizedBatch — the batch cap is enforced
// before any DB work.
func TestAddSubscribers_RejectsOversizedBatch(t *testing.T) {
	ids := make([]string, 0, maxMembershipBatch+1)
	for i := 0; i <= maxMembershipBatch; i++ {
		// Integer-shaped ids are valid input shapes, and distinct.
		ids = append(ids, `"1`+itoa(i)+`"`)
	}
	body := `{"subscriber_ids":[` + strings.Join(ids, ",") + `]}`
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("POST", "/api/v1/lists/7/subscribers", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "too_many_subscriber_ids") {
		t.Fatalf("body = %q, want too_many_subscriber_ids", w.Body.String())
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// TestAddSubscribers_RepoMissing — valid body but no Postgres sidecar
// wired: 503, matching the members read handler.
func TestAddSubscribers_RepoMissing(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("POST", "/api/v1/lists/7/subscribers",
		strings.NewReader(`{"subscriber_ids":["`+testSubUUID+`"]}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "repo_unavailable") {
		t.Fatalf("body = %q, want repo_unavailable", w.Body.String())
	}
}

// TestRemoveSubscriber_RequiresTenant — 401 gate.
func TestRemoveSubscriber_RequiresTenant(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("DELETE", "/api/v1/lists/7/subscribers/"+testSubUUID, nil)
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// TestRemoveSubscriber_RejectsMalformedSubID — garbage sub_id is 400;
// uuid and bigint shapes are the only accepted forms.
func TestRemoveSubscriber_RejectsMalformedSubID(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("DELETE", "/api/v1/lists/7/subscribers/banana", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_subscriber_id") {
		t.Fatalf("body = %q, want bad_subscriber_id", w.Body.String())
	}
}

// TestRemoveSubscriber_RepoMissing — 503 when the sidecar isn't wired.
func TestRemoveSubscriber_RepoMissing(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("DELETE", "/api/v1/lists/7/subscribers/"+testSubUUID, nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newMembershipRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

// TestClassifySubscriberIDs — uuid vs bigint vs junk classification,
// including dedup and whitespace handling.
func TestClassifySubscriberIDs(t *testing.T) {
	uuids, bigints, bad := classifySubscriberIDs([]string{
		testSubUUID,
		strings.ToUpper(testSubUUID), // dup of the above (case-insensitive)
		" " + testSubUUID + " ",      // dup again (trimmed)
		"42",
		"42", // dup bigint
		"7",
		"",
		"  ",
		"banana",
	})
	if len(uuids) != 1 || uuids[0] != testSubUUID {
		t.Errorf("uuids = %v, want [%s]", uuids, testSubUUID)
	}
	if bigints != 2 {
		t.Errorf("bigints = %d, want 2", bigints)
	}
	if len(bad) != 1 || bad[0] != "banana" {
		t.Errorf("bad = %v, want [banana]", bad)
	}
}
