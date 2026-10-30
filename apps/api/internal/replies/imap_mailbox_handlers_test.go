package replies

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The registry's HTTP surface (ASSURE#8). These cover the parts that must hold
// without a database: the mount contract, and the refusal to accept a credential
// where a reference belongs.

func TestMountMailboxAdminRoutesIsInertWithoutAStore(t *testing.T) {
	// A nil store must register nothing rather than mount routes that panic on the
	// first request. The poller half of this package already follows that rule.
	r := chi.NewRouter()
	MountMailboxAdminRoutes(r, nil)
	MountMailboxAdminRoutes(r, &MailboxAdminDeps{})

	mounted := 0
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted++
		return nil
	})
	if mounted != 0 {
		t.Fatalf("expected no routes with an unconfigured store, got %d", mounted)
	}
}

func TestMailboxAdminMountPublishesExactlyFiveTenantRoutes(t *testing.T) {
	r := chi.NewRouter()
	MountMailboxAdminRoutes(r, &MailboxAdminDeps{Store: &MailboxStore{Pool: &db.Pool{}}})

	got := make(map[string]bool)
	if err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"GET /api/v1/replies/mailboxes",
		"POST /api/v1/replies/mailboxes",
		"POST /api/v1/replies/mailboxes/{id}/enable",
		"POST /api/v1/replies/mailboxes/{id}/disable",
		"DELETE /api/v1/replies/mailboxes/{id}",
	}
	if len(got) != len(want) {
		t.Fatalf("mounted %d mailbox routes, want %d: %#v", len(got), len(want), got)
	}
	for _, route := range want {
		if !got[route] {
			t.Errorf("missing %s", route)
		}
	}
}

const mailboxHandlerTenantID = "92de77ea-6444-4e4a-9840-291731c3d345"

func tenantMailboxRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/replies/mailboxes", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: mailboxHandlerTenantID}))
}

func TestTenantSecretReferencesAreConfinedToTheTenantNamespace(t *testing.T) {
	valid, err := TenantEnvironmentSecretReference(mailboxHandlerTenantID, "SUPPORT_USERNAME")
	if err != nil {
		t.Fatal(err)
	}
	if !ValidTenantSecretReference(mailboxHandlerTenantID, valid) {
		t.Fatalf("generated tenant reference %q was rejected", valid)
	}
	for _, ref := range []string{
		"env:DATABASE_URL",
		"env:GEMINI_API_KEY",
		"env:POSTWAVE_REPLY_IMAP_TENANT_00000000000000000000000000000000_SUPPORT_USERNAME",
		"aws-sm:prod/imap/user",
		"hunter2",
	} {
		if ValidTenantSecretReference(mailboxHandlerTenantID, ref) {
			t.Errorf("tenant was allowed to select %q", ref)
		}
	}
}

func TestCreateRejectsArbitraryProcessEnvironmentSecret(t *testing.T) {
	passwordRef, err := TenantEnvironmentSecretReference(mailboxHandlerTenantID, "SUPPORT_PASSWORD")
	if err != nil {
		t.Fatal(err)
	}
	req := tenantMailboxRequest(t, `{"label":"Support","host":"imap.gmail.com",`+
		`"username_secret_ref":"env:DATABASE_URL","password_secret_ref":"`+passwordRef+`"}`)
	rec := httptest.NewRecorder()

	(&MailboxAdminDeps{}).Create(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for env:DATABASE_URL, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_secret_ref") {
		t.Fatalf("response did not identify an invalid reference: %s", rec.Body.String())
	}
}

func TestCreateRejectsPrivateOrPlaintextIMAPEndpointBeforeStorage(t *testing.T) {
	usernameRef, err := TenantEnvironmentSecretReference(mailboxHandlerTenantID, "SUPPORT_USERNAME")
	if err != nil {
		t.Fatal(err)
	}
	passwordRef, err := TenantEnvironmentSecretReference(mailboxHandlerTenantID, "SUPPORT_PASSWORD")
	if err != nil {
		t.Fatal(err)
	}
	for name, endpoint := range map[string]string{
		"AWS metadata":   `"host":"169.254.169.254"`,
		"loopback":       `"host":"127.0.0.1"`,
		"private IPv6":   `"host":"fd00::1"`,
		"plaintext":      `"host":"imap.gmail.com","use_tls":false`,
		"arbitrary port": `"host":"imap.gmail.com","port":143`,
	} {
		t.Run(name, func(t *testing.T) {
			body := `{"label":"Support",` + endpoint + `,"username_secret_ref":"` +
				usernameRef + `","password_secret_ref":"` + passwordRef + `"}`
			rec := httptest.NewRecorder()
			(&MailboxAdminDeps{}).Create(rec, tenantMailboxRequest(t, body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCreateRejectsACredentialInPlaceOfAReference(t *testing.T) {
	// The point is WHERE this is rejected. Letting the database enforce it means
	// the password reaches a constraint-violation error path; rejecting it here
	// means it never leaves the request body.
	deps := &MailboxAdminDeps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/replies/mailboxes",
		strings.NewReader(`{"label":"Support","host":"imap.example.com",`+
			`"username_secret_ref":"support@example.com","password_secret_ref":"hunter2"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	// No tenant in context, so this stops at the auth guard rather than the
	// validation — which is itself the contract: an unauthenticated caller learns
	// nothing about the body.
	deps.Create(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a tenant, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatal("the response echoed the supplied credential")
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestMailboxHandlersApplyNoStoreToEveryEarlyOutcome(t *testing.T) {
	deps := &MailboxAdminDeps{}
	tests := []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		req  *http.Request
	}{
		{name: "list", call: deps.List, req: httptest.NewRequest(http.MethodGet, "/api/v1/replies/mailboxes", nil)},
		{name: "create", call: deps.Create, req: httptest.NewRequest(http.MethodPost, "/api/v1/replies/mailboxes", nil)},
		{name: "enable", call: deps.Enable, req: httptest.NewRequest(http.MethodPost, "/api/v1/replies/mailboxes/not-a-uuid/enable", nil)},
		{name: "disable", call: deps.Disable, req: httptest.NewRequest(http.MethodPost, "/api/v1/replies/mailboxes/not-a-uuid/disable", nil)},
		{name: "delete", call: deps.Delete, req: httptest.NewRequest(http.MethodDelete, "/api/v1/replies/mailboxes/not-a-uuid", nil)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tt.call(rec, tt.req)
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
		})
	}
}

func TestMailboxActionsRejectMalformedIDsBeforeStorage(t *testing.T) {
	deps := &MailboxAdminDeps{}
	for _, action := range []struct {
		method string
		path   string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{http.MethodPost, "/api/v1/replies/mailboxes/not-a-uuid/enable", deps.Enable},
		{http.MethodPost, "/api/v1/replies/mailboxes/not-a-uuid/disable", deps.Disable},
		{http.MethodDelete, "/api/v1/replies/mailboxes/not-a-uuid", deps.Delete},
	} {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "not-a-uuid")
		req := httptest.NewRequest(action.method, action.path, nil)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: mailboxHandlerTenantID}))
		rec := httptest.NewRecorder()
		action.call(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_mailbox_id") {
			t.Fatalf("%s: got %d %s", action.path, rec.Code, rec.Body.String())
		}
	}
}
