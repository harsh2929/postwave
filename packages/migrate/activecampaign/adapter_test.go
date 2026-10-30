// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestCapabilitiesReflectRuntimeAndPreservationBoundaries(t *testing.T) {
	caps := New().Capabilities()
	if caps.Source != canonical.SourceActiveCampaign {
		t.Fatalf("source = %s", caps.Source)
	}
	if caps.AuthMethod != "api_key" {
		t.Fatalf("auth method = %s", caps.AuthMethod)
	}
	if !caps.Supports.Subscribers || !caps.Supports.Segments || !caps.Supports.CampaignArchive {
		t.Fatalf("core ActiveCampaign migration capabilities are disabled: %+v", caps.Supports)
	}
	if !caps.Supports.Automations || caps.Supports.AutomationMode != "rebuild_review" {
		t.Fatalf("automation capability = automations:%v mode:%q, want rebuild_review", caps.Supports.Automations, caps.Supports.AutomationMode)
	}
	if caps.Supports.Templates {
		t.Fatal("ActiveCampaign should not advertise editable template import")
	}
	if caps.Supports.LandingPages {
		t.Fatal("ActiveCampaign should not advertise landing page import")
	}
	if !caps.Supports.Forms || !caps.Supports.CRM || !caps.Supports.CustomObjects || !caps.Supports.SMS {
		t.Fatalf("source-archive preservation capabilities are disabled: %+v", caps.Supports)
	}
}

func TestAuthenticateMissingAPITokenUsesOperatorWording(t *testing.T) {
	_, err := New().Authenticate(context.Background(), adapter.Credentials{
		AccountID: "https://example.api-us1.com/api/3",
	})
	if err == nil {
		t.Fatal("expected missing-token error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "missing API token") {
		t.Fatalf("error = %q, want API token wording", msg)
	}
	if strings.Contains(msg, "api_key") || strings.Contains(msg, "API key") {
		t.Fatalf("error = %q, should not expose generic API-key wording", msg)
	}
}

func TestAuthenticateMissingAccountAPIURLUsesOperatorWording(t *testing.T) {
	_, err := New().Authenticate(context.Background(), adapter.Credentials{
		APIKey: "secret",
	})
	if err == nil {
		t.Fatal("expected missing-account-url error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "ActiveCampaign account API URL required") {
		t.Fatalf("error = %q, want account API URL wording", msg)
	}
	if strings.Contains(msg, "api_url") {
		t.Fatalf("error = %q, should not expose internal api_url field name", msg)
	}
}

func TestAuthenticateNormalizesURLAndUsesAPIToken(t *testing.T) {
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("Api-Token")
		if r.URL.Path != "/api/3/users/me" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"user": map[string]any{"id": "1"}})
	}))
	defer srv.Close()

	ad := New()
	sess, err := ad.Authenticate(context.Background(), adapter.Credentials{
		APIKey:    "secret",
		AccountID: srv.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotToken != "secret" {
		t.Fatalf("Api-Token header = %q", gotToken)
	}
	if sess.Source != canonical.SourceActiveCampaign {
		t.Fatalf("source = %s", sess.Source)
	}
	if sess.Extra["api_url"] != srv.URL+"/api/3" {
		t.Fatalf("api_url = %q", sess.Extra["api_url"])
	}
	if AccountFingerprint(sess) == "" {
		t.Fatal("authenticated session is missing its account fingerprint")
	}
}

func TestAuthenticateAcceptsAPIURLCredentialAliases(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/users/me" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"user": map[string]any{"id": "1"}})
	}))
	defer srv.Close()

	cases := []struct {
		name  string
		extra map[string]string
	}{
		{name: "api_url", extra: map[string]string{"api_url": srv.URL + "/api/3"}},
		{name: "account_api_url", extra: map[string]string{"account_api_url": srv.URL}},
		{name: "account_url", extra: map[string]string{"account_url": srv.URL + "/"}},
		{name: "base_url", extra: map[string]string{"base_url": srv.URL}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sess, err := New().Authenticate(context.Background(), adapter.Credentials{
				APIKey: "secret",
				Extra:  tc.extra,
			})
			if err != nil {
				t.Fatal(err)
			}
			if sess.Extra["api_url"] != srv.URL+"/api/3" {
				t.Fatalf("api_url = %q", sess.Extra["api_url"])
			}
			if sess.AccountID == "" {
				t.Fatal("expected account id from API URL host")
			}
		})
	}
}

func TestAuthenticateFailsClosedWhenUsersMeHasNoUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]any{"contacts": []any{}})
	}))
	defer srv.Close()

	_, err := New().Authenticate(context.Background(), adapter.Credentials{
		APIKey:    "secret",
		AccountID: srv.URL,
	})
	if err == nil || !strings.Contains(err.Error(), "missing the authenticated user") {
		t.Fatalf("Authenticate error = %v", err)
	}
}

func TestNormalizeAPIURLRejectsUnsafeInputs(t *testing.T) {
	cases := []string{
		"https://user:pass@example.api-us1.com/api/3",
		"https://example.api-us1.com/api/3?token=secret",
		"https://example.api-us1.com/api/3#frag",
		"http://example.api-us1.com/api/3",
		"http://127.1:8080/api/3",
		"http://127.001.000.001:8080/api/3",
		"http://2130706433:8080/api/3",
		"ftp://example.api-us1.com/api/3",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if _, err := normalizeAPIURL(raw); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestNormalizeAPIURLAllowsLocalHTTPForTests(t *testing.T) {
	cases := map[string]string{
		"http://localhost:8080":       "http://localhost:8080/api/3",
		"http://127.0.0.1:8080/api/3": "http://127.0.0.1:8080/api/3",
		"http://[::1]:8080":           "http://[::1]:8080/api/3",
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			got, err := normalizeAPIURL(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		})
	}
}

func TestNormalizeAPIURLAddsHTTPSAndAPIPath(t *testing.T) {
	got, err := normalizeAPIURL("example.api-us1.com")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://example.api-us1.com/api/3" {
		t.Fatalf("got %q", got)
	}
}

func TestNormalizeAPIURLTrimsEndpointPathsAndRejectsAppPaths(t *testing.T) {
	cases := map[string]string{
		"https://example.api-us1.com/api/3/":          "https://example.api-us1.com/api/3",
		"https://example.api-us1.com/api/3/contacts":  "https://example.api-us1.com/api/3",
		"http://localhost:8080/api/3/contacts/123":    "http://localhost:8080/api/3",
		"https://example.api-us1.com/api/3/deals/42/": "https://example.api-us1.com/api/3",
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) {
			got, err := normalizeAPIURL(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		})
	}
	if _, err := normalizeAPIURL("https://example.activehosted.com/app/settings/developer"); err == nil {
		t.Fatal("expected app/admin path to be rejected")
	}
}

func TestDoMissingSessionAPIURLUsesOperatorWording(t *testing.T) {
	err := New().do(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
	}, http.MethodGet, "/contacts", nil, nil)
	if err == nil {
		t.Fatal("expected missing-account-url error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "missing account API URL") {
		t.Fatalf("error = %q, want account API URL wording", msg)
	}
	if strings.Contains(msg, "api_url") {
		t.Fatalf("error = %q, should not expose internal api_url field name", msg)
	}
}

func TestDoCapsErrorResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(strings.Repeat("x", int(maxErrorResponseBodyBytes)+1024)))
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL},
	}
	err := ad.do(context.Background(), sess, http.MethodGet, "/too-big", nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := strings.Count(err.Error(), "x"); got != int(maxErrorResponseBodyBytes) {
		t.Fatalf("error body x count = %d, want %d", got, maxErrorResponseBodyBytes)
	}
}

func TestListSubscribersEnrichesContactFieldsTagsAndLists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "Ada@Example.com", "firstName": "Ada", "lastName": "Lovelace", "phone": "+15551234567", "cdate": "2026-01-02T03:04:05Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "42", "email": "Ada@Example.com", "firstName": "Ada", "lastName": "Lovelace", "phone": "+15551234567", "cdate": "2026-01-02T03:04:05Z"},
				"contactLists": []any{map[string]any{
					"id": "9", "list": "7", "status": "1", "sdate": "2026-02-03T04:05:06Z",
					"sourceid": "signup-form-7", "sync": "manual", "automation": "welcome-series",
				}},
				"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "3", "created_timestamp": "2026-02-03T04:05:06Z"}},
				"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth", "updated_timestamp": "2026-02-04T04:05:06Z"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	subs, next, err := ad.ListSubscribers(context.Background(), sess, "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "" {
		t.Fatalf("next = %q", next)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d", len(subs))
	}
	sub := subs[0]
	if sub.Email != "ada@example.com" {
		t.Fatalf("email = %q", sub.Email)
	}
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want fail-closed until list-channel and exclusion evidence is loaded", sub.Status)
	}
	if sub.CustomFields["first_name"] != "Ada" || sub.CustomFields["name"] != "Ada Lovelace" || sub.CustomFields["plan"] != "Growth" || sub.CustomFields["phone"] != "+15551234567" {
		t.Fatalf("custom fields = %#v", sub.CustomFields)
	}
	assertContains(t, sub.Tags, "Customer")
	assertNotContains(t, sub.Tags, "list:7")
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, list subscription date is not opt-in proof", sub.ConsentTimestamp, sub.ConsentSource)
	}
	memberships := interfaceMapSliceField(t, sub, "activecampaign_list_memberships")
	if len(memberships) != 1 {
		t.Fatalf("memberships = %#v, want one row", memberships)
	}
	if sourceMapString(memberships[0], "sourceid") != "signup-form-7" ||
		sourceMapString(memberships[0], "source_id") != "signup-form-7" ||
		sourceMapString(memberships[0], "sync") != "manual" ||
		sourceMapString(memberships[0], "automation") != "welcome-series" {
		t.Fatalf("membership raw fields = %#v, want raw provider fields and normalized aliases", memberships[0])
	}
	contactTags := interfaceMapSliceField(t, sub, "activecampaign_contact_tags")
	if len(contactTags) != 1 ||
		sourceMapString(contactTags[0], "tag_id") != "3" ||
		sourceMapString(contactTags[0], "tag_name") != "Customer" ||
		sourceMapString(contactTags[0], "created_timestamp") != "2026-02-03T04:05:06Z" {
		t.Fatalf("contact tag evidence = %#v, want raw provider fields and normalized aliases", contactTags)
	}
	fieldValues := interfaceMapSliceField(t, sub, "activecampaign_field_values")
	if len(fieldValues) != 1 ||
		sourceMapString(fieldValues[0], "field_id") != "10" ||
		sourceMapString(fieldValues[0], "field_name") != "Plan" ||
		sourceMapString(fieldValues[0], "field_key") != "plan" ||
		sourceMapString(fieldValues[0], "updated_timestamp") != "2026-02-04T04:05:06Z" {
		t.Fatalf("field value evidence = %#v, want raw provider fields and normalized aliases", fieldValues)
	}
}

func TestListSubscribersFollowsActiveCampaignContactRelationshipLinks(t *testing.T) {
	seen := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen[r.URL.Path]++
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{
					"id":    "42",
					"email": "Ada@Example.com",
					"links": map[string]any{
						"contactLists": "/api/3/contacts/42/contactLists",
						"contactTags":  "/api/3/contacts/42/contactTags",
						"fieldValues":  "/api/3/contacts/42/fieldValues",
					},
				}},
				"meta": map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{
					"id":        "42",
					"firstName": "Ada",
					"lastName":  "Lovelace",
					"links": map[string]any{
						"contactLists": "/api/3/contacts/42/contactLists",
						"contactTags":  "/api/3/contacts/42/contactTags",
						"fieldValues":  "/api/3/contacts/42/fieldValues",
					},
				},
			})
		case "/api/3/contacts/42/contactLists":
			writeJSON(t, w, map[string]any{
				"contactLists": []any{map[string]any{"id": "9", "list": "7", "status": "1", "sdate": "2026-02-03T04:05:06Z"}},
			})
		case "/api/3/contacts/42/contactTags":
			writeJSON(t, w, map[string]any{
				"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "3"}},
			})
		case "/api/3/contacts/42/fieldValues":
			writeJSON(t, w, map[string]any{
				"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	subs, next, err := ad.ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "" || len(subs) != 1 {
		t.Fatalf("next=%q subs=%d", next, len(subs))
	}
	sub := subs[0]
	if sub.Email != "ada@example.com" || sub.CustomFields["plan"] != "Growth" {
		t.Fatalf("subscriber did not merge linked fields: %#v", sub)
	}
	assertContains(t, sub.Tags, "Customer")
	assertNotContains(t, sub.Tags, "list:7")
	if sub.CustomFields["name"] != "Ada Lovelace" {
		t.Fatalf("name = %#v", sub.CustomFields["name"])
	}
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, list subscription date is not opt-in proof", sub.ConsentTimestamp, sub.ConsentSource)
	}
	for _, path := range []string{
		"/api/3/contacts/42/contactLists",
		"/api/3/contacts/42/contactTags",
		"/api/3/contacts/42/fieldValues",
	} {
		if seen[path] != 1 {
			t.Fatalf("%s called %d times, want once", path, seen[path])
		}
	}
}

func TestListSubscribersPaginatesLinkedContactRelationships(t *testing.T) {
	seenOffsets := map[string][]string{}
	writeRelationshipPage := func(w http.ResponseWriter, r *http.Request, key string, first, second map[string]any) {
		offset := r.URL.Query().Get("offset")
		seenOffsets[r.URL.Path] = append(seenOffsets[r.URL.Path], offset)
		if r.URL.Query().Get("limit") != fmt.Sprint(pageSize) {
			t.Fatalf("%s limit = %q, want %d", r.URL.Path, r.URL.Query().Get("limit"), pageSize)
		}
		switch offset {
		case "0":
			writeJSON(t, w, map[string]any{key: []any{first}, "meta": map[string]any{"total": 2}})
		case "1":
			writeJSON(t, w, map[string]any{key: []any{second}, "meta": map[string]any{"total": 2}})
		default:
			t.Fatalf("%s offset = %q, want 0 or 1", r.URL.Path, offset)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{
				map[string]any{"id": "10", "title": "Plan"},
				map[string]any{"id": "11", "title": "Region"},
			}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{
				map[string]any{"id": "3", "tag": "Customer"},
				map[string]any{"id": "4", "tag": "VIP"},
			}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{
					"id":    "42",
					"email": "ada@example.com",
					"links": map[string]any{
						"contactLists": "/api/3/contacts/42/contactLists",
						"contactTags":  "/api/3/contacts/42/contactTags",
						"fieldValues":  "/api/3/contacts/42/fieldValues",
					},
				}},
				"meta": map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{
					"id":    "42",
					"email": "ada@example.com",
					"links": map[string]any{
						"contactLists": "/api/3/contacts/42/contactLists",
						"contactTags":  "/api/3/contacts/42/contactTags",
						"fieldValues":  "/api/3/contacts/42/fieldValues",
					},
				},
			})
		case "/api/3/contacts/42/contactLists":
			writeRelationshipPage(w, r, "contactLists",
				map[string]any{"id": "9", "list": "7", "status": "1", "sdate": "2026-02-03T04:05:06Z"},
				map[string]any{"id": "10", "list": "8", "status": "1", "sdate": "2026-02-04T04:05:06Z"},
			)
		case "/api/3/contacts/42/contactTags":
			writeRelationshipPage(w, r, "contactTags",
				map[string]any{"id": "11", "contact": "42", "tag": "3"},
				map[string]any{"id": "12", "contact": "42", "tag": "4"},
			)
		case "/api/3/contacts/42/fieldValues":
			writeRelationshipPage(w, r, "fieldValues",
				map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth"},
				map[string]any{"id": "100", "contact": "42", "field": "11", "value": "EU"},
			)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, next, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "" || len(subs) != 1 {
		t.Fatalf("next=%q subs=%d", next, len(subs))
	}
	sub := subs[0]
	if sub.CustomFields["plan"] != "Growth" || sub.CustomFields["region"] != "EU" {
		t.Fatalf("custom fields = %#v", sub.CustomFields)
	}
	for _, tag := range []string{"Customer", "VIP"} {
		assertContains(t, sub.Tags, tag)
	}
	assertNotContains(t, sub.Tags, "list:7")
	assertNotContains(t, sub.Tags, "list:8")
	for _, path := range []string{
		"/api/3/contacts/42/contactLists",
		"/api/3/contacts/42/contactTags",
		"/api/3/contacts/42/fieldValues",
	} {
		if got := strings.Join(seenOffsets[path], ","); got != "0,1" {
			t.Fatalf("%s offsets = %q, want 0,1", path, got)
		}
	}
}

func TestListSubscribersFailsWhenContactDetailPayloadMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), `response missing "contact" object`) {
		t.Fatalf("err = %v, want malformed contact-detail failure", err)
	}
}

func TestFetchContactDetailRejectsMismatchedOrMissingResponseIdentity(t *testing.T) {
	for _, tc := range []struct {
		name      string
		contactID interface{}
	}{
		{name: "mismatched id", contactID: "43"},
		{name: "missing id", contactID: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/3/contacts/42" {
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
				contact := map[string]interface{}{"email": "ada@example.com"}
				if tc.contactID != nil {
					contact["id"] = tc.contactID
				}
				writeJSON(t, w, map[string]interface{}{"contact": contact})
			}))
			defer srv.Close()

			_, err := New().fetchContactDetail(context.Background(), adapter.Session{
				AccessToken: "secret",
				Source:      canonical.SourceActiveCampaign,
				Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
			}, acContact{ID: "42", Email: "listed@example.com"})
			if err == nil || !strings.Contains(err.Error(), "fetch contact detail 42: detail identity mismatch") {
				t.Fatalf("error = %v, want fail-closed detail identity mismatch", err)
			}
		})
	}
}

func TestListSubscribersFailsWhenLinkedRelationshipPayloadMissing(t *testing.T) {
	for _, tc := range []struct {
		name        string
		missingPath string
		missingKey  string
		wantErr     string
	}{
		{
			name:        "list memberships",
			missingPath: "/api/3/contacts/42/contactLists",
			missingKey:  "contactLists",
			wantErr:     "fetch contact 42 list memberships",
		},
		{
			name:        "tags",
			missingPath: "/api/3/contacts/42/contactTags",
			missingKey:  "contactTags",
			wantErr:     "fetch contact 42 tags",
		},
		{
			name:        "field values",
			missingPath: "/api/3/contacts/42/fieldValues",
			missingKey:  "fieldValues",
			wantErr:     "fetch contact 42 field values",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/3/fields":
					writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
				case "/api/3/tags":
					writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
				case "/api/3/contacts":
					writeJSON(t, w, map[string]any{
						"contacts": []any{map[string]any{
							"id":    "42",
							"email": "ada@example.com",
							"links": map[string]any{
								"contactLists": "/api/3/contacts/42/contactLists",
								"contactTags":  "/api/3/contacts/42/contactTags",
								"fieldValues":  "/api/3/contacts/42/fieldValues",
							},
						}},
						"meta": map[string]any{"total": 1},
					})
				case "/api/3/contacts/42":
					writeJSON(t, w, map[string]any{
						"contact": map[string]any{
							"id":    "42",
							"email": "ada@example.com",
							"links": map[string]any{
								"contactLists": "/api/3/contacts/42/contactLists",
								"contactTags":  "/api/3/contacts/42/contactTags",
								"fieldValues":  "/api/3/contacts/42/fieldValues",
							},
						},
					})
				case "/api/3/contacts/42/contactLists":
					if r.URL.Path == tc.missingPath {
						writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
						return
					}
					writeJSON(t, w, map[string]any{"contactLists": []any{}})
				case "/api/3/contacts/42/contactTags":
					if r.URL.Path == tc.missingPath {
						writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
						return
					}
					writeJSON(t, w, map[string]any{"contactTags": []any{}})
				case "/api/3/contacts/42/fieldValues":
					if r.URL.Path == tc.missingPath {
						writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
						return
					}
					writeJSON(t, w, map[string]any{"fieldValues": []any{}})
				default:
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
			}))
			defer srv.Close()

			_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
				AccessToken: "secret",
				Source:      canonical.SourceActiveCampaign,
				Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
			}, "")
			if err == nil ||
				!strings.Contains(err.Error(), tc.wantErr) ||
				!strings.Contains(err.Error(), `response missing "`+tc.missingKey+`" array`) {
				t.Fatalf("err = %v, want malformed %s relationship failure", err, tc.name)
			}
		})
	}
}

func TestListSubscribersDoesNotTreatContactCreationAsConsent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "cdate": "2026-01-02T03:04:05Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":      map[string]any{"id": "42", "email": "ada@example.com", "cdate": "2026-01-02T03:04:05Z"},
				"contactLists": []any{map[string]any{"id": "9", "list": "7", "status": "1"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d", len(subs))
	}
	if subs[0].ConsentTimestamp != nil || subs[0].ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, want unknown without list subscription date", subs[0].ConsentTimestamp, subs[0].ConsentSource)
	}
}

func TestListSubscribersSkipsContactEmailMissingForSourceArchivePreservation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "42"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, next, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 0 || next != "" {
		t.Fatalf("subs/next = %d/%q, want skipped non-email contact", len(subs), next)
	}
}

func TestListSubscribersFailsWhenContactIDMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), "contact unknown did not advance ascending ID pagination") {
		t.Fatalf("err = %v, want missing numeric source-id failure", err)
	}
}

func TestListSubscribersFailsWhenIDPaginationCannotContinue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "abc", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 2},
			})
		case "/api/3/contacts/abc":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "abc", "email": "ada@example.com"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), "did not advance ascending ID pagination") {
		t.Fatalf("err = %v, want unsafe-pagination failure", err)
	}
}

func TestValidateAscendingActiveCampaignContactIDsRejectsOutOfOrderRows(t *testing.T) {
	_, err := validateAscendingActiveCampaignContactIDs([]acContact{{ID: "42"}, {ID: "41"}}, 0)
	if err == nil || !strings.Contains(err.Error(), "contact 41 did not advance ascending ID pagination after 42") {
		t.Fatalf("err = %v, want out-of-order ID failure", err)
	}
}

func TestValidateActiveCampaignOffsetPageRejectsInconsistentProviderTotals(t *testing.T) {
	for _, tc := range []struct {
		name                string
		rows, total, offset int
		want                string
	}{
		{name: "premature empty page", rows: 0, total: 3, offset: 1, want: "empty page at offset 1 before provider total 3"},
		{name: "page exceeds total", rows: 3, total: 2, offset: 0, want: "exceeds provider total 2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateActiveCampaignOffsetPage(tc.rows, tc.total, tc.offset)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestListSubscribersPreservesUnknownContactAttributes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{
					"id":     "42",
					"email":  "ada@example.com",
					"orgid":  "summary-org",
					"ip4Sub": "203.0.113.10",
				}},
				"meta": map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{
					"id":          "42",
					"email":       "ada@example.com",
					"orgid":       "detail-org",
					"scoreValues": []any{map[string]any{"score": 73, "label": "engaged"}},
				},
				"contactLists": []any{},
				"contactTags":  []any{},
				"fieldValues":  []any{},
				"deals": []any{
					map[string]any{"id": "deal_2", "title": "Expansion", "status": "1", "value": "200", "contact": "42", "probability": "80"},
					map[string]any{"id": "deal_1", "title": "New business", "status": "1", "value": "100", "contact": "42", "custom_field": "new-business-risk"},
				},
				"activities": []any{
					map[string]any{"id": "act_2", "type": "click", "tstamp": "2026-05-12T12:00:00Z"},
					map[string]any{"id": "act_1", "type": "open", "tstamp": "2026-05-12T11:00:00Z"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d, want 1", len(subs))
	}
	attrs := interfaceMapField(t, subs[0], "activecampaign_contact_attributes")
	if attrs["orgid"] != "detail-org" {
		t.Fatalf("orgid = %#v, want detail value to win", attrs["orgid"])
	}
	if attrs["ip4Sub"] != "203.0.113.10" {
		t.Fatalf("ip4Sub = %#v, want summary-only attribute preserved", attrs["ip4Sub"])
	}
	if _, ok := attrs["scoreValues"].([]interface{}); !ok {
		t.Fatalf("scoreValues = %T %#v, want raw provider array", attrs["scoreValues"], attrs["scoreValues"])
	}
	if _, ok := attrs["email"]; ok {
		t.Fatalf("known contact email leaked into source attributes: %#v", attrs)
	}
	deals := interfaceMapSliceField(t, subs[0], "activecampaign_deals")
	if len(deals) != 2 || sourceMapString(deals[0], "id") != "deal_1" || sourceMapString(deals[1], "id") != "deal_2" {
		t.Fatalf("deals = %#v, want stable sorted deal evidence", deals)
	}
	if sourceMapString(deals[0], "custom_field") != "new-business-risk" || sourceMapString(deals[1], "probability") != "80" {
		t.Fatalf("deal raw fields = %#v, want provider-only fields preserved", deals)
	}
	activities := interfaceMapSliceField(t, subs[0], "activecampaign_contact_activities")
	if len(activities) != 2 {
		t.Fatalf("activities = %#v, want two preserved rows", activities)
	}
	if activities[0]["id"] != "act_1" || activities[1]["id"] != "act_2" {
		t.Fatalf("activities = %#v, want stable sorted activity evidence", activities)
	}
}

func TestListSubscribersFailsWhenContactPagePayloadMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), `response missing "contacts" array`) {
		t.Fatalf("err = %v, want missing contacts payload failure", err)
	}
}

func TestListSubscribersRequiresFieldAndTagMetadata(t *testing.T) {
	for _, tc := range []struct {
		name     string
		failPath string
		wantErr  string
	}{
		{
			name:     "field metadata",
			failPath: "/api/3/fields",
			wantErr:  "load custom field metadata",
		},
		{
			name:     "tag metadata",
			failPath: "/api/3/tags",
			wantErr:  "load tag metadata",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/3/fields":
					if r.URL.Path == tc.failPath {
						http.Error(w, `{"message":"fields unavailable"}`, http.StatusForbidden)
						return
					}
					writeJSON(t, w, map[string]any{"fields": []any{}})
				case "/api/3/tags":
					if r.URL.Path == tc.failPath {
						http.Error(w, `{"message":"tags unavailable"}`, http.StatusForbidden)
						return
					}
					writeJSON(t, w, map[string]any{"tags": []any{}})
				case "/api/3/contacts":
					t.Fatalf("contacts should not be requested before metadata is available")
				default:
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
			}))
			defer srv.Close()

			_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
				AccessToken: "secret",
				Source:      canonical.SourceActiveCampaign,
				Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
			}, "")
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestListSubscribersFailsWhenMetadataPagePayloadMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
		case "/api/3/tags", "/api/3/contacts":
			t.Fatalf("%s should not be requested after malformed field metadata", r.URL.Path)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil ||
		!strings.Contains(err.Error(), "load custom field metadata") ||
		!strings.Contains(err.Error(), `response missing "fields" array`) {
		t.Fatalf("err = %v, want malformed metadata failure", err)
	}
}

func TestListSubscribersUsesStableFallbackNamesForNamelessMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com"},
				"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "3"}},
				"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d", len(subs))
	}
	if subs[0].CustomFields["activecampaign_field_10"] != "Growth" {
		t.Fatalf("custom fields = %#v, want fallback field key", subs[0].CustomFields)
	}
	if fmt.Sprint(subs[0].Tags) != "[activecampaign_tag:3]" {
		t.Fatalf("tags = %#v, want fallback tag", subs[0].Tags)
	}
}

func TestListSubscribersDisambiguatesDuplicateCustomFieldNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{
				map[string]any{"id": "10", "title": "Plan"},
				map[string]any{"id": "11", "title": "Plan"},
			}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "42", "email": "ada@example.com"},
				"fieldValues": []any{
					map[string]any{"id": "fv_1", "contact": "42", "field": "10", "value": "Growth"},
					map[string]any{"id": "fv_2", "contact": "42", "field": "11", "value": "Enterprise"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d", len(subs))
	}
	if subs[0].CustomFields["plan"] != "Growth" || subs[0].CustomFields["plan_11"] != "Enterprise" {
		t.Fatalf("custom fields = %#v, want both duplicate Plan values preserved", subs[0].CustomFields)
	}
}

func TestListSubscribersProtectsCanonicalIdentityFromReservedCustomFieldNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{
				map[string]any{"id": "10", "title": "Name"},
				map[string]any{"id": "11", "title": "First name"},
				map[string]any{"id": "12", "title": "Last-name"},
				map[string]any{"id": "13", "title": "Phone"},
			}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{
					"id": "42", "email": "ada@example.com", "firstName": "Ada",
					"lastName": "Lovelace", "phone": "+15551234567",
				}},
				"meta": map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{
					"id": "42", "email": "ada@example.com", "firstName": "Ada",
					"lastName": "Lovelace", "phone": "+15551234567",
				},
				"fieldValues": []any{
					map[string]any{"id": "fv_10", "contact": "42", "field": "10", "value": "Account 42"},
					map[string]any{"id": "fv_11", "contact": "42", "field": "11", "value": "Grace"},
					map[string]any{"id": "fv_12", "contact": "42", "field": "12", "value": "Hopper"},
					map[string]any{"id": "fv_13", "contact": "42", "field": "13", "value": "+19999999999"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d", len(subs))
	}
	fields := subs[0].CustomFields
	if fields["name"] != "Ada Lovelace" || fields["first_name"] != "Ada" ||
		fields["last_name"] != "Lovelace" || fields["phone"] != "+15551234567" {
		t.Fatalf("canonical identity fields = %#v, want provider contact identity", fields)
	}
	if fields["name_10"] != "Account 42" || fields["first_name_11"] != "Grace" ||
		fields["last_name_12"] != "Hopper" || fields["phone_13"] != "+19999999999" {
		t.Fatalf("reserved custom fields = %#v, want disambiguated source values", fields)
	}
}

func TestListSubscribersPreservesContactReferencesWhenMetadataListIsIncomplete(t *testing.T) {
	for _, tc := range []struct {
		name      string
		fieldID   string
		tagID     string
		wantField string
		wantTag   string
	}{
		{
			name:      "unknown custom field",
			fieldID:   "999",
			tagID:     "3",
			wantField: "activecampaign_field_999",
			wantTag:   "Customer",
		},
		{
			name:      "unknown tag",
			fieldID:   "10",
			tagID:     "999",
			wantField: "plan",
			wantTag:   "activecampaign_tag:999",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/3/fields":
					writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
				case "/api/3/tags":
					writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
				case "/api/3/contacts":
					writeJSON(t, w, map[string]any{
						"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
						"meta":     map[string]any{"total": 1},
					})
				case "/api/3/contacts/42":
					writeJSON(t, w, map[string]any{
						"contact":     map[string]any{"id": "42", "email": "ada@example.com"},
						"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": tc.tagID}},
						"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": tc.fieldID, "value": "Growth"}},
					})
				default:
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
			}))
			defer srv.Close()

			subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
				AccessToken: "secret",
				Source:      canonical.SourceActiveCampaign,
				Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
			}, "")
			if err != nil {
				t.Fatal(err)
			}
			if len(subs) != 1 {
				t.Fatalf("subs len = %d", len(subs))
			}
			if subs[0].CustomFields[tc.wantField] != "Growth" {
				t.Fatalf("custom fields = %#v, want %s fallback to preserve Growth", subs[0].CustomFields, tc.wantField)
			}
			if fmt.Sprint(subs[0].Tags) != "["+tc.wantTag+"]" {
				t.Fatalf("tags = %#v, want [%s]", subs[0].Tags, tc.wantTag)
			}
		})
	}
}

func TestListSubscribersPreservesMalformedRelationshipRowsWhenStableIDsExist(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com"},
				"contactTags": []any{map[string]any{"id": "ct_11", "contact": "42", "source": "legacy-import"}},
				"fieldValues": []any{map[string]any{"id": "fv_99", "contact": "42", "value": "Growth", "source": "legacy-import"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d", len(subs))
	}
	unmappedFields := interfaceMapSliceField(t, subs[0], "activecampaign_unmapped_field_values")
	if len(unmappedFields) != 1 {
		t.Fatalf("unmapped field values = %#v, want one preserved row", unmappedFields)
	}
	if sourceMapString(unmappedFields[0], "id") != "fv_99" ||
		sourceMapString(unmappedFields[0], "value") != "Growth" ||
		sourceMapString(unmappedFields[0], "source") != "legacy-import" ||
		sourceMapString(unmappedFields[0], "reason") != "missing_custom_field_id" {
		t.Fatalf("unmapped field value = %#v", unmappedFields[0])
	}
	unmappedTags := interfaceMapSliceField(t, subs[0], "activecampaign_unmapped_contact_tags")
	if len(unmappedTags) != 1 {
		t.Fatalf("unmapped contact tags = %#v, want one preserved row", unmappedTags)
	}
	if sourceMapString(unmappedTags[0], "id") != "ct_11" ||
		sourceMapString(unmappedTags[0], "source") != "legacy-import" ||
		sourceMapString(unmappedTags[0], "reason") != "missing_tag_id" {
		t.Fatalf("unmapped contact tag = %#v", unmappedTags[0])
	}
	if len(subs[0].Tags) != 0 {
		t.Fatalf("tags = %#v, malformed tag relationship should not become executable tag", subs[0].Tags)
	}
}

func TestListSubscribersRetriesMetadataAfterFailedLookup(t *testing.T) {
	fieldCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			fieldCalls++
			if fieldCalls == 1 {
				http.Error(w, `{"message":"try again"}`, http.StatusBadRequest)
				return
			}
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com"},
				"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "3"}},
				"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	_, _, err := ad.ListSubscribers(context.Background(), sess, "")
	if err == nil || !strings.Contains(err.Error(), "load custom field metadata") {
		t.Fatalf("first err = %v, want field metadata failure", err)
	}
	subs, _, err := ad.ListSubscribers(context.Background(), sess, "")
	if err != nil {
		t.Fatal(err)
	}
	if fieldCalls != 2 {
		t.Fatalf("fieldCalls = %d, want 2", fieldCalls)
	}
	if len(subs) != 1 || subs[0].CustomFields["plan"] != "Growth" {
		t.Fatalf("subscriber did not use reloaded metadata: %#v", subs)
	}
	assertContains(t, subs[0].Tags, "Customer")
}

func TestListSubscribersReloadsMetadataWhenAdapterReusedForDifferentAccount(t *testing.T) {
	newAccountServer := func(fieldTitle, tagName, email, fieldValue string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/3/fields":
				writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": fieldTitle}}})
			case "/api/3/tags":
				writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": tagName}}})
			case "/api/3/contacts":
				writeJSON(t, w, map[string]any{
					"contacts": []any{map[string]any{"id": "42", "email": email}},
					"meta":     map[string]any{"total": 1},
				})
			case "/api/3/contacts/42":
				writeJSON(t, w, map[string]any{
					"contact":     map[string]any{"id": "42", "email": email},
					"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "3"}},
					"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": fieldValue}},
				})
			default:
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
		}))
	}
	firstServer := newAccountServer("Plan", "Customer", "ada@example.com", "Growth")
	defer firstServer.Close()
	secondServer := newAccountServer("Region", "Pilot", "grace@example.com", "EMEA")
	defer secondServer.Close()

	ad := New()
	first, _, err := ad.ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": firstServer.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := ad.ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": secondServer.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}

	if first[0].CustomFields["plan"] != "Growth" {
		t.Fatalf("first account fields = %#v", first[0].CustomFields)
	}
	if _, ok := second[0].CustomFields["plan"]; ok {
		t.Fatalf("second account reused stale field metadata: %#v", second[0].CustomFields)
	}
	if second[0].CustomFields["region"] != "EMEA" {
		t.Fatalf("second account fields = %#v, want region", second[0].CustomFields)
	}
	assertContains(t, first[0].Tags, "Customer")
	assertContains(t, second[0].Tags, "Pilot")
}

func TestListSubscribersFailsWhenContactDetailUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			http.Error(w, `{"message":"detail unavailable"}`, http.StatusBadGateway)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), "fetch contact detail 42") {
		t.Fatalf("err = %v, want contact-detail fetch failure", err)
	}
}

func TestListSubscribersUsesIDPaginationForLargeExports(t *testing.T) {
	contactQueries := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case r.URL.Path == "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case r.URL.Path == "/api/3/contacts":
			contactQueries = append(contactQueries, r.URL.RawQuery)
			if r.URL.Query().Get("id_greater") == "100" {
				writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": 100}})
				return
			}
			contacts := make([]any, 0, pageSize)
			for i := 1; i <= pageSize; i++ {
				contacts = append(contacts, map[string]any{
					"id":    fmt.Sprintf("%d", i),
					"email": fmt.Sprintf("user%d@example.com", i),
				})
			}
			writeJSON(t, w, map[string]any{"contacts": contacts, "meta": map[string]any{"total": pageSize + 1}})
		case strings.HasPrefix(r.URL.Path, "/api/3/contacts/"):
			id := strings.TrimPrefix(r.URL.Path, "/api/3/contacts/")
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{
					"id":    id,
					"email": fmt.Sprintf("user%s@example.com", id),
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	subs, next, err := ad.ListSubscribers(context.Background(), sess, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != pageSize || next != "id:100" {
		t.Fatalf("len=%d next=%q", len(subs), next)
	}
	if !strings.Contains(contactQueries[0], "orders%5Bid%5D=ASC") || strings.Contains(contactQueries[0], "offset=") {
		t.Fatalf("first contact query = %q", contactQueries[0])
	}

	subs, next, err = ad.ListSubscribers(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 0 || next != "" {
		t.Fatalf("second len=%d next=%q", len(subs), next)
	}
	if !strings.Contains(contactQueries[1], "id_greater=100") {
		t.Fatalf("second contact query = %q", contactQueries[1])
	}
}

func TestListSubscribersKeepsLegacyOffsetTraversalUntilCompletion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("offset"); got != "100" {
				t.Fatalf("offset = %q, want legacy checkpoint 100", got)
			}
			if got := r.URL.Query().Get("orders[id]"); got != "" {
				t.Fatalf("legacy request unexpectedly added ID order %q", got)
			}
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "900", "email": "legacy@example.com"}},
				"meta":     map[string]any{"total": 102},
			})
		case "/api/3/contacts/900":
			writeJSON(t, w, map[string]any{"contact": map[string]any{"id": "900", "email": "legacy@example.com"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, next, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "offset:100")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || next != "offset:101" {
		t.Fatalf("len=%d next=%q, want legacy offset continuation", len(subs), next)
	}
}

func TestListSubscribersUsesProviderTotalForShortPagesAndMetadata(t *testing.T) {
	seenOffsets := map[string][]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			offset := r.URL.Query().Get("offset")
			seenOffsets["fields"] = append(seenOffsets["fields"], offset)
			switch offset {
			case "0":
				writeJSON(t, w, map[string]any{
					"fields": []any{map[string]any{"id": "10", "title": "Plan"}},
					"meta":   map[string]any{"total": 2},
				})
			case "1":
				writeJSON(t, w, map[string]any{
					"fields": []any{map[string]any{"id": "11", "title": "Region"}},
					"meta":   map[string]any{"total": 2},
				})
			default:
				t.Fatalf("fields offset = %q", offset)
			}
		case "/api/3/tags":
			offset := r.URL.Query().Get("offset")
			seenOffsets["tags"] = append(seenOffsets["tags"], offset)
			switch offset {
			case "0":
				writeJSON(t, w, map[string]any{
					"tags": []any{map[string]any{"id": "3", "tag": "Customer"}},
					"meta": map[string]any{"total": 2},
				})
			case "1":
				writeJSON(t, w, map[string]any{
					"tags": []any{map[string]any{"id": "4", "tag": "Pilot"}},
					"meta": map[string]any{"total": 2},
				})
			default:
				t.Fatalf("tags offset = %q", offset)
			}
		case "/api/3/contacts":
			if got := r.URL.Query().Get("id_greater"); got != "" {
				t.Fatalf("id_greater = %q, want empty on first page", got)
			}
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 2},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"},
				"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "4"}},
				"fieldValues": []any{map[string]any{"id": "fv_1", "contact": "42", "field": "11", "value": "EU"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	subs, next, err := New().ListSubscribers(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || next != "id:42" {
		t.Fatalf("len=%d next=%q", len(subs), next)
	}
	if got := fmt.Sprint(seenOffsets["fields"]); got != "[0 1]" {
		t.Fatalf("field offsets = %s, want [0 1]", got)
	}
	if got := fmt.Sprint(seenOffsets["tags"]); got != "[0 1]" {
		t.Fatalf("tag offsets = %s, want [0 1]", got)
	}
	if subs[0].CustomFields["region"] != "EU" {
		t.Fatalf("custom fields = %#v, want region from second metadata page", subs[0].CustomFields)
	}
	assertContains(t, subs[0].Tags, "Pilot")
}

func TestContactStatusKeepsActiveContactWhenOnlyOneListWasUnsubscribed(t *testing.T) {
	lists := []acContactList{
		{List: "old", Status: "2"},
		{List: "current", Status: "Active"},
	}
	decision := evaluateActiveCampaignSubscriberSafety(
		acContact{Deleted: "0"}, lists, completeActiveCampaignEmailSafetyEvidence("old", "current"),
	)
	if decision.Status != canonical.StatusEnabled {
		t.Fatalf("status = %s, want enabled", decision.Status)
	}
}

func TestContactStatusTreatsCaseInsensitiveUnsubscribedAsDisabled(t *testing.T) {
	lists := []acContactList{
		{List: "old", Status: "Unsubscribed"},
	}
	decision := evaluateActiveCampaignSubscriberSafety(
		acContact{Deleted: "0"}, lists, completeActiveCampaignEmailSafetyEvidence("old"),
	)
	if decision.Status != canonical.StatusDisabled {
		t.Fatalf("status = %s, want disabled", decision.Status)
	}
}

func TestContactStatusTreatsBounceEvidenceAsBlocklisted(t *testing.T) {
	lists := []acContactList{
		{List: "current", Status: "Subscribed"},
	}
	decision := evaluateActiveCampaignSubscriberSafety(
		acContact{Deleted: "0", BouncedHard: " 1 "}, lists, completeActiveCampaignEmailSafetyEvidence("current"),
	)
	if decision.Status != canonical.StatusBlocklisted {
		t.Fatalf("status = %s, want blocklisted from hard-bounce contact flag", decision.Status)
	}

	lists = []acContactList{
		{List: "bounced", Status: "3"},
		{List: "current", Status: "Subscribed"},
	}
	decision = evaluateActiveCampaignSubscriberSafety(
		acContact{Deleted: "0"}, lists, completeActiveCampaignEmailSafetyEvidence("bounced", "current"),
	)
	if decision.Status != canonical.StatusBlocklisted {
		t.Fatalf("status = %s, want blocklisted from bounced list status", decision.Status)
	}
}

func TestContactStatusWithoutListMembershipIsUnconfirmed(t *testing.T) {
	decision := evaluateActiveCampaignSubscriberSafety(acContact{Deleted: "0"}, nil, activeCampaignSubscriberSafetyEvidence{})
	if decision.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed", decision.Status)
	}
}

func TestContactStatusIgnoresMalformedListMembershipForSendability(t *testing.T) {
	decision := evaluateActiveCampaignSubscriberSafety(acContact{Deleted: "0"}, []acContactList{
		{ID: "row_1", Status: "Active", SubscribeDate: "2026-02-03T04:05:06Z"},
	}, completeActiveCampaignEmailSafetyEvidence())
	if decision.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed for active row without list id", decision.Status)
	}
}

func TestListSubscriberTagsOnlyActiveListMemberships(t *testing.T) {
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{
			{List: "old", Status: "Unsubscribe"},
			{List: "current", Status: "Subscribed"},
			{List: "pending", Status: "0"},
		},
	}, map[string]string{}, map[string]string{}, completeActiveCampaignEmailSafetyEvidence("old", "current", "pending"))
	if err != nil {
		t.Fatal(err)
	}
	assertContains(t, sub.Tags, "list:current")
	assertNotContains(t, sub.Tags, "list:old")
	assertNotContains(t, sub.Tags, "list:pending")
	if got := fmt.Sprint(sub.CustomFields["activecampaign_unsubscribed_lists"]); got != "[old]" {
		t.Fatalf("unsubscribed lists = %v, want [old]", got)
	}
	if got := fmt.Sprint(sub.CustomFields["activecampaign_inactive_lists"]); got != "[pending]" {
		t.Fatalf("inactive lists = %v, want [pending]", got)
	}
}

func TestMapContactToCanonicalPreservesListMembershipEvidence(t *testing.T) {
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{
			{
				ID:            "11",
				List:          "review",
				Status:        "review_required",
				SubscribeDate: "2026-03-01T00:00:00Z",
				SourceID:      "form-1",
			},
			{
				ID:            "9",
				List:          "current",
				Status:        "Subscribed",
				SubscribeDate: "2026-01-01T00:00:00Z",
			},
			{
				ID:            "10",
				List:          "old",
				Status:        "Unsubscribe",
				SubscribeDate: "2025-01-01T00:00:00Z",
				UnsubDate:     "2026-02-01T00:00:00Z",
				UnsubReason:   "no longer interested",
			},
		},
	}, map[string]string{}, map[string]string{}, completeActiveCampaignEmailSafetyEvidence("review", "current", "old"))
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want fail-closed for unknown email-list status", sub.Status)
	}
	assertContains(t, sub.Tags, "list:current")
	if got := fmt.Sprint(sub.CustomFields["activecampaign_unsubscribed_lists"]); got != "[old]" {
		t.Fatalf("unsubscribed lists = %v, want [old]", got)
	}
	if got := fmt.Sprint(sub.CustomFields["activecampaign_inactive_lists"]); got != "[review]" {
		t.Fatalf("inactive lists = %v, want [review]", got)
	}

	memberships := interfaceMapSliceField(t, sub, "activecampaign_list_memberships")
	if len(memberships) != 3 {
		t.Fatalf("list memberships = %#v, want 3 rows", memberships)
	}
	if memberships[0]["list_id"] != "current" || memberships[0]["status_class"] != "active" {
		t.Fatalf("first membership = %#v, want current active", memberships[0])
	}
	if memberships[1]["list_id"] != "old" ||
		memberships[1]["status_class"] != "unsubscribed" ||
		memberships[1]["unsubscribed_at"] != "2026-02-01T00:00:00Z" ||
		memberships[1]["unsubscribe_reason"] != "no longer interested" {
		t.Fatalf("second membership = %#v, want unsubscribed evidence", memberships[1])
	}
	if memberships[2]["list_id"] != "review" ||
		memberships[2]["status_class"] != "unknown" ||
		memberships[2]["status"] != "review_required" ||
		memberships[2]["source_id"] != "form-1" {
		t.Fatalf("third membership = %#v, want unknown-status evidence", memberships[2])
	}

	unknown := interfaceMapSliceField(t, sub, "activecampaign_unknown_list_memberships")
	if len(unknown) != 1 || unknown[0]["list_id"] != "review" || unknown[0]["status"] != "review_required" {
		t.Fatalf("unknown memberships = %#v, want review row", unknown)
	}
}

func TestMapContactToCanonicalPreservesMalformedListMembershipAsReviewOnly(t *testing.T) {
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{{
			ID:            "row_1",
			Status:        "Active",
			SubscribeDate: "2026-02-03T04:05:06Z",
			SourceID:      "form-1",
			Raw: map[string]interface{}{
				"id":       "row_1",
				"status":   "Active",
				"sourceid": "form-1",
			},
		}},
	}, map[string]string{}, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed because malformed list membership is review-only", sub.Status)
	}
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %v/%s, want unknown consent", sub.ConsentTimestamp, sub.ConsentSource)
	}
	if len(sub.Tags) != 0 {
		t.Fatalf("tags = %#v, malformed list membership should not create executable tags", sub.Tags)
	}
	if _, ok := sub.CustomFields["activecampaign_list_memberships"]; ok {
		t.Fatalf("activecampaign_list_memberships = %#v, want malformed row excluded from executable memberships", sub.CustomFields["activecampaign_list_memberships"])
	}
	unmapped := interfaceMapSliceField(t, sub, "activecampaign_unmapped_list_memberships")
	if len(unmapped) != 1 ||
		unmapped[0]["id"] != "row_1" ||
		unmapped[0]["status"] != "Active" ||
		unmapped[0]["status_class"] != "unmapped" ||
		unmapped[0]["source_id"] != "form-1" ||
		unmapped[0]["reason"] != "missing_list_id" {
		t.Fatalf("unmapped memberships = %#v, want preserved review-only row", unmapped)
	}
}

func TestMapContactToCanonicalFailsMalformedListMembershipWithoutStableID(t *testing.T) {
	_, err := mapContactToCanonical(acContactDetail{
		Contact:      acContact{ID: "42", Email: "ada@example.com"},
		ContactLists: []acContactList{{Status: "Active"}},
	}, map[string]string{}, map[string]string{})
	if err == nil || !strings.Contains(err.Error(), "list membership missing stable id and list id") {
		t.Fatalf("err = %v, want missing stable id/list id error", err)
	}
}

func TestMapContactToCanonicalPreservesBounceEvidence(t *testing.T) {
	sub, err := mapContactToCanonical(acContactDetail{
		Contact: acContact{
			ID:          "42",
			Email:       "ada@example.com",
			BouncedHard: "1",
			BouncedSoft: "0",
			BouncedDate: "2026-04-01",
		},
		ContactLists: []acContactList{
			{ID: "9", List: "current", Status: "Subscribed", SubscribeDate: "2026-01-01T00:00:00Z"},
			{ID: "10", List: "deliverability", Status: "3", SubscribeDate: "2026-01-01T00:00:00Z"},
		},
	}, map[string]string{}, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if sub.Status != canonical.StatusBlocklisted {
		t.Fatalf("status = %s, want blocklisted for hard-bounced contact", sub.Status)
	}
	if sub.CustomFields["activecampaign_bounced_hard"] != true {
		t.Fatalf("custom fields = %#v, want hard-bounce evidence", sub.CustomFields)
	}
	if sub.CustomFields["activecampaign_bounced_date"] != "2026-04-01" {
		t.Fatalf("bounced date = %#v, want source date", sub.CustomFields["activecampaign_bounced_date"])
	}
	if got := fmt.Sprint(sub.CustomFields["activecampaign_bounced_lists"]); got != "[deliverability]" {
		t.Fatalf("bounced lists = %v, want [deliverability]", got)
	}
	memberships := interfaceMapSliceField(t, sub, "activecampaign_list_memberships")
	if len(memberships) != 2 || memberships[0]["status_class"] != "active" || memberships[1]["status_class"] != "bounced" {
		t.Fatalf("list memberships = %#v, want active and bounced rows", memberships)
	}
}

func TestMapContactToCanonicalSortsSetLikeFieldsForStableProjectionHash(t *testing.T) {
	fieldNames := map[string]string{"10": "Plan", "11": "Region"}
	tagNames := map[string]string{"3": "Customer", "4": "Pilot"}
	detailA := acContactDetail{
		Contact: acContact{ID: "42", Email: "ada@example.com", UpdatedAt: "2026-05-12T11:00:00Z"},
		ContactTags: []acContactTag{
			{ID: "11", Contact: "42", Tag: "4"},
			{ID: "12", Contact: "42", Tag: "3"},
		},
		ContactLists: []acContactList{
			{List: "old", Status: "Unsubscribe"},
			{List: "current", Status: "Subscribed"},
			{List: "pending", Status: "0"},
		},
		FieldValues: []acFieldValue{
			{ID: "100", Contact: "42", Field: "11", Value: "EU"},
			{ID: "99", Contact: "42", Field: "10", Value: "Growth"},
		},
		Deals: []acDeal{
			{ID: "2", Title: "Expansion", Status: "1", Value: "200"},
			{ID: "1", Title: "New business", Status: "1", Value: "100"},
		},
	}
	detailB := acContactDetail{
		Contact: detailA.Contact,
		ContactTags: []acContactTag{
			{ID: "12", Contact: "42", Tag: "3"},
			{ID: "11", Contact: "42", Tag: "4"},
		},
		ContactLists: []acContactList{
			{List: "pending", Status: "0"},
			{List: "current", Status: "Subscribed"},
			{List: "old", Status: "Unsubscribe"},
		},
		FieldValues: []acFieldValue{
			{ID: "99", Contact: "42", Field: "10", Value: "Growth"},
			{ID: "100", Contact: "42", Field: "11", Value: "EU"},
		},
		Deals: []acDeal{
			{ID: "1", Title: "New business", Status: "1", Value: "100"},
			{ID: "2", Title: "Expansion", Status: "1", Value: "200"},
		},
	}

	evidence := completeActiveCampaignEmailSafetyEvidence("old", "current", "pending")
	subA, err := mapContactToCanonical(detailA, fieldNames, tagNames, evidence)
	if err != nil {
		t.Fatal(err)
	}
	subB, err := mapContactToCanonical(detailB, fieldNames, tagNames, evidence)
	if err != nil {
		t.Fatal(err)
	}

	if got := fmt.Sprint(subA.Tags); got != "[Customer Pilot list:current]" {
		t.Fatalf("tags = %s, want stable sorted set", got)
	}
	if fmt.Sprint(subA.Tags) != fmt.Sprint(subB.Tags) {
		t.Fatalf("tags differ by provider order: %#v vs %#v", subA.Tags, subB.Tags)
	}
	if fmt.Sprint(subA.CustomFields["activecampaign_inactive_lists"]) != fmt.Sprint(subB.CustomFields["activecampaign_inactive_lists"]) {
		t.Fatalf("inactive lists differ by provider order: %#v vs %#v", subA.CustomFields, subB.CustomFields)
	}
	if fmt.Sprint(subA.CustomFields["activecampaign_unsubscribed_lists"]) != fmt.Sprint(subB.CustomFields["activecampaign_unsubscribed_lists"]) {
		t.Fatalf("unsubscribed lists differ by provider order: %#v vs %#v", subA.CustomFields, subB.CustomFields)
	}
	if fmt.Sprint(subA.CustomFields["activecampaign_deals"]) != fmt.Sprint(subB.CustomFields["activecampaign_deals"]) {
		t.Fatalf("deals differ by provider order: %#v vs %#v", subA.CustomFields["activecampaign_deals"], subB.CustomFields["activecampaign_deals"])
	}
	if sourceEventProjectionHash(subA) != sourceEventProjectionHash(subB) {
		t.Fatalf("projection hash changed for reordered relationship sets: %#v vs %#v", subA, subB)
	}
}

func TestMapAutomationToCanonicalKeepsSourceAutomationNonExecutable(t *testing.T) {
	got := mapAutomationToCanonical(acAutomation{ID: "12", Name: "Revenue", Status: "active"})
	if got.Status != "draft" || len(got.Triggers) != 0 || len(got.Nodes) != 0 || len(got.Edges) != 0 {
		t.Fatalf("automation became executable: %+v", got)
	}
	if !strings.Contains(got.SourceDefinition, `"status":"active"`) {
		t.Fatalf("source definition should preserve source status: %s", got.SourceDefinition)
	}
}

func TestListAutomationsPreservesRawSourceDefinition(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/3/automations/12/") {
			writeJSON(t, w, map[string]any{"items": []any{}})
			return
		}
		if r.URL.Path != "/api/3/automations" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{
			"automations": []any{map[string]any{
				"id":          "12",
				"name":        "Revenue",
				"status":      "active",
				"triggerType": "subscribes",
				"entered":     "42",
				"links":       map[string]any{"campaigns": "https://example.test/automations/12/campaigns"},
			}},
			"meta": map[string]any{
				"total":  1,
				"starts": []any{map[string]any{"id": "44", "series": "12", "type": "subscribe"}},
			},
		})
	}))
	defer srv.Close()

	automations, err := New().ListAutomations(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(automations) != 1 {
		t.Fatalf("automations len = %d", len(automations))
	}
	if automations[0].Status != "draft" || len(automations[0].Triggers) != 0 {
		t.Fatalf("automation became executable: %+v", automations[0])
	}
	if !strings.Contains(automations[0].SourceDefinition, `"triggerType":"subscribes"`) ||
		!strings.Contains(automations[0].SourceDefinition, `"entered":"42"`) ||
		!strings.Contains(automations[0].SourceDefinition, `"starts":[{"id":"44","series":"12","type":"subscribe"}]`) {
		t.Fatalf("source definition lost raw provider fields: %s", automations[0].SourceDefinition)
	}
}

func TestListAutomationsUsesProviderTotalForShortPages(t *testing.T) {
	seenOffsets := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/3/automations/") {
			writeJSON(t, w, map[string]any{"items": []any{}})
			return
		}
		if r.URL.Path != "/api/3/automations" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		offset := r.URL.Query().Get("offset")
		seenOffsets = append(seenOffsets, offset)
		switch offset {
		case "0":
			writeJSON(t, w, map[string]any{
				"automations": []any{map[string]any{"id": "12", "name": "Revenue", "status": "active"}},
				"meta":        map[string]any{"total": 2},
			})
		case "1":
			writeJSON(t, w, map[string]any{
				"automations": []any{map[string]any{"id": "13", "name": "Winback", "status": "inactive"}},
				"meta":        map[string]any{"total": 2},
			})
		default:
			t.Fatalf("automation offset = %q", offset)
		}
	}))
	defer srv.Close()

	automations, err := New().ListAutomations(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(automations) != 2 {
		t.Fatalf("automations len = %d, want 2", len(automations))
	}
	if got := fmt.Sprint(seenOffsets); got != "[0 1]" {
		t.Fatalf("offsets = %s, want [0 1]", got)
	}
}

func TestListSourceEventsPollsUpdatedContacts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("filters[updated_after]"); got != "2026-05-11" {
				t.Fatalf("updated_after = %q", got)
			}
			if got := r.URL.Query().Get("filters[updated_before]"); got != "2026-05-13" {
				t.Fatalf("updated_before = %q", got)
			}
			if got := r.URL.Query().Get("orders[udate]"); got != "" {
				t.Fatalf("undocumented orders[udate] must be absent, got %q", got)
			}
			if got := r.URL.Query().Get("orders[id]"); got != "ASC" {
				t.Fatalf("orders[id] = %q", got)
			}
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "Ada@Example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":      map[string]any{"id": "42", "email": "Ada@Example.com", "firstName": "Ada", "lastName": "Lovelace", "phone": "+15551234567", "udate": "2026-05-12T11:00:00Z"},
				"contactLists": []any{map[string]any{"id": "9", "list": "7", "status": "1"}},
				"contactTags":  []any{map[string]any{"id": "11", "contact": "42", "tag": "3", "created_timestamp": "2026-05-12T11:05:00Z"}},
				"fieldValues":  []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth", "updated_timestamp": "2026-05-12T11:06:00Z"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	batch, err := ad.ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 1 {
		t.Fatalf("events len = %d", len(batch.Events))
	}
	event := batch.Events[0]
	if event.Action != "upsert" || event.ResourceType != "subscriber" || event.Subscriber == nil {
		t.Fatalf("bad event: %#v", event)
	}
	if !strings.HasPrefix(event.SourceID, "activecampaign:contact:42:2026-05-12T11:00:00Z:") {
		t.Fatalf("source id = %q", event.SourceID)
	}
	if event.Subscriber.Email != "ada@example.com" || event.Subscriber.CustomFields["plan"] != "Growth" {
		t.Fatalf("bad subscriber projection: %#v", event.Subscriber)
	}
	contactTags := interfaceMapSliceField(t, *event.Subscriber, "activecampaign_contact_tags")
	if len(contactTags) != 1 ||
		sourceMapString(contactTags[0], "tag_id") != "3" ||
		sourceMapString(contactTags[0], "tag_name") != "Customer" ||
		sourceMapString(contactTags[0], "created_timestamp") != "2026-05-12T11:05:00Z" {
		t.Fatalf("contact tag evidence = %#v, want source-event raw provider fields and normalized aliases", contactTags)
	}
	fieldValues := interfaceMapSliceField(t, *event.Subscriber, "activecampaign_field_values")
	if len(fieldValues) != 1 ||
		sourceMapString(fieldValues[0], "field_id") != "10" ||
		sourceMapString(fieldValues[0], "field_name") != "Plan" ||
		sourceMapString(fieldValues[0], "field_key") != "plan" ||
		sourceMapString(fieldValues[0], "updated_timestamp") != "2026-05-12T11:06:00Z" {
		t.Fatalf("field value evidence = %#v, want source-event raw provider fields and normalized aliases", fieldValues)
	}
	if event.Payload["projection_hash"] == "" {
		t.Fatalf("projection hash missing from payload: %#v", event.Payload)
	}
	if batch.HighWatermark.Format("2006-01-02T15:04:05Z") != "2026-05-12T12:00:00Z" {
		t.Fatalf("high watermark = %s", batch.HighWatermark.Format(time.RFC3339))
	}
}

func TestListSourceEventsPreservesUnknownContactAttributes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{
					"id":     "42",
					"email":  "ada@example.com",
					"udate":  "2026-05-12T11:00:00Z",
					"ip4Sub": "203.0.113.10",
				}},
				"meta": map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{
					"id":          "42",
					"email":       "ada@example.com",
					"udate":       "2026-05-12T11:00:00Z",
					"scoreValues": []any{map[string]any{"score": 73, "label": "engaged"}},
				},
				"contactLists": []any{},
				"contactTags":  []any{},
				"fieldValues":  []any{},
				"deals": []any{
					map[string]any{"id": "deal_2", "title": "Expansion", "status": "1", "value": "200", "contact": "42", "probability": "80"},
					map[string]any{"id": "deal_1", "title": "New business", "status": "1", "value": "100", "contact": "42", "custom_field": "new-business-risk"},
				},
				"activities": []any{
					map[string]any{"id": "act_2", "type": "click", "tstamp": "2026-05-12T12:00:00Z"},
					map[string]any{"id": "act_1", "type": "open", "tstamp": "2026-05-12T11:00:00Z"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	batch, err := New().ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 1 || batch.Events[0].Subscriber == nil {
		t.Fatalf("events = %#v, want one subscriber event", batch.Events)
	}
	attrs := interfaceMapField(t, *batch.Events[0].Subscriber, "activecampaign_contact_attributes")
	if attrs["ip4Sub"] != "203.0.113.10" {
		t.Fatalf("ip4Sub = %#v, want summary-only attribute preserved", attrs["ip4Sub"])
	}
	if _, ok := attrs["scoreValues"].([]interface{}); !ok {
		t.Fatalf("scoreValues = %T %#v, want raw provider array", attrs["scoreValues"], attrs["scoreValues"])
	}
	deals := interfaceMapSliceField(t, *batch.Events[0].Subscriber, "activecampaign_deals")
	if len(deals) != 2 || sourceMapString(deals[0], "id") != "deal_1" || sourceMapString(deals[1], "id") != "deal_2" {
		t.Fatalf("deals = %#v, want stable sorted deal evidence", deals)
	}
	if sourceMapString(deals[0], "custom_field") != "new-business-risk" || sourceMapString(deals[1], "probability") != "80" {
		t.Fatalf("deal raw fields = %#v, want provider-only fields preserved", deals)
	}
	activities := interfaceMapSliceField(t, *batch.Events[0].Subscriber, "activecampaign_contact_activities")
	if len(activities) != 2 || activities[0]["id"] != "act_1" || activities[1]["id"] != "act_2" {
		t.Fatalf("activities = %#v, want stable sorted activity evidence", activities)
	}
}

func TestListSourceEventsUsesProjectionHashForSameSecondUpdates(t *testing.T) {
	detailValue := "Growth"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"},
				"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": detailValue}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	first, err := ad.ListSourceEvents(context.Background(), sess, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	detailValue = "Enterprise"
	second, err := ad.ListSourceEvents(context.Background(), sess, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 1 || len(second.Events) != 1 {
		t.Fatalf("event counts = %d/%d, want 1/1", len(first.Events), len(second.Events))
	}
	if first.Events[0].SourceID == second.Events[0].SourceID {
		t.Fatalf("same-second source event ids matched: %q", first.Events[0].SourceID)
	}
	if first.Events[0].Payload["projection_hash"] == second.Events[0].Payload["projection_hash"] {
		t.Fatalf("projection hashes matched: %#v / %#v", first.Events[0].Payload, second.Events[0].Payload)
	}
	if second.Events[0].Subscriber.CustomFields["plan"] != "Enterprise" {
		t.Fatalf("second projection = %#v", second.Events[0].Subscriber.CustomFields)
	}
}

func TestListSourceEventsUsesProviderTotalForShortPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("limit"); got != "2" {
				t.Fatalf("limit = %q, want 2", got)
			}
			if got := r.URL.Query().Get("offset"); got != "" {
				t.Fatalf("mutable offset pagination must be absent, got %q", got)
			}
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "Ada@Example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 3},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "42", "email": "Ada@Example.com", "udate": "2026-05-12T11:00:00Z"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	since := mustParseTime(t, "2026-05-12T10:00:00Z")
	batch, err := ad.ListSourceEvents(context.Background(), sess, since, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := ad.newOrResumeDeltaCursor(sess, since, batch.NextCursor)
	if err != nil {
		t.Fatalf("parse next cursor %q: %v", batch.NextCursor, err)
	}
	if cursor.LastContactID != 42 || cursor.UpperBound.Format(time.RFC3339) != "2026-05-12T12:00:00Z" {
		t.Fatalf("fixed-window cursor = %+v", cursor)
	}
}

func TestListSourceEventsFailsWhenNextPageMovesBackwards(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("id_greater"); got != "42" {
				t.Fatalf("id_greater = %q, want 42", got)
			}
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "41", "email": "late-page@example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 2},
			})
		case "/api/3/contacts/41":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "41", "email": "late-page@example.com", "udate": "2026-05-12T11:00:00Z"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	sess := adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}
	since := mustParseTime(t, "2026-05-12T10:00:00Z")
	window, err := ad.newOrResumeDeltaCursor(sess, since, "")
	if err != nil {
		t.Fatal(err)
	}
	window.LastContactID = 42
	cursor, err := formatActiveCampaignDeltaCursor(window)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ad.ListSourceEvents(context.Background(), sess, since, cursor, 2)
	if err == nil || !strings.Contains(err.Error(), "did not advance fixed-window ID pagination") {
		t.Fatalf("err = %v, want ID pagination guard", err)
	}
}

func TestFixedWindowSourceEventCursorRejectsLegacyOffsets(t *testing.T) {
	for _, raw := range []string{"7", "offset:7"} {
		t.Run(raw, func(t *testing.T) {
			_, err := New().newOrResumeDeltaCursor(activeCampaignTestSession("http://127.0.0.1:1"), time.Time{}, raw)
			if err == nil {
				t.Fatalf("legacy cursor %q unexpectedly accepted", raw)
			}
		})
	}
}

func TestListSourceEventsOmitsUpdatedAfterForInitialReplay(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("filters[updated_after]"); got != "" {
				t.Fatalf("updated_after = %q, want empty for initial replay", got)
			}
			if got := r.URL.Query().Get("filters[updated_before]"); got != "2026-05-13" {
				t.Fatalf("updated_before = %q, want conservative date-only upper bound", got)
			}
			writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": 0}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	_, err := ad.ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, time.Time{}, "", 100)
	if err != nil {
		t.Fatalf("ListSourceEvents: %v", err)
	}
}

func TestListSourceEventsFailsWhenContactTimestampMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "42", "email": "ada@example.com"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, err := New().ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err == nil || !strings.Contains(err.Error(), "contact 42 missing provider update timestamp for source event") {
		t.Fatalf("err = %v, want missing timestamp failure", err)
	}
}

func TestListSourceEventsSkipsContactTimestampPrecedingReplayWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			if got := r.URL.Query().Get("filters[updated_after]"); got != "2026-05-11" {
				t.Fatalf("updated_after = %q", got)
			}
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-01-01T00:00:00Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact": map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-01-01T00:00:00Z"},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	batch, err := ad.ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 0 || batch.NextCursor != "" {
		t.Fatalf("batch = %#v, want stale conservative-bound candidate skipped and window closed", batch)
	}
	if got := batch.HighWatermark.Format(time.RFC3339); got != "2026-05-12T12:00:00Z" {
		t.Fatalf("high watermark = %s", got)
	}
}

func TestListSourceEventsRequiresFieldAndTagMetadata(t *testing.T) {
	for _, tc := range []struct {
		name     string
		failPath string
		wantErr  string
	}{
		{
			name:     "field metadata",
			failPath: "/api/3/fields",
			wantErr:  "load custom field metadata",
		},
		{
			name:     "tag metadata",
			failPath: "/api/3/tags",
			wantErr:  "load tag metadata",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/3/fields":
					if r.URL.Path == tc.failPath {
						http.Error(w, `{"message":"fields unavailable"}`, http.StatusForbidden)
						return
					}
					writeJSON(t, w, map[string]any{"fields": []any{}})
				case "/api/3/tags":
					if r.URL.Path == tc.failPath {
						http.Error(w, `{"message":"tags unavailable"}`, http.StatusForbidden)
						return
					}
					writeJSON(t, w, map[string]any{"tags": []any{}})
				case "/api/3/contacts":
					t.Fatalf("contacts should not be polled before metadata is available")
				default:
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
			}))
			defer srv.Close()

			_, err := New().ListSourceEvents(context.Background(), adapter.Session{
				AccessToken: "secret",
				Source:      canonical.SourceActiveCampaign,
				Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
			}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestListSourceEventsUsesStableFallbackNamesForNamelessMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"},
				"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": "3"}},
				"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": "10", "value": "Growth"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	batch, err := New().ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 1 || batch.Events[0].Subscriber == nil {
		t.Fatalf("events = %#v, want one subscriber event", batch.Events)
	}
	sub := batch.Events[0].Subscriber
	if sub.CustomFields["activecampaign_field_10"] != "Growth" {
		t.Fatalf("custom fields = %#v, want fallback field key", sub.CustomFields)
	}
	if fmt.Sprint(sub.Tags) != "[activecampaign_tag:3]" {
		t.Fatalf("tags = %#v, want fallback tag", sub.Tags)
	}
}

func TestListSourceEventsPreservesContactReferencesWhenMetadataListIsIncomplete(t *testing.T) {
	for _, tc := range []struct {
		name      string
		fieldID   string
		tagID     string
		wantField string
		wantTag   string
	}{
		{
			name:      "unknown custom field",
			fieldID:   "999",
			tagID:     "3",
			wantField: "activecampaign_field_999",
			wantTag:   "Customer",
		},
		{
			name:      "unknown tag",
			fieldID:   "10",
			tagID:     "999",
			wantField: "plan",
			wantTag:   "activecampaign_tag:999",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/3/fields":
					writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
				case "/api/3/tags":
					writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
				case "/api/3/contacts":
					writeJSON(t, w, map[string]any{
						"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"}},
						"meta":     map[string]any{"total": 1},
					})
				case "/api/3/contacts/42":
					writeJSON(t, w, map[string]any{
						"contact":     map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"},
						"contactTags": []any{map[string]any{"id": "11", "contact": "42", "tag": tc.tagID}},
						"fieldValues": []any{map[string]any{"id": "99", "contact": "42", "field": tc.fieldID, "value": "Growth"}},
					})
				default:
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
			}))
			defer srv.Close()

			batch, err := New().ListSourceEvents(context.Background(), adapter.Session{
				AccessToken: "secret",
				Source:      canonical.SourceActiveCampaign,
				Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
			}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
			if err != nil {
				t.Fatal(err)
			}
			if len(batch.Events) != 1 || batch.Events[0].Subscriber == nil {
				t.Fatalf("events = %#v, want one subscriber event", batch.Events)
			}
			sub := batch.Events[0].Subscriber
			if sub.CustomFields[tc.wantField] != "Growth" {
				t.Fatalf("custom fields = %#v, want %s fallback to preserve Growth", sub.CustomFields, tc.wantField)
			}
			if fmt.Sprint(sub.Tags) != "["+tc.wantTag+"]" {
				t.Fatalf("tags = %#v, want [%s]", sub.Tags, tc.wantTag)
			}
		})
	}
}

func TestListSourceEventsPreservesMalformedRelationshipRowsWhenStableIDsExist(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "Customer"}}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			writeJSON(t, w, map[string]any{
				"contact":     map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"},
				"contactTags": []any{map[string]any{"id": "ct_11", "contact": "42", "source": "legacy-import"}},
				"fieldValues": []any{map[string]any{"id": "fv_99", "contact": "42", "value": "Growth", "source": "legacy-import"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	batch, err := New().ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 1 || batch.Events[0].Subscriber == nil {
		t.Fatalf("events = %#v, want one subscriber event", batch.Events)
	}
	sub := batch.Events[0].Subscriber
	unmappedFields := interfaceMapSliceField(t, *sub, "activecampaign_unmapped_field_values")
	if len(unmappedFields) != 1 {
		t.Fatalf("unmapped field values = %#v, want one preserved row", unmappedFields)
	}
	if sourceMapString(unmappedFields[0], "id") != "fv_99" ||
		sourceMapString(unmappedFields[0], "value") != "Growth" ||
		sourceMapString(unmappedFields[0], "source") != "legacy-import" ||
		sourceMapString(unmappedFields[0], "reason") != "missing_custom_field_id" {
		t.Fatalf("unmapped field value = %#v", unmappedFields[0])
	}
	unmappedTags := interfaceMapSliceField(t, *sub, "activecampaign_unmapped_contact_tags")
	if len(unmappedTags) != 1 {
		t.Fatalf("unmapped contact tags = %#v, want one preserved row", unmappedTags)
	}
	if sourceMapString(unmappedTags[0], "id") != "ct_11" ||
		sourceMapString(unmappedTags[0], "source") != "legacy-import" ||
		sourceMapString(unmappedTags[0], "reason") != "missing_tag_id" {
		t.Fatalf("unmapped contact tag = %#v", unmappedTags[0])
	}
	if len(sub.Tags) != 0 {
		t.Fatalf("tags = %#v, malformed tag relationship should not become executable tag", sub.Tags)
	}
}

func TestListSourceEventsFailsWhenContactDetailUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{
				"contacts": []any{map[string]any{"id": "42", "email": "ada@example.com", "udate": "2026-05-12T11:00:00Z"}},
				"meta":     map[string]any{"total": 1},
			})
		case "/api/3/contacts/42":
			http.Error(w, `{"message":"detail unavailable"}`, http.StatusBadGateway)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, err := New().ListSourceEvents(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, mustParseTime(t, "2026-05-12T10:00:00Z"), "", 100)
	if err == nil || !strings.Contains(err.Error(), "fetch contact detail 42") {
		t.Fatalf("err = %v, want contact-detail fetch failure", err)
	}
}

func TestDiscoverCountsActiveCampaignParitySurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": "12"}})
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{
				map[string]any{"id": "10", "title": "Plan"},
				map[string]any{"id": "11", "title": "Region"},
			}, "meta": map[string]any{"total": 2}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{}, "meta": map[string]any{"total": 14}})
		case "/api/3/lists":
			writeJSON(t, w, map[string]any{"lists": []any{
				map[string]any{"id": "1"}, map[string]any{"id": "2"}, map[string]any{"id": "3"},
			}, "meta": map[string]any{"total": 3}})
		case "/api/3/audiences":
			writeJSON(t, w, map[string]any{"data": []any{
				map[string]any{"id": "12", "attributes": map[string]any{"segment_id": "12", "name": "High intent"}},
				map[string]any{"id": "13", "attributes": map[string]any{"segment_id": "13", "name": "Recent buyers"}},
			}})
		case "/api/3/segmentsV2/12":
			writeJSON(t, w, map[string]any{"data": map[string]any{"id": "12", "attributes": map[string]any{"name": "High intent"}}})
		case "/api/3/segmentsV2/13":
			writeJSON(t, w, map[string]any{"data": map[string]any{"id": "13", "attributes": map[string]any{"name": "Recent buyers"}}})
		case "/api/3/automations":
			writeJSON(t, w, map[string]any{"automations": []any{}, "meta": map[string]any{"total": 4}})
		case "/api/3/campaigns":
			writeJSON(t, w, map[string]any{"campaigns": []any{
				map[string]any{"id": "draft_1", "name": "Draft", "status": "0", "sdate": nil},
				map[string]any{"id": "sent_1", "name": "Sent", "status": "5", "sdate": "2026-05-12T10:00:00Z"},
			}, "meta": map[string]any{"total": 2}})
		case "/api/3/messages":
			writeJSON(t, w, map[string]any{"messages": []any{}, "meta": map[string]any{"total": 6}})
		case "/api/3/forms":
			writeJSON(t, w, map[string]any{"forms": []any{}, "meta": map[string]any{"total": 7}})
		case "/api/3/deals":
			writeJSON(t, w, map[string]any{"deals": []any{}, "meta": map[string]any{"total": 8}})
		case "/api/3/dealGroups":
			writeJSON(t, w, map[string]any{"dealGroups": []any{}, "meta": map[string]any{"total": 9}})
		case "/api/3/customObjects/schemas":
			writeJSON(t, w, map[string]any{"schemas": []any{}, "meta": map[string]any{"total": 10}})
		case "/api/3/ecomOrders":
			writeJSON(t, w, map[string]any{"ecomOrders": []any{}, "meta": map[string]any{"total": 11}})
		case "/api/3/sms/broadcasts":
			writeJSON(t, w, map[string]any{"broadcasts": []any{}, "meta": map[string]any{"total": 13}})
		case "/api/3/sms/lists":
			writeJSON(t, w, map[string]any{"lists": []any{}, "meta": map[string]any{"total": 0}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	ad := New()
	ad.loadListChannelsForTests = true
	rep, err := ad.Discover(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.SubscribersTotal != 12 || rep.SegmentsTotal != 5 || rep.ArchiveTotal != 1 {
		t.Fatalf("unexpected core counts: %#v", rep)
	}
	if rep.CRMTotal != 17 || rep.CustomObjectsTotal != 10 || rep.EcommerceTotal != 11 {
		t.Fatalf("unexpected parity counts: %#v", rep)
	}
	if rep.SMSCampaignsTotal != 13 {
		t.Fatalf("SMSCampaignsTotal = %d, want 13", rep.SMSCampaignsTotal)
	}
	if fmt.Sprint(rep.CustomFields) != "[Plan Region]" {
		t.Fatalf("CustomFields = %#v, want field metadata names", rep.CustomFields)
	}
	if len(rep.Warnings) != 0 {
		t.Fatalf("warnings = %#v, complete optional inventories should pass strict discovery", rep.Warnings)
	}
}

func TestCountSentCampaignsUsesProviderTotalForShortPages(t *testing.T) {
	seenOffsets := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/campaigns" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		offset := r.URL.Query().Get("offset")
		seenOffsets = append(seenOffsets, offset)
		switch offset {
		case "0":
			writeJSON(t, w, map[string]any{
				"campaigns": []any{map[string]any{"id": "sent_1", "status": "5", "sdate": "2026-05-12T10:00:00Z"}},
				"meta":      map[string]any{"total": 2},
			})
		case "1":
			writeJSON(t, w, map[string]any{
				"campaigns": []any{map[string]any{"id": "draft_1", "status": "0"}},
				"meta":      map[string]any{"total": 2},
			})
		default:
			t.Fatalf("campaign offset = %q", offset)
		}
	}))
	defer srv.Close()

	total, err := New().countSentCampaigns(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 {
		t.Fatalf("sent total = %d, want 1", total)
	}
	if got := fmt.Sprint(seenOffsets); got != "[0 1]" {
		t.Fatalf("offsets = %s, want [0 1]", got)
	}
}

func TestDiscoverWarnsWhenOptionalCountsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/3/contacts" {
			writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": 12}})
			return
		}
		http.Error(w, `{"message":"plan does not expose this endpoint"}`, http.StatusForbidden)
	}))
	defer srv.Close()

	rep, err := New().Discover(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.SubscribersTotal != 12 {
		t.Fatalf("SubscribersTotal = %d, want 12", rep.SubscribersTotal)
	}
	if rep.FormsTotal != 0 || rep.CustomObjectsTotal != 0 || rep.SMSCampaignsTotal != 0 {
		t.Fatalf("optional inaccessible totals should be zero: %#v", rep)
	}
	assertWarningContains(t, rep.Warnings, "forms count unavailable")
	assertWarningContains(t, rep.Warnings, "custom fields count unavailable")
	assertWarningContains(t, rep.Warnings, "custom object schemas count unavailable")
	assertWarningContains(t, rep.Warnings, "sent SMS broadcasts count unavailable")
}

func TestDiscoverFailsWhenContactCountUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/contacts" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		http.Error(w, `{"message":"bad token"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	_, err := New().Discover(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err == nil || !strings.Contains(err.Error(), "discover contacts") {
		t.Fatalf("err = %v, want contact discovery failure", err)
	}
}

func TestDiscoverFailsWhenContactCountPayloadMalformed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/contacts" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"contacts": map[string]any{"id": "42"}})
	}))
	defer srv.Close()

	_, err := New().Discover(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err == nil || !strings.Contains(err.Error(), "discover contacts") || !strings.Contains(err.Error(), `decode "contacts" array`) {
		t.Fatalf("err = %v, want malformed contact discovery failure", err)
	}
}

func TestDiscoverWarnsWhenOptionalCountPayloadMalformed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": 12}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": map[string]any{"id": "tag_1"}})
		case "/api/3/audiences":
			writeJSON(t, w, map[string]any{"data": []any{}})
		default:
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 0}})
		}
	}))
	defer srv.Close()

	rep, err := New().Discover(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.GroupsTotal != 0 {
		t.Fatalf("GroupsTotal = %d, want 0", rep.GroupsTotal)
	}
	if len(rep.Warnings) != 2 {
		t.Fatalf("warnings = %#v, want one optional payload warning and one channel warning", rep.Warnings)
	}
	assertWarningContains(t, rep.Warnings, `tags count unavailable: decode "tags" array`)
}

func TestDiscoverWarnsWhenSentCampaignCountPayloadMalformed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": 12}})
		case "/api/3/campaigns":
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
		case "/api/3/audiences":
			writeJSON(t, w, map[string]any{"data": []any{}})
		default:
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 0}})
		}
	}))
	defer srv.Close()

	rep, err := New().Discover(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.ArchiveTotal != 0 || rep.CampaignsTotal != 0 || rep.ReportsTotal != 0 {
		t.Fatalf("campaign totals should be zero when payload is unreadable: %#v", rep)
	}
	if len(rep.Warnings) != 2 {
		t.Fatalf("warnings = %#v, want one campaign payload warning and one channel warning", rep.Warnings)
	}
	assertWarningContains(t, rep.Warnings, `campaigns count unavailable: response missing "campaigns" array`)
}

func TestListSegmentsPreservesListsAndSavedSegmentDefinitions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/lists":
			writeJSON(t, w, map[string]any{"lists": []any{map[string]any{
				"id": "7", "name": "Customers", "subscriber_count": "42", "sender_addr1": "1 Main St",
			}}})
		case "/api/3/audiences":
			writeJSON(t, w, map[string]any{"data": []any{map[string]any{
				"id": "12", "type": "Segment", "attributes": map[string]any{"segment_id": "12", "name": "High intent"},
			}}})
		case "/api/3/segmentsV2/12":
			writeJSON(t, w, map[string]any{"data": map[string]any{
				"id": "12", "type": "Segment.v2", "attributes": map[string]any{
					"name": "High intent", "seriesid": "series_9", "hidden": "0",
					"segment_condition_group_operator": "AND",
					"segment_condition_groups":         []any{},
					"segment_conditions":               []any{map[string]any{"object_type": "contact", "fields": []any{}}},
				},
			}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	segments, err := New().ListSegments(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 2 {
		t.Fatalf("segments len = %d", len(segments))
	}
	if segments[0].QueryAST.Field != "tag" || segments[0].QueryAST.Value != "list:7" {
		t.Fatalf("bad list segment: %#v", segments[0])
	}
	if !strings.Contains(segments[0].SourceDefinition, `"subscriber_count":"42"`) ||
		!strings.Contains(segments[0].SourceDefinition, `"sender_addr1":"1 Main St"`) {
		t.Fatalf("list source definition lost raw provider fields: %s", segments[0].SourceDefinition)
	}
	if segments[1].SourceDefinition == "" ||
		segments[1].QueryAST.Op != "activecampaign_saved_segment_review" ||
		!strings.Contains(segments[1].Description, "could not be translated") {
		t.Fatalf("saved segment should be preserved for review: %#v", segments[1])
	}
	if !strings.Contains(segments[1].SourceDefinition, `"seriesid":"series_9"`) ||
		!strings.Contains(segments[1].SourceDefinition, `"hidden":"0"`) {
		t.Fatalf("saved segment source definition lost raw provider fields: %s", segments[1].SourceDefinition)
	}
}

func TestListSegmentsUsesProviderTotalForShortListPages(t *testing.T) {
	seenOffsets := map[string][]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/lists":
			offset := r.URL.Query().Get("offset")
			seenOffsets["lists"] = append(seenOffsets["lists"], offset)
			switch offset {
			case "0":
				writeJSON(t, w, map[string]any{
					"lists": []any{map[string]any{"id": "7", "name": "Customers"}},
					"meta":  map[string]any{"total": 2},
				})
			case "1":
				writeJSON(t, w, map[string]any{
					"lists": []any{map[string]any{"id": "8", "name": "Leads"}},
					"meta":  map[string]any{"total": 2},
				})
			default:
				t.Fatalf("lists offset = %q", offset)
			}
		case "/api/3/audiences":
			seenOffsets["audiences"] = append(seenOffsets["audiences"], r.URL.Query().Get("page"))
			writeJSON(t, w, map[string]any{"data": []any{map[string]any{"id": "12", "attributes": map[string]any{"segment_id": "12", "name": "High intent"}}}})
		case "/api/3/segmentsV2/12":
			writeJSON(t, w, map[string]any{"data": map[string]any{"id": "12", "attributes": map[string]any{"name": "High intent"}}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	segments, err := New().ListSegments(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 3 {
		t.Fatalf("segments len = %d, want two lists and one saved segment", len(segments))
	}
	if got := fmt.Sprint(seenOffsets["lists"]); got != "[0 1]" {
		t.Fatalf("list offsets = %s, want [0 1]", got)
	}
	if got := fmt.Sprint(seenOffsets["audiences"]); got != "[1]" {
		t.Fatalf("audience pages = %s, want [1]", got)
	}
}

func TestListSegmentsFailsWhenListPagePayloadMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/lists":
			writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
		case "/api/3/audiences":
			t.Fatalf("saved segments should not be requested after malformed list payload")
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, err := New().ListSegments(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err == nil || !strings.Contains(err.Error(), `response missing "lists" array`) {
		t.Fatalf("err = %v, want malformed list payload failure", err)
	}
}

func TestListSegmentsFailsWhenSavedSegmentsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/lists":
			writeJSON(t, w, map[string]any{"lists": []any{map[string]any{"id": "7", "name": "Customers"}}})
		case "/api/3/audiences":
			http.Error(w, `{"message":"segments unavailable"}`, http.StatusForbidden)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, err := New().ListSegments(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	})
	if err == nil || !strings.Contains(err.Error(), "list saved segments") {
		t.Fatalf("err = %v, want saved-segment failure", err)
	}
}

func TestListCampaignArchiveMapsEngagementMetrics(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/campaigns":
			writeJSON(t, w, map[string]any{"campaigns": []any{map[string]any{
				"id": "99", "name": "Launch", "status": "5", "sdate": "2026-05-12T10:00:00Z", "message_id": "9",
				"send_amt": "100", "uniqueopens": "45", "linkclicks": "12", "segmentid": "seg_7", "analytics": map[string]any{"revenue": 1250},
			}}})
		case "/api/3/campaigns/99":
			writeJSON(t, w, map[string]any{"campaign": map[string]any{
				"id": "99", "name": "Launch", "status": "5", "sdate": "2026-05-12T10:00:00Z", "message_id": "9",
				"send_amt": "100", "uniqueopens": "45", "linkclicks": "12", "segmentid": "seg_7", "analytics": map[string]any{"revenue": 1250},
			}})
		case "/api/3/messages/9":
			writeJSON(t, w, map[string]any{"message": map[string]any{"id": "9", "subject": "We shipped", "html": "<h1>Launch</h1>", "text": "Launch"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	archive, next, err := New().ListCampaignArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "" || len(archive) != 1 {
		t.Fatalf("archive len=%d next=%q", len(archive), next)
	}
	item := archive[0]
	if item.Subject != "We shipped" || item.RecipientsCount != 100 || item.Opens != 45 || item.Clicks != 12 {
		t.Fatalf("bad archive mapping: %#v", item)
	}
	if len(item.Warnings) != 0 {
		t.Fatalf("warnings = %#v", item.Warnings)
	}
	attrs := campaignReportAttributes(t, item)
	campaign, ok := attrs["campaign"].(map[string]interface{})
	if !ok || campaign["segmentid"] != "seg_7" {
		t.Fatalf("campaign attributes = %#v, want raw segmentid", attrs)
	}
	if _, ok := campaign["analytics"].(map[string]interface{}); !ok {
		t.Fatalf("analytics = %T %#v, want raw campaign object", campaign["analytics"], campaign["analytics"])
	}
	if _, ok := attrs["message"].(map[string]interface{}); !ok {
		t.Fatalf("message content was not preserved: %#v", attrs)
	}
}

func TestListCampaignArchiveSkipsDraftCampaigns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/campaigns":
			writeJSON(t, w, map[string]any{"campaigns": []any{
				map[string]any{"id": "draft_1", "name": "Draft", "status": "0", "cdate": "2026-05-01T10:00:00Z"},
				map[string]any{"id": "scheduled_1", "name": "Scheduled", "status": "scheduled", "scheduleddate": "2026-05-20T10:00:00Z"},
				map[string]any{"id": "sent_1", "name": "Sent", "status": "5", "sdate": "2026-05-12T10:00:00Z", "message_id": "9"},
			}})
		case "/api/3/campaigns/sent_1":
			writeJSON(t, w, map[string]any{"campaign": map[string]any{"id": "sent_1", "name": "Sent", "status": "5", "sdate": "2026-05-12T10:00:00Z", "message_id": "9"}})
		case "/api/3/messages/9":
			writeJSON(t, w, map[string]any{"message": map[string]any{"id": "9", "subject": "Sent", "text": "Sent body"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	archive, next, err := New().ListCampaignArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "" || len(archive) != 1 {
		t.Fatalf("archive len=%d next=%q", len(archive), next)
	}
	if archive[0].SourceID != "sent_1" {
		t.Fatalf("source id = %q, want sent_1", archive[0].SourceID)
	}
}

func TestListCampaignArchiveUsesProviderTotalForShortPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/campaigns":
			if got := r.URL.Query().Get("offset"); got != "0" {
				t.Fatalf("offset = %q, want 0", got)
			}
			writeJSON(t, w, map[string]any{
				"campaigns": []any{map[string]any{"id": "sent_1", "name": "Sent", "status": "5", "sdate": "2026-05-12T10:00:00Z", "message_id": "9"}},
				"meta":      map[string]any{"total": 3},
			})
		case "/api/3/campaigns/sent_1":
			writeJSON(t, w, map[string]any{"campaign": map[string]any{"id": "sent_1", "name": "Sent", "status": "5", "sdate": "2026-05-12T10:00:00Z", "message_id": "9"}})
		case "/api/3/messages/9":
			writeJSON(t, w, map[string]any{"message": map[string]any{"id": "9", "subject": "Sent", "text": "Sent body"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	archive, next, err := New().ListCampaignArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(archive) != 1 || archive[0].SourceID != "sent_1" {
		t.Fatalf("archive = %#v, want sent campaign", archive)
	}
	if next != "1" {
		t.Fatalf("next = %q, want 1", next)
	}
}

func TestListCampaignArchiveFailsWhenCampaignPagePayloadMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/campaigns" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
	}))
	defer srv.Close()

	_, _, err := New().ListCampaignArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), `response missing "campaigns" array`) {
		t.Fatalf("err = %v, want malformed campaign payload failure", err)
	}
}

func TestListCampaignArchiveFailsClosedWhenRenderedContentMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/campaigns":
			writeJSON(t, w, map[string]any{"campaigns": []any{map[string]any{"id": "99", "name": "Launch", "status": "5", "message_id": "9"}}})
		case "/api/3/campaigns/99":
			writeJSON(t, w, map[string]any{"campaign": map[string]any{"id": "99", "name": "Launch", "status": "5", "message_id": "9"}})
		case "/api/3/messages/9":
			writeJSON(t, w, map[string]any{"message": map[string]any{"id": "9", "subject": "Launch"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	_, _, err := New().ListCampaignArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), "no rendered content") {
		t.Fatalf("error = %v, want rendered-content completeness failure", err)
	}
}

func TestListCampaignArchiveFailsWhenSourceIDMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/campaigns" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"campaigns": []any{map[string]any{
			"name": "Launch", "status": "5",
		}}})
	}))
	defer srv.Close()

	_, _, err := New().ListCampaignArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err == nil || !strings.Contains(err.Error(), "campaign archive item missing source id") {
		t.Fatalf("err = %v, want missing source id failure", err)
	}
}

func TestListSourceArchivePreservesDealsAndPipelines(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/deals":
			writeJSON(t, w, map[string]any{"deals": []any{map[string]any{
				"id": "d1", "title": "Expansion", "status": "1", "value": "250000", "currency": "USD", "contact": "42", "udate": "2026-05-12T10:00:00Z", "custom_field": "expansion-risk", "probability": "80",
			}}})
		case "/api/3/dealGroups":
			writeJSON(t, w, map[string]any{"dealGroups": []any{map[string]any{
				"id": "p1", "title": "Sales pipeline", "currency": "USD", "udate": "2026-05-12T11:00:00Z", "deal_count": "3", "is_default": "1",
			}}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
	deals, next, err := ad.ListSourceArchive(context.Background(), sess, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(deals) != 1 || deals[0].ResourceType != "crm_deal" || deals[0].LinkedContactID != "42" {
		t.Fatalf("bad deal archive: %#v next=%q", deals, next)
	}
	if sourceMapString(deals[0].Payload, "custom_field") != "expansion-risk" || sourceMapString(deals[0].Payload, "probability") != "80" {
		t.Fatalf("deal raw payload not preserved: %#v", deals[0].Payload)
	}
	pipelines, next, err := ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	if next != "fields:0" || len(pipelines) != 1 || pipelines[0].ResourceType != "crm_pipeline" {
		t.Fatalf("bad pipeline archive: %#v next=%q", pipelines, next)
	}
	if sourceMapString(pipelines[0].Payload, "deal_count") != "3" || sourceMapString(pipelines[0].Payload, "is_default") != "1" {
		t.Fatalf("pipeline raw payload not preserved: %#v", pipelines[0].Payload)
	}
}

func TestListSourceArchiveUsesStablePayloadHashWhenCRMSourceIDMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/deals":
			writeJSON(t, w, map[string]any{"deals": []any{map[string]any{
				"title": "Expansion", "status": "1", "value": "250000", "currency": "USD", "contact": "42", "udate": "2026-05-12T10:00:00Z", "custom_field": "expansion-risk",
			}}})
		case "/api/3/dealGroups":
			writeJSON(t, w, map[string]any{"dealGroups": []any{map[string]any{
				"title": "Sales pipeline", "currency": "USD", "udate": "2026-05-12T11:00:00Z", "deal_count": "3",
			}}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
	firstDeals, next, err := ad.ListSourceArchive(context.Background(), sess, "")
	if err != nil {
		t.Fatal(err)
	}
	secondDeals, _, err := ad.ListSourceArchive(context.Background(), sess, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(firstDeals) != 1 || len(secondDeals) != 1 {
		t.Fatalf("deal items = %d/%d, want one each", len(firstDeals), len(secondDeals))
	}
	if firstDeals[0].SourceID == "" || firstDeals[0].SourceID != secondDeals[0].SourceID {
		t.Fatalf("deal source IDs = %q/%q, want stable non-empty fallback", firstDeals[0].SourceID, secondDeals[0].SourceID)
	}
	if !strings.HasPrefix(firstDeals[0].SourceID, "crm_deal:sha256:") {
		t.Fatalf("deal source ID = %q, want crm_deal payload hash fallback", firstDeals[0].SourceID)
	}
	if sourceMapString(firstDeals[0].Payload, "custom_field") != "expansion-risk" {
		t.Fatalf("deal raw payload not preserved for fallback ID archive: %#v", firstDeals[0].Payload)
	}

	firstPipelines, next, err := ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	secondPipelines, _, err := ad.ListSourceArchive(context.Background(), sess, "deal_groups:0")
	if err != nil {
		t.Fatal(err)
	}
	if next != "fields:0" || len(firstPipelines) != 1 || len(secondPipelines) != 1 {
		t.Fatalf("pipeline items = %#v/%#v next=%q, want one each and fields cursor", firstPipelines, secondPipelines, next)
	}
	if firstPipelines[0].SourceID == "" || firstPipelines[0].SourceID != secondPipelines[0].SourceID {
		t.Fatalf("pipeline source IDs = %q/%q, want stable non-empty fallback", firstPipelines[0].SourceID, secondPipelines[0].SourceID)
	}
	if !strings.HasPrefix(firstPipelines[0].SourceID, "crm_pipeline:sha256:") {
		t.Fatalf("pipeline source ID = %q, want crm_pipeline payload hash fallback", firstPipelines[0].SourceID)
	}
	if sourceMapString(firstPipelines[0].Payload, "deal_count") != "3" {
		t.Fatalf("pipeline raw payload not preserved for fallback ID archive: %#v", firstPipelines[0].Payload)
	}
}

func TestListSourceArchiveReturnsWarningWhenCRMPayloadMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/deals" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 1}})
	}))
	defer srv.Close()

	items, next, err := New().ListSourceArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "deal_groups:0" {
		t.Fatalf("next = %q, want deal_groups:0", next)
	}
	if len(items) != 1 || items[0].SourceID != "source_archive_warning:deals" {
		t.Fatalf("items = %#v, want one deals warning item", items)
	}
	if len(items[0].Warnings) != 1 || !strings.Contains(items[0].Warnings[0], `deals source archive unavailable: response missing "deals" array`) {
		t.Fatalf("warnings = %#v, want malformed deals warning", items[0].Warnings)
	}
}

func TestListSourceArchivePreservesActiveCampaignRebuildSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/deals", "/api/3/dealGroups":
			w.WriteHeader(http.StatusForbidden)
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{"id": "10", "title": "Plan", "perstag": "PLAN", "type": "dropdown"}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{"id": "3", "tag": "VIP", "description": "Priority customers"}}})
		case "/api/3/forms":
			writeJSON(t, w, map[string]any{"forms": []any{map[string]any{"id": "form_1", "name": "Signup", "status": "1"}}})
		case "/api/3/messages":
			writeJSON(t, w, map[string]any{"messages": []any{map[string]any{"id": "msg_1", "subject": "Welcome", "cdate": "2026-05-12T10:00:00Z"}}})
		case "/api/3/customObjects/schemas":
			if r.URL.Query().Get("limit") == "1" && r.URL.Query().Get("offset") == "1" {
				writeJSON(t, w, map[string]any{"schemas": []any{}, "meta": map[string]any{"total": 1}})
			} else {
				writeJSON(t, w, map[string]any{"schemas": []any{map[string]any{"id": "schema_1", "title": "Course"}}, "meta": map[string]any{"total": 1}})
			}
		case "/api/3/customObjects/records/schema_1":
			writeJSON(t, w, map[string]any{
				"records": []any{map[string]any{
					"id":       "record_1",
					"schemaId": "schema_1",
					"fields":   []any{map[string]any{"id": "level", "value": "advanced"}},
				}},
				"meta": map[string]any{"total": 1},
			})
		case "/api/3/connections":
			writeJSON(t, w, map[string]any{"connections": []any{map[string]any{"id": "connection_1", "service": "shopify"}}})
		case "/api/3/ecomCustomers":
			writeJSON(t, w, map[string]any{"ecomCustomers": []any{map[string]any{"id": "customer_1", "email": "buyer@example.com"}}})
		case "/api/3/ecomOrders":
			if r.URL.Query().Get("limit") == "1" && r.URL.Query().Get("offset") == "1" {
				writeJSON(t, w, map[string]any{"ecomOrders": []any{}, "meta": map[string]any{"total": 1}})
			} else {
				writeJSON(t, w, map[string]any{"ecomOrders": []any{map[string]any{"id": "order_1", "status": "completed"}}, "meta": map[string]any{"total": 1}})
			}
		case "/api/3/ecomOrders/order_1/orderProducts":
			writeJSON(t, w, map[string]any{"ecomOrderProducts": []any{map[string]any{"id": "product_1", "orderid": "order_1", "name": "Course"}}})
		case "/api/3/sms/broadcasts":
			if r.URL.Query().Get("offset") == "1" {
				writeJSON(t, w, map[string]any{"broadcasts": []any{}, "meta": map[string]any{"total": 1}})
			} else {
				writeJSON(t, w, map[string]any{"broadcasts": []any{map[string]any{"id": 1, "name": "SMS launch", "status": "sent"}}, "meta": map[string]any{"total": 1}})
			}
		case "/api/3/sms/broadcasts/1":
			writeJSON(t, w, map[string]any{"id": 1, "name": "SMS launch", "status": "sent", "body": "Hello"})
		case "/api/3/sms/broadcasts/metrics":
			writeJSON(t, w, map[string]any{"metrics": []any{map[string]any{"id": 1, "sends": 1, "deliveries": 1}}})
		case "/api/3/sms/broadcasts/metrics/1/failures":
			writeJSON(t, w, map[string]any{"failures": []any{}})
		case "/api/3/sms/broadcasts/1/recipients":
			writeJSON(t, w, map[string]any{"recipients": []any{map[string]any{"id": 9, "phoneNumber": "+12025550109", "deliverability": "delivered", "optOut": "no"}}, "meta": map[string]any{"total": 1}})
		case "/api/3/contacts":
			writeJSON(t, w, map[string]any{"contacts": []any{map[string]any{"id": "9", "phone": "+12025550109"}}, "meta": map[string]any{"total": 1}})
		case "/api/3/contacts/9":
			writeJSON(t, w, map[string]any{"contact": map[string]any{"id": "9", "phone": "+12025550109"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
	cursor := ""
	gotTypes := []string{}
	for {
		items, next, err := ad.ListSourceArchive(context.Background(), sess, cursor)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			gotTypes = append(gotTypes, item.ResourceType)
			if item.SourcePlatform != canonical.SourceActiveCampaign || item.SourceID == "" {
				t.Fatalf("bad source archive item: %#v", item)
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	for _, want := range []string{
		"activecampaign_custom_field",
		"activecampaign_tag",
		"activecampaign_form",
		"activecampaign_message",
		"activecampaign_custom_object_schema",
		"activecampaign_custom_object_record",
		"activecampaign_ecommerce_connection",
		"activecampaign_ecommerce_customer",
		"activecampaign_ecommerce_order",
		"activecampaign_ecommerce_order_product",
		"activecampaign_sms_broadcast",
		"activecampaign_sms_broadcast_recipient",
		"activecampaign_non_email_contact",
	} {
		assertContains(t, gotTypes, want)
	}
}

func TestListSourceArchivePreservesFieldAndTagMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/fields":
			writeJSON(t, w, map[string]any{"fields": []any{map[string]any{
				"id":      "10",
				"title":   "Plan",
				"perstag": "PLAN",
				"type":    "dropdown",
				"options": []any{"Free", "Growth"},
				"visible": "1",
			}}})
		case "/api/3/tags":
			writeJSON(t, w, map[string]any{"tags": []any{map[string]any{
				"id":               "3",
				"tag":              "VIP",
				"description":      "Priority customers",
				"subscriber_count": "20",
			}}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
	fields, next, err := ad.ListSourceArchive(context.Background(), sess, "fields:0")
	if err != nil {
		t.Fatal(err)
	}
	if next != "tags:0" || len(fields) != 1 {
		t.Fatalf("fields = %#v next=%q, want one field and tags cursor", fields, next)
	}
	field := fields[0]
	if field.SourceID != "10" || field.ResourceType != "activecampaign_custom_field" || field.Name != "Plan" {
		t.Fatalf("bad field metadata archive: %#v", field)
	}
	if sourceMapString(field.Payload, "perstag") != "PLAN" || sourceMapString(field.Payload, "type") != "dropdown" || sourceMapString(field.Payload, "visible") != "1" {
		t.Fatalf("field raw metadata not preserved: %#v", field.Payload)
	}
	if got, ok := field.Payload["options"].([]interface{}); !ok || len(got) != 2 || fmt.Sprint(got[1]) != "Growth" {
		t.Fatalf("field options = %T %#v, want raw options", field.Payload["options"], field.Payload["options"])
	}

	tags, next, err := ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	if next != "forms:0" || len(tags) != 1 {
		t.Fatalf("tags = %#v next=%q, want one tag and forms cursor", tags, next)
	}
	tag := tags[0]
	if tag.SourceID != "3" || tag.ResourceType != "activecampaign_tag" || tag.Name != "VIP" {
		t.Fatalf("bad tag metadata archive: %#v", tag)
	}
	if sourceMapString(tag.Payload, "description") != "Priority customers" || sourceMapString(tag.Payload, "subscriber_count") != "20" {
		t.Fatalf("tag raw metadata not preserved: %#v", tag.Payload)
	}
}

func TestListSourceArchiveUsesStablePayloadHashWhenSourceIDMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/messages" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{
			"messages": []any{map[string]any{
				"subject": "Welcome",
				"cdate":   "2026-05-12T10:00:00Z",
				"status":  "active",
			}},
		})
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
	first, _, err := ad.ListSourceArchive(context.Background(), sess, "messages:0")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := ad.ListSourceArchive(context.Background(), sess, "messages:50")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("items = %d/%d, want one each", len(first), len(second))
	}
	if first[0].SourceID == "" || first[0].SourceID != second[0].SourceID {
		t.Fatalf("source IDs = %q/%q, want stable non-empty fallback", first[0].SourceID, second[0].SourceID)
	}
	if !strings.HasPrefix(first[0].SourceID, "activecampaign_message:sha256:") {
		t.Fatalf("source ID = %q, want payload hash fallback", first[0].SourceID)
	}
}

func TestListSourceArchiveUsesProviderTotalForShortPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/messages":
			if got := r.URL.Query().Get("offset"); got != "0" {
				t.Fatalf("offset = %q, want 0", got)
			}
			writeJSON(t, w, map[string]any{
				"messages": []any{map[string]any{"id": "msg_1", "subject": "Welcome", "cdate": "2026-05-12T10:00:00Z"}},
				"meta":     map[string]any{"total": 3},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad := New()
	sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
	items, next, err := ad.ListSourceArchive(context.Background(), sess, "messages:0")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ResourceType != "activecampaign_message" {
		t.Fatalf("items = %#v, want one message source archive item", items)
	}
	if next != "messages:1" {
		t.Fatalf("next = %q, want messages:1", next)
	}
}

func TestNextSourceArchiveOffsetStopsOnEmptyPage(t *testing.T) {
	if got := nextSourceArchiveOffset(0, 3, 0, pageSize); got != 0 {
		t.Fatalf("next offset = %d, want 0 for empty page", got)
	}
}

func TestListSourceArchiveReturnsWarningWhenOptionalSurfaceUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name         string
		cursor       string
		path         string
		wantNext     string
		wantSourceID string
		wantWarning  string
		wantTarget   string
	}{
		{
			name:         "custom fields",
			cursor:       "fields:0",
			path:         "/api/3/fields",
			wantNext:     "tags:0",
			wantSourceID: "source_archive_warning:fields",
			wantWarning:  "fields source archive unavailable",
			wantTarget:   "activecampaign_custom_field",
		},
		{
			name:         "tags",
			cursor:       "tags:0",
			path:         "/api/3/tags",
			wantNext:     "forms:0",
			wantSourceID: "source_archive_warning:tags",
			wantWarning:  "tags source archive unavailable",
			wantTarget:   "activecampaign_tag",
		},
		{
			name:         "forms",
			cursor:       "forms:0",
			path:         "/api/3/forms",
			wantNext:     "messages:0",
			wantSourceID: "source_archive_warning:forms",
			wantWarning:  "forms source archive unavailable",
			wantTarget:   "activecampaign_form",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path {
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
				w.WriteHeader(http.StatusForbidden)
			}))
			defer srv.Close()

			ad := New()
			sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
			items, next, err := ad.ListSourceArchive(context.Background(), sess, tc.cursor)
			if err != nil {
				t.Fatal(err)
			}
			if next != tc.wantNext {
				t.Fatalf("next = %q, want %s", next, tc.wantNext)
			}
			if len(items) != 1 {
				t.Fatalf("items len = %d, want 1", len(items))
			}
			item := items[0]
			if item.ResourceType != "" {
				t.Fatalf("warning resource type = %q, want empty warning-only marker", item.ResourceType)
			}
			if item.SourcePlatform != canonical.SourceActiveCampaign {
				t.Fatalf("source platform = %q", item.SourcePlatform)
			}
			if item.SourceID != tc.wantSourceID {
				t.Fatalf("source id = %q, want %s", item.SourceID, tc.wantSourceID)
			}
			if len(item.Warnings) != 1 || !strings.Contains(item.Warnings[0], tc.wantWarning) {
				t.Fatalf("warnings = %#v, want %s", item.Warnings, tc.wantWarning)
			}
			if got := sourceMapString(item.Payload, "target_resource_type"); got != tc.wantTarget {
				t.Fatalf("target resource type = %q, want %s", got, tc.wantTarget)
			}
		})
	}
}

func TestListSourceArchiveReturnsWarningWhenOptionalSurfacePayloadInvalid(t *testing.T) {
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{
			name: "wrong shape",
			body: map[string]any{"messages": map[string]any{"id": "msg_1"}, "meta": map[string]any{"total": 1}},
		},
		{
			name: "missing keyed array with nonzero total",
			body: map[string]any{"meta": map[string]any{"total": 1}},
		},
		{
			name: "missing keyed array without zero proof",
			body: map[string]any{},
		},
		{
			name: "null keyed array without zero proof",
			body: map[string]any{"messages": nil},
		},
		{
			name: "null keyed array with nonzero total",
			body: map[string]any{"messages": nil, "meta": map[string]any{"total": 1}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/3/messages" {
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
				writeJSON(t, w, tc.body)
			}))
			defer srv.Close()

			ad := New()
			sess := adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": srv.URL + "/api/3"}}
			items, next, err := ad.ListSourceArchive(context.Background(), sess, "messages:0")
			if err != nil {
				t.Fatal(err)
			}
			if next != "custom_object_schemas:0" {
				t.Fatalf("next = %q, want custom_object_schemas:0", next)
			}
			if len(items) != 1 {
				t.Fatalf("items len = %d, want 1", len(items))
			}
			item := items[0]
			if item.ResourceType != "" {
				t.Fatalf("warning resource type = %q, want empty warning-only marker", item.ResourceType)
			}
			if item.SourceID != "source_archive_warning:messages" {
				t.Fatalf("source id = %q", item.SourceID)
			}
			if got := sourceMapString(item.Payload, "target_resource_type"); got != "activecampaign_message" {
				t.Fatalf("target resource type = %q, want activecampaign_message", got)
			}
			if len(item.Warnings) != 1 || !strings.Contains(item.Warnings[0], "messages source archive unavailable") {
				t.Fatalf("warnings = %#v, want messages source archive warning", item.Warnings)
			}
		})
	}
}

func TestListSourceArchiveAllowsMissingOptionalSurfacePayloadWithZeroTotal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/3/messages" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{"meta": map[string]any{"total": 0}})
	}))
	defer srv.Close()

	items, next, err := New().ListSourceArchive(context.Background(), adapter.Session{
		AccessToken: "secret",
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, "messages:0")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("items = %#v, want empty explicit-zero surface", items)
	}
	if next != "custom_object_schemas:0" {
		t.Fatalf("next = %q, want custom_object_schemas:0", next)
	}
}

func TestParseRetryAfterUsesFallbackForNonPositiveValues(t *testing.T) {
	for _, raw := range []string{"", " ", "0", "-1", "not-a-delay"} {
		t.Run(fmt.Sprintf("%q", raw), func(t *testing.T) {
			if got := parseRetryAfter(raw); got != retryAfterFallback {
				t.Fatalf("retry-after %q = %s, want fallback %s", raw, got, retryAfterFallback)
			}
		})
	}
	if got := parseRetryAfter("7"); got != 7*time.Second {
		t.Fatalf("retry-after 7 = %s, want 7s", got)
	}
}

func TestDoRetriesReplayRequestBody(t *testing.T) {
	const payload = `{"contact":{"email":"ada@example.com"}}`
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		bodies = append(bodies, string(body))
		if len(bodies) == 1 {
			http.Error(w, "temporary", http.StatusInternalServerError)
			return
		}
		writeJSON(t, w, map[string]any{"ok": true})
	}))
	defer srv.Close()

	ad := New()
	ad.BaseURL = srv.URL + "/api/3"
	err := ad.do(context.Background(), adapter.Session{
		AccessToken: "secret",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": srv.URL + "/api/3"},
	}, http.MethodPost, "/contacts", strings.NewReader(payload), nil)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	if len(bodies) != 2 {
		t.Fatalf("request bodies = %#v, want two attempts", bodies)
	}
	if bodies[0] != payload || bodies[1] != payload {
		t.Fatalf("request bodies = %#v, want payload replayed on retry", bodies)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Fatal(err)
	}
}

func assertContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			return
		}
	}
	t.Fatalf("%q not in %#v", want, values)
}

func assertNotContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			t.Fatalf("%q unexpectedly present in %#v", want, values)
		}
	}
}

func stringMapSliceField(t *testing.T, sub canonical.Subscriber, key string) []map[string]string {
	t.Helper()
	values, ok := sub.CustomFields[key].([]map[string]string)
	if !ok {
		t.Fatalf("custom field %s = %T %#v, want []map[string]string", key, sub.CustomFields[key], sub.CustomFields[key])
	}
	return values
}

func interfaceMapField(t *testing.T, sub canonical.Subscriber, key string) map[string]interface{} {
	t.Helper()
	values, ok := sub.CustomFields[key].(map[string]interface{})
	if !ok {
		t.Fatalf("custom field %s = %T %#v, want map[string]interface{}", key, sub.CustomFields[key], sub.CustomFields[key])
	}
	return values
}

func interfaceMapSliceField(t *testing.T, sub canonical.Subscriber, key string) []map[string]interface{} {
	t.Helper()
	values, ok := sub.CustomFields[key].([]map[string]interface{})
	if !ok {
		t.Fatalf("custom field %s = %T %#v, want []map[string]interface{}", key, sub.CustomFields[key], sub.CustomFields[key])
	}
	return values
}

func campaignReportAttributes(t *testing.T, item canonical.CampaignArchive) map[string]interface{} {
	t.Helper()
	values, ok := item.Report["activecampaign_campaign_attributes"].(map[string]interface{})
	if !ok {
		t.Fatalf("campaign report attrs = %T %#v, want map[string]interface{}", item.Report["activecampaign_campaign_attributes"], item.Report["activecampaign_campaign_attributes"])
	}
	return values
}

func assertWarningContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if strings.Contains(value, want) {
			return
		}
	}
	t.Fatalf("warning containing %q not in %#v", want, values)
}

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
