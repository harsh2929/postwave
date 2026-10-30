package lists

// Lists is a thin Listmonk passthrough — the gateway forwards JSON
// payloads. Most of the substantive logic lives in Listmonk itself;
// the bits we own (tenant gate, body validation, default field fill)
// are what's exercised here.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const testPostwaveListUUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

func enableTestListIdentity(d *Deps) {
	d.ensureListIdentity = func(_ context.Context, _, _ string, _ int64) (string, error) {
		return testPostwaveListUUID, nil
	}
}

// withListIDParam injects the chi {id} URL param so Update / Delete
// can be exercised without standing up the real router.
func withListIDParam(r *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// TestList_RejectsMissingTenant — every endpoint must 401 without a
// tenant in the request context.
func TestList_RejectsMissingTenant(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("GET", "/api/v1/lists", nil)
	w := httptest.NewRecorder()
	d.List(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestCreate_RejectsBadJSON — malformed body before any upstream call.
func TestCreate_RejectsBadJSON(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("POST", "/api/v1/lists", strings.NewReader("not json"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_json") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestCreate_RejectsOversizedBody(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("POST", "/api/v1/lists",
		strings.NewReader(`{"name":"`+strings.Repeat("x", int(listJSONMaxBodyBytes))+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
	if !strings.Contains(w.Body.String(), "payload_too_large") {
		t.Errorf("body = %q, want payload_too_large", w.Body.String())
	}
}

// TestCreate_RejectsMissingName — a name-less body must 400.
func TestCreate_RejectsMissingName(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("POST", "/api/v1/lists", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "missing_name") {
		t.Errorf("body = %q, want missing_name", w.Body.String())
	}
}

// TestCreate_ProxiesAndDefaults — a valid body is forwarded to the
// upstream Listmonk URL with the default `type=private` and
// `optin=single` filled in. We stand up a recording test server in
// place of Listmonk and assert what the gateway forwarded.
func TestCreate_ProxiesAndDefaults(t *testing.T) {
	var got string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		got = string(buf)
		_, _ = w.Write([]byte(`{"data":{"id":42}}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	enableTestListIdentity(d)
	r := httptest.NewRequest("POST", "/api/v1/lists",
		strings.NewReader(`{"name":"Newsletter"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(got, `"type":"private"`) {
		t.Errorf("upstream body = %q, want default type=private", got)
	}
	if !strings.Contains(got, `"optin":"single"`) {
		t.Errorf("upstream body = %q, want default optin=single", got)
	}
	if !strings.Contains(w.Body.String(), `"postwave_uuid":"`+testPostwaveListUUID+`"`) {
		t.Errorf("response body = %q, want exact Moosewave identity", w.Body.String())
	}
	if w.Header().Get("X-Postwave-List-UUID") != testPostwaveListUUID {
		t.Errorf("identity header = %q", w.Header().Get("X-Postwave-List-UUID"))
	}
}

// TestCreateForAgent_ProxiesDefaultsAndParses is the request-less twin of
// TestCreate_ProxiesAndDefaults: it asserts the agent path applies the same
// defaults, forwards over the single Listmonk hop, and parses the created
// list out of the {"data":{...}} envelope.
func TestCreateForAgent_ProxiesDefaultsAndParses(t *testing.T) {
	var got string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		got = string(buf)
		_, _ = w.Write([]byte(`{"data":{"id":42,"name":"Newsletter","type":"private","optin":"single"}}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	enableTestListIdentity(d)
	out, err := d.CreateForAgent(context.Background(), "t1", CreateListInput{Name: "Newsletter"})
	if err != nil {
		t.Fatalf("CreateForAgent: %v", err)
	}
	if !strings.Contains(got, `"type":"private"`) || !strings.Contains(got, `"optin":"single"`) {
		t.Errorf("upstream body = %q, want defaults type=private optin=single", got)
	}
	if out == nil || out.ID != 42 || out.PostwaveUUID != testPostwaveListUUID || out.Name != "Newsletter" {
		t.Fatalf("parsed list = %+v, want exact engine + Moosewave identity", out)
	}
}

// A Listmonk 4xx (e.g. duplicate name) surfaces its message; transport stays
// hidden behind a generic error, and an empty tenant / name is rejected
// before any hop.
func TestCreateForAgent_Errors(t *testing.T) {
	if _, err := (New("http://upstream.invalid", "u", "p")).CreateForAgent(context.Background(), "", CreateListInput{Name: "x"}); err == nil {
		t.Error("expected error for empty tenant")
	}
	if _, err := (New("http://upstream.invalid", "u", "p")).CreateForAgent(context.Background(), "t1", CreateListInput{Name: "  "}); err == nil {
		t.Error("expected error for blank name")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"The list already exists."}`))
	}))
	defer upstream.Close()
	d := New(upstream.URL, "u", "p")
	enableTestListIdentity(d)
	_, err := d.CreateForAgent(context.Background(), "t1", CreateListInput{Name: "dup"})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("want surfaced listmonk message, got %v", err)
	}
}

func TestCreate_FailsClosedBeforeUpstreamWhenIdentityRepoUnavailable(t *testing.T) {
	upstreamCalled := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalled = true
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"data":{"id":42}}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists", strings.NewReader(`{"name":"Newsletter"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)

	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "repo_unavailable") {
		t.Fatalf("status=%d body=%q, want fail-closed 503", w.Code, w.Body.String())
	}
	if upstreamCalled {
		t.Fatal("upstream create must not run without identity persistence")
	}
}

func TestCreate_CompensatesUpstreamWhenIdentityCommitFails(t *testing.T) {
	deleteCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"data":{"id":42,"name":"Newsletter"}}`))
		case http.MethodDelete:
			deleteCalls++
			if r.URL.Path != "/api/lists/42" {
				t.Errorf("compensation path=%q", r.URL.Path)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected upstream method %s", r.Method)
		}
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	d.ensureListIdentity = func(_ context.Context, _, _ string, _ int64) (string, error) {
		return "", errors.New("database unavailable")
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists", strings.NewReader(`{"name":"Newsletter"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)

	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "list_identity_persistence_failed") {
		t.Fatalf("status=%d body=%q, want compensated 503", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"recovery_required":false`) || deleteCalls != 1 {
		t.Fatalf("body=%q delete_calls=%d", w.Body.String(), deleteCalls)
	}
	if w.Header().Get("Retry-After") != "1" {
		t.Errorf("Retry-After=%q, want 1", w.Header().Get("Retry-After"))
	}
}

func TestCreate_ReturnsRecoveryIdentityWhenCompensationFails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"data":{"id":77,"name":"Newsletter"}}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	d.ensureListIdentity = func(_ context.Context, _, _ string, _ int64) (string, error) {
		return "", errors.New("database unavailable")
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists", strings.NewReader(`{"name":"Newsletter"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)

	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "list_identity_recovery_required") {
		t.Fatalf("status=%d body=%q, want recovery-required 409", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"engine_id":77`) ||
		!strings.Contains(w.Body.String(), `"mapping_state":"not_committed"`) ||
		!strings.Contains(w.Body.String(), `"recovery_required":true`) ||
		!strings.Contains(w.Body.String(), `"postwave_uuid":"`) {
		t.Fatalf("missing exact recovery evidence: %q", w.Body.String())
	}
}

func TestCreate_DoesNotCompensateAnUncertainDatabaseCommit(t *testing.T) {
	deleteCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"data":{"id":79,"name":"Newsletter"}}`))
			return
		}
		deleteCalls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	d.ensureListIdentity = func(_ context.Context, _, _ string, _ int64) (string, error) {
		return testPostwaveListUUID, fmt.Errorf("%w: verification unavailable", ErrListIdentityCommitUncertain)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists", strings.NewReader(`{"name":"Newsletter"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)

	if w.Code != http.StatusConflict || deleteCalls != 0 {
		t.Fatalf("status=%d delete_calls=%d body=%q", w.Code, deleteCalls, w.Body.String())
	}
	for _, want := range []string{
		`"postwave_uuid":"` + testPostwaveListUUID + `"`,
		`"mapping_state":"unknown"`,
		`"recovery_required":true`,
		`"compensation_attempted":false`,
	} {
		if !strings.Contains(w.Body.String(), want) {
			t.Errorf("body=%q, want %s", w.Body.String(), want)
		}
	}
}

func TestCreateForAgent_ReturnsTypedIdentityRecoveryError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"data":{"id":88,"name":"Newsletter"}}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	d.ensureListIdentity = func(_ context.Context, _, _ string, _ int64) (string, error) {
		return "", errors.New("database unavailable")
	}
	_, err := d.CreateForAgent(context.Background(), "t1", CreateListInput{Name: "Newsletter"})
	var identityErr *ListIdentityCreateError
	if !errors.As(err, &identityErr) {
		t.Fatalf("error=%v, want ListIdentityCreateError", err)
	}
	if identityErr.EngineID != 88 || !identityErr.RecoveryRequired || identityErr.PostwaveUUID == "" {
		t.Fatalf("identity error=%+v", identityErr)
	}
}

func TestCreate_RejectsUnverifiableSuccessfulUpstreamResponse(t *testing.T) {
	identityCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"name":"missing id"}}`))
	}))
	defer upstream.Close()
	d := New(upstream.URL, "u", "p")
	d.ensureListIdentity = func(_ context.Context, _, _ string, _ int64) (string, error) {
		identityCalls++
		return testPostwaveListUUID, nil
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/lists", strings.NewReader(`{"name":"Newsletter"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "list_identity_unverifiable") {
		t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
	}
	if identityCalls != 0 {
		t.Fatalf("identity writer called %d times without an engine id", identityCalls)
	}
}

func TestCreateForAgent_ReturnsTypedUnverifiableIdentityError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"name":"missing id"}}`))
	}))
	defer upstream.Close()
	d := New(upstream.URL, "u", "p")
	enableTestListIdentity(d)
	_, err := d.CreateForAgent(context.Background(), "t1", CreateListInput{Name: "Newsletter"})
	var identityErr *ListIdentityCreateError
	if !errors.As(err, &identityErr) {
		t.Fatalf("error=%v, want ListIdentityCreateError", err)
	}
	if identityErr.MappingState != "unverifiable" || !identityErr.RecoveryRequired || identityErr.EngineID != 0 {
		t.Fatalf("identity error=%+v", identityErr)
	}
}

// TestDelete_RejectsBadID — non-integer id rejected before upstream.
func TestDelete_RejectsBadID(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("DELETE", "/api/v1/lists/abc", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	// chi.URLParam pulls from chi context; without it the helper returns
	// "" which strconv.ParseInt rejects as a separate failure mode.
	// Either way the handler must 400 — that's what we assert.
	w := httptest.NewRecorder()
	d.Delete(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// TestListFailsClosedWithoutTheIdentityRepository — the catalogue is
// Listmonk's rows attributed to this tenant; without the identity repository
// nothing can be attributed, so the engine is not even asked. Returning its
// rows undecorated is how every list came to read "Not mapped".
// Query forwarding, pagination and decoration are exercised against a
// migrated database in catalogue_identity_db_test.go.
func TestListFailsClosedWithoutTheIdentityRepository(t *testing.T) {
	upstreamCalled := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalled = true
		_, _ = w.Write([]byte(`{"data":{"results":[]}}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	r := httptest.NewRequest("GET", "/api/v1/lists?q=alpha", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.List(w, r)

	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "repo_unavailable") {
		t.Fatalf("status = %d body = %s, want 503 repo_unavailable", w.Code, w.Body.String())
	}
	if upstreamCalled {
		t.Fatal("the engine was called for a catalogue that could not be attributed")
	}
}

func TestCatalogueUpstreamPathRequestsTheWholeCatalogue(t *testing.T) {
	cases := map[string]string{
		"":          "/api/lists?per_page=all",
		"alpha":     "/api/lists?per_page=all&query=alpha",
		"digest 12": "/api/lists?per_page=all&query=digest+12",
	}
	for query, want := range cases {
		if got := catalogueUpstreamPath(query); got != want {
			t.Errorf("catalogueUpstreamPath(%q) = %q, want %q", query, got, want)
		}
	}
}

// TestUpdateFailsClosedWithoutTheIdentityRepository — a rename goes to the
// process-global engine, so it must first be proven to be this tenant's list.
// Proxying and ownership are exercised in catalogue_identity_db_test.go.
func TestUpdateFailsClosedWithoutTheIdentityRepository(t *testing.T) {
	upstreamCalled := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalled = true
		_, _ = w.Write([]byte(`{"data":{"id":7,"name":"Renamed"}}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	r := httptest.NewRequest("PATCH", "/api/v1/lists/7",
		strings.NewReader(`{"name":"Renamed","type":"public","optin":"double"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	r = withListIDParam(r, "7")
	w := httptest.NewRecorder()
	d.Update(w, r)

	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "repo_unavailable") {
		t.Fatalf("status = %d body = %s, want 503 repo_unavailable", w.Code, w.Body.String())
	}
	if upstreamCalled {
		t.Fatal("an unattributed rename reached the engine")
	}
}

// TestUpdate_RejectsUnknownField — a payload with a field outside
// the whitelist must 400 with `unknown_field` rather than silently
// drop the value or echo a confusing 422 from Listmonk. Catches the
// classic `{"Name":"x"}` capitalization typo before it reaches the
// upstream.
func TestUpdate_RejectsUnknownField(t *testing.T) {
	upstreamCalled := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalled = true
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	d := New(upstream.URL, "u", "p")
	r := httptest.NewRequest("PATCH", "/api/v1/lists/7",
		strings.NewReader(`{"name":"ok","subscriber_count":99}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	r = withListIDParam(r, "7")
	w := httptest.NewRecorder()
	d.Update(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s, want 400", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "unknown_field") {
		t.Errorf("body = %q, want unknown_field", w.Body.String())
	}
	if upstreamCalled {
		t.Error("upstream should not be called when validation fails")
	}
}

// TestUpdate_RejectsMissingTenant — no tenant in context => 401.
func TestUpdate_RejectsMissingTenant(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("PATCH", "/api/v1/lists/7",
		strings.NewReader(`{"name":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	r = withListIDParam(r, "7")
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestUpdate_RejectsBadID — non-integer id => 400 before any
// upstream call (matches Delete's contract).
func TestUpdate_RejectsBadID(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("PATCH", "/api/v1/lists/abc",
		strings.NewReader(`{"name":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	r = withListIDParam(r, "abc")
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_id") {
		t.Errorf("body = %q, want bad_id", w.Body.String())
	}
}

// TestUpdate_RejectsEmptyBody — an empty `{}` PATCH is a no-op the
// caller almost certainly didn't mean; fail closed with 400.
func TestUpdate_RejectsEmptyBody(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("PATCH", "/api/v1/lists/7",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	r = withListIDParam(r, "7")
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "empty_body") {
		t.Errorf("body = %q, want empty_body", w.Body.String())
	}
}

// TestUpdate_RejectsInvalidType — type must match Listmonk's enum
// (private|public|temporary); anything else 400s before upstream.
func TestUpdate_RejectsInvalidType(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	r := httptest.NewRequest("PATCH", "/api/v1/lists/7",
		strings.NewReader(`{"type":"hidden"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	r = withListIDParam(r, "7")
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_field") {
		t.Errorf("body = %q, want bad_field", w.Body.String())
	}
}

func TestListmonkProxyURLPreservesBasePathAndRejectsUnsafeInputs(t *testing.T) {
	got, err := listmonkProxyURL("https://listmonk.example.test/proxy/", "/api/lists?query=alpha")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://listmonk.example.test/proxy/api/lists?query=alpha" {
		t.Fatalf("url = %q", got)
	}

	for _, tc := range []struct {
		base string
		path string
	}{
		{base: "https://user:pass@listmonk.example.test", path: "/api/lists"},
		{base: "https://listmonk.example.test?token=x", path: "/api/lists"},
		{base: "https://listmonk.example.test#frag", path: "/api/lists"},
		{base: "file:///tmp/listmonk", path: "/api/lists"},
		{base: "https://listmonk.example.test", path: "/api/%2e%2e/lists"},
		{base: "https://listmonk.example.test", path: "/api\\lists"},
	} {
		if _, err := listmonkProxyURL(tc.base, tc.path); err == nil {
			t.Fatalf("base=%q path=%q should fail", tc.base, tc.path)
		}
	}
}
