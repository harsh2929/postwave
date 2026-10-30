// mirror_clients_test.go — desktop audit A6. The provider HTTP is
// faked with httptest.Server via the clients' BaseURL override;
// credentials come from StaticMirrorCredentials so no DB is needed.

package suppressions

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type fakeMirrorSecretResolver struct {
	values map[string]string
	err    error
	refs   []string
}

func (f *fakeMirrorSecretResolver) Get(_ context.Context, ref string) (string, error) {
	f.refs = append(f.refs, ref)
	if f.err != nil {
		return "", f.err
	}
	value, ok := f.values[ref]
	if !ok {
		return "", pwsecrets.ErrNotFound
	}
	return value, nil
}

// withChiParam injects a chi URL param so handlers can be exercised
// without a full router.
func withChiParam(r *http.Request, key, val string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, val)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestDBEnvMirrorCredentialsResolvesVaultReferenceBeforeLegacyAndEnv(t *testing.T) {
	t.Setenv(mirrorEnvKey(MirrorProviderSendGrid), "env-key")
	secrets := &fakeMirrorSecretResolver{values: map[string]string{
		"tenants/tenant-1/deliverability/sendgrid": `{"api_key":"vault-key"}`,
	}}
	credentials := &DBEnvMirrorCredentials{
		Secrets: secrets,
		lookup: func(_ context.Context, tenantID string, provider MirrorProvider) (string, string, error) {
			if tenantID != "tenant-1" || provider != MirrorProviderSendGrid {
				t.Fatalf("unexpected lookup: tenant=%q provider=%q", tenantID, provider)
			}
			return "deliverability/sendgrid", "legacy-key", nil
		},
	}

	got, err := credentials.APIKey(context.Background(), "tenant-1", MirrorProviderSendGrid)
	if err != nil {
		t.Fatalf("APIKey: %v", err)
	}
	if got != "vault-key" {
		t.Fatalf("APIKey = %q, want vault key", got)
	}
	if len(secrets.refs) != 1 || secrets.refs[0] != "tenants/tenant-1/deliverability/sendgrid" {
		t.Fatalf("resolved refs = %#v", secrets.refs)
	}
}

func TestTenantBoundMirrorSecretNameRejectsCrossTenantReference(t *testing.T) {
	got, err := tenantBoundMirrorSecretName("tenant-1", "deliverability/sendgrid")
	if err != nil || got != "tenants/tenant-1/deliverability/sendgrid" {
		t.Fatalf("relative reference = %q, %v", got, err)
	}
	got, err = tenantBoundMirrorSecretName("tenant-1", "tenants/tenant-1/deliverability/sendgrid")
	if err != nil || got != "tenants/tenant-1/deliverability/sendgrid" {
		t.Fatalf("own absolute reference = %q, %v", got, err)
	}
	if _, err := tenantBoundMirrorSecretName("tenant-1", "tenants/tenant-2/deliverability/sendgrid"); err == nil {
		t.Fatal("expected cross-tenant credential reference rejection")
	}
}

func TestDBEnvMirrorCredentialsLegacyAndEnvironmentCompatibility(t *testing.T) {
	t.Run("legacy tenant key", func(t *testing.T) {
		credentials := &DBEnvMirrorCredentials{
			lookup: func(context.Context, string, MirrorProvider) (string, string, error) {
				return "", "legacy-key", nil
			},
		}
		got, err := credentials.APIKey(context.Background(), "tenant-1", MirrorProviderSendGrid)
		if err != nil || got != "legacy-key" {
			t.Fatalf("APIKey = %q, %v", got, err)
		}
	})

	t.Run("environment", func(t *testing.T) {
		t.Setenv(mirrorEnvKey(MirrorProviderSendGrid), "env-key")
		credentials := &DBEnvMirrorCredentials{
			lookup: func(context.Context, string, MirrorProvider) (string, string, error) {
				return "", "", nil
			},
		}
		got, err := credentials.APIKey(context.Background(), "tenant-1", MirrorProviderSendGrid)
		if err != nil || got != "env-key" {
			t.Fatalf("APIKey = %q, %v", got, err)
		}
	})
}

func TestDBEnvMirrorCredentialsRejectsMissingOrMalformedVaultSecret(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values map[string]string
	}{
		{name: "missing", values: map[string]string{}},
		{name: "malformed JSON", values: map[string]string{"ref": `{bad`}},
		{name: "missing key field", values: map[string]string{"ref": `{"username":"postwave"}`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credentials := &DBEnvMirrorCredentials{
				Secrets: &fakeMirrorSecretResolver{values: tc.values},
				lookup: func(context.Context, string, MirrorProvider) (string, string, error) {
					return "ref", "", nil
				},
			}
			_, err := credentials.APIKey(context.Background(), "tenant-1", MirrorProviderSendGrid)
			if !errors.Is(err, ErrMirrorNotConfigured) {
				t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
			}
		})
	}
}

func TestMirrorAPIKeyFromSecretAcceptsRawAndKnownJSONShapes(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want string
	}{
		{raw: "SG.raw-key", want: "SG.raw-key"},
		{raw: `{"api_key":"mc-key-us21"}`, want: "mc-key-us21"},
		{raw: `{"token":"SG.token"}`, want: "SG.token"},
	} {
		got, err := mirrorAPIKeyFromSecret(tc.raw)
		if err != nil || got != tc.want {
			t.Fatalf("mirrorAPIKeyFromSecret(%q) = %q, %v", tc.raw, got, err)
		}
	}
}

/* ---------- SendGrid ---------------------------------------------- */

// TestSendGridMirrorClient_FetchRecent walks all three SendGrid
// suppression lists and checks reason mapping, stable source-event
// ids, and bearer auth.
func TestSendGridMirrorClient_FetchRecent(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Query().Get("start_time") == "" {
			t.Errorf("missing start_time on %s", r.URL.Path)
		}
		switch r.URL.Path {
		case "/v3/suppression/bounces":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"created": 1750000000, "email": "Bounce@Example.com", "reason": "550 user unknown", "status": "5.1.1"},
			})
		case "/v3/suppression/spam_reports":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"created": 1750000001, "email": "spam@example.com"},
			})
		case "/v3/suppression/unsubscribes":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"created": 1750000002, "email": "unsub@example.com"},
			})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := &SendGridMirrorClient{
		Credentials: StaticMirrorCredentials{Key: "SG.test-key"},
		BaseURL:     srv.URL,
	}
	recs, err := c.FetchRecent(context.Background(), "t1", time.Now().Add(-24*time.Hour), 100)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if gotAuth != "Bearer SG.test-key" {
		t.Errorf("auth = %q, want bearer key", gotAuth)
	}
	if len(recs) != 3 {
		t.Fatalf("len(recs) = %d, want 3", len(recs))
	}
	wantReasons := map[string]Reason{
		"Bounce@Example.com": ReasonHardBounce,
		"spam@example.com":   ReasonSpamComplaint,
		"unsub@example.com":  ReasonGlobalUnsubscribe,
	}
	for _, rec := range recs {
		if want := wantReasons[rec.Email]; rec.Reason != want {
			t.Errorf("reason for %s = %q, want %q", rec.Email, rec.Reason, want)
		}
		if rec.SourceEventID == "" || !strings.HasPrefix(rec.SourceEventID, "sendgrid:") {
			t.Errorf("source_event_id = %q, want sendgrid:-prefixed", rec.SourceEventID)
		}
	}
	// Idempotency: the bounce event id is keyed on the lowercased email.
	if got := recs[0].SourceEventID; got != "sendgrid:bounce:bounce@example.com" {
		t.Errorf("bounce source_event_id = %q", got)
	}
}

// TestSendGridMirrorClient_Paginates follows limit/offset until a
// short page and respects the overall record cap.
func TestSendGridMirrorClient_Paginates(t *testing.T) {
	pages := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/suppression/bounces" {
			_ = json.NewEncoder(w).Encode([]map[string]any{})
			return
		}
		pages++
		rows := make([]map[string]any, 0, mirrorPageSize)
		if pages == 1 { // one full page, then a short page
			for i := 0; i < mirrorPageSize; i++ {
				rows = append(rows, map[string]any{"created": 1, "email": "a@b.c"})
			}
		}
		_ = json.NewEncoder(w).Encode(rows)
	}))
	defer srv.Close()

	c := &SendGridMirrorClient{Credentials: StaticMirrorCredentials{Key: "k"}, BaseURL: srv.URL}
	recs, err := c.FetchRecent(context.Background(), "t1", time.Now(), mirrorPageSize+10)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if pages != 2 {
		t.Errorf("bounce pages fetched = %d, want 2", pages)
	}
	if len(recs) != mirrorPageSize {
		t.Errorf("len(recs) = %d, want %d", len(recs), mirrorPageSize)
	}
}

// TestSendGridMirrorClient_NotConfigured pins the typed error.
func TestSendGridMirrorClient_NotConfigured(t *testing.T) {
	c := NewSendGridMirrorClient(StaticMirrorCredentials{Key: ""})
	_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
	if !errors.Is(err, ErrMirrorNotConfigured) {
		t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
	}
}

// TestSendGridMirrorClient_RejectedKeyIsNotConfigured maps provider
// 401/403 onto the typed not-configured path so the dashboard prompts
// for a working credential instead of erroring.
func TestSendGridMirrorClient_RejectedKeyIsNotConfigured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := &SendGridMirrorClient{Credentials: StaticMirrorCredentials{Key: "bad"}, BaseURL: srv.URL}
	_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
	if !errors.Is(err, ErrMirrorNotConfigured) {
		t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
	}
}

/* ---------- Mailchimp --------------------------------------------- */

// TestMailchimpMirrorClient_FetchRecent fakes /lists plus both member
// statuses per list and checks basic auth + reason mapping.
func TestMailchimpMirrorClient_FetchRecent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || pass != "abc123-us21" {
			t.Errorf("basic auth = %q/%q ok=%v, want any-user + key", user, pass, ok)
		}
		switch {
		case r.URL.Path == "/lists":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"lists": []map[string]any{{"id": "l1"}}, "total_items": 1,
			})
		case r.URL.Path == "/lists/l1/members" && r.URL.Query().Get("status") == "unsubscribed":
			if r.URL.Query().Get("since_last_changed") == "" {
				t.Error("missing since_last_changed")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"members": []map[string]any{{
					"id": "m1", "email_address": "Out@Example.com",
					"status": "unsubscribed", "last_changed": "2026-06-01T00:00:00Z",
				}},
				"total_items": 1,
			})
		case r.URL.Path == "/lists/l1/members" && r.URL.Query().Get("status") == "cleaned":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"members": []map[string]any{{
					"id": "m2", "email_address": "gone@example.com",
					"status": "cleaned", "last_changed": "2026-06-02T00:00:00Z",
				}},
				"total_items": 1,
			})
		default:
			t.Errorf("unexpected request %s?%s", r.URL.Path, r.URL.RawQuery)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := &MailchimpMirrorClient{
		Credentials: StaticMirrorCredentials{Key: "abc123-us21"},
		BaseURL:     srv.URL,
	}
	recs, err := c.FetchRecent(context.Background(), "t1", time.Now().Add(-24*time.Hour), 100)
	if err != nil {
		t.Fatalf("FetchRecent: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("len(recs) = %d, want 2", len(recs))
	}
	byEmail := map[string]MirrorRecord{}
	for _, rec := range recs {
		byEmail[rec.Email] = rec
	}
	if got := byEmail["Out@Example.com"]; got.Reason != ReasonManualUnsubscribe ||
		got.SourceEventID != "mailchimp:l1:unsubscribed:m1" {
		t.Errorf("unsubscribed rec = %+v", got)
	}
	if got := byEmail["gone@example.com"]; got.Reason != ReasonHardBounce ||
		got.SourceEventID != "mailchimp:l1:cleaned:m2" {
		t.Errorf("cleaned rec = %+v", got)
	}
}

// TestMailchimpBaseURL pins dc derivation + the typed error on a key
// without a datacenter suffix.
func TestMailchimpBaseURL(t *testing.T) {
	got, err := mailchimpBaseURL("abc123-us21")
	if err != nil || got != "https://us21.api.mailchimp.com/3.0" {
		t.Errorf("mailchimpBaseURL = %q, %v", got, err)
	}
	for _, key := range []string{
		"no-suffix-",
		"nodc",
		"key-us0",
		"key-us0001",
		"key-US21",
		"key-us21.evil.example",
		"key-us21:8443",
		"key-us21@127.0.0.1",
		"key-us21%2eevil",
		"key-us２１",
		"key-us21/metadata",
		"key-us21.",
	} {
		if _, err := mailchimpBaseURL(key); !errors.Is(err, ErrMirrorNotConfigured) {
			t.Errorf("mailchimpBaseURL(%q) err = %v, want ErrMirrorNotConfigured", key, err)
		}
	}
}

// TestMailchimpMirrorClient_NotConfigured pins the typed error path.
func TestMailchimpMirrorClient_NotConfigured(t *testing.T) {
	c := NewMailchimpMirrorClient(StaticMirrorCredentials{Key: ""})
	_, err := c.FetchRecent(context.Background(), "t1", time.Now(), 10)
	if !errors.Is(err, ErrMirrorNotConfigured) {
		t.Fatalf("err = %v, want ErrMirrorNotConfigured", err)
	}
}

/* ---------- Mirror handler integration (typed 503s) --------------- */

// TestMirrorHandler_NotConfiguredClientYields503 wires a real client
// whose credential source is empty and asserts the handler converts
// the typed error into 503 + not_configured (NOT a 500).
func TestMirrorHandler_NotConfiguredClientYields503(t *testing.T) {
	h := &StoreHandlers{
		Store: &Store{Pool: nil},
		Mirrors: &MirrorClients{
			SendGrid: NewSendGridMirrorClient(StaticMirrorCredentials{Key: ""}),
		},
	}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/mirror/sendgrid", nil)
	r = withChiParam(r, "provider", "sendgrid")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.Mirror(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"not_configured":true`) {
		t.Errorf("body = %s, want not_configured:true", w.Body.String())
	}
}

// TestMirrorHandler_PlaceholderClientYields503 covers the
// NewNilMirrorClient placeholder (SES/Mailgun/Postmark wiring): its
// ErrMirrorClientUnavailable must also map to 503 not_configured.
func TestMirrorHandler_PlaceholderClientYields503(t *testing.T) {
	h := &StoreHandlers{
		Store:   &Store{Pool: nil},
		Mirrors: &MirrorClients{SES: NewNilMirrorClient(MirrorProviderSES)},
	}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/mirror/ses", nil)
	r = withChiParam(r, "provider", "ses")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.Mirror(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"not_configured":true`) {
		t.Errorf("body = %s, want not_configured:true", w.Body.String())
	}
}
