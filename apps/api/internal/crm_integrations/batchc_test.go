// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---- GoHighLevel OAuth ----

func TestHighLevelOAuthExchangeCapturesLocation(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "ghl.at", "refresh_token": "ghl.rt", "expires_in": 86400,
			"scope": "contacts.readonly", "locationId": "loc-123",
		})
	}))
	defer srv.Close()

	client := HighLevelOAuthClient{HTTPClient: srv.Client(), TokenURL: srv.URL, Now: func() time.Time { return now }}
	creds := HighLevelCredentials{ClientID: "cid", ClientSecret: "csec"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "code", "https://app/cb")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	for _, want := range []string{"grant_type=authorization_code", "user_type=Location", "client_id=cid", "code=code"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("token form %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "ghl.at" || token.RefreshToken != "ghl.rt" || token.LocationID != "loc-123" || !token.ExpiresAt.Equal(now.Add(86400*time.Second)) {
		t.Fatalf("token = %+v", token)
	}
}

func TestHighLevelAuthorizeURL(t *testing.T) {
	cfg := HighLevelOAuthConfig{ClientID: "cid", RedirectURL: "https://app/cb"}
	got, err := highLevelOAuthAuthorizeURL(cfg, "st")
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	for _, want := range []string{"marketplace.leadconnectorhq.com/oauth/chooselocation", "client_id=cid", "state=st", "contacts.readonly"} {
		if !strings.Contains(got, want) {
			t.Fatalf("authorize url %q missing %q", got, want)
		}
	}
}

type fakeHighLevelCredentialResolver struct{ creds HighLevelCredentials }

func (f fakeHighLevelCredentialResolver) ResolveHighLevel(_ context.Context, _ string, _ Integration) (HighLevelCredentials, error) {
	return f.creds, nil
}

func TestHighLevelBackfillMapsContacts(t *testing.T) {
	var gotPath, gotAuth, gotVersion, gotLocation string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get("Version")
		gotLocation = r.URL.Query().Get("locationId")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contacts": []map[string]any{
				{"id": "c1", "email": "Ada@Example.com", "firstName": "Ada", "lastName": "L",
					"phone": "+15551234567", "companyName": "Acme", "tags": []any{"vip"},
					"locationId": "loc-123", "dateUpdated": "2026-06-20T10:00:00Z"},
			},
			"meta": map[string]any{"startAfterId": "c1", "startAfter": 1718880000000},
		})
	}))
	defer srv.Close()

	backfiller := HighLevelRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: "ghl.at", LocationID: "loc-123"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderHighLevel, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/contacts/") || gotAuth != "Bearer ghl.at" || gotVersion != highLevelAPIVersion || gotLocation != "loc-123" {
		t.Fatalf("path=%q auth=%q version=%q loc=%q", gotPath, gotAuth, gotVersion, gotLocation)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts = %d", len(req.Contacts))
	}
	c := req.Contacts[0]
	if c.Email != "ada@example.com" || c.FirstName != "Ada" || c.Company != "Acme" || c.Phone != "+15551234567" {
		t.Fatalf("mapped = %+v", c)
	}
	if c.SourceID != "highlevel://contact/c1" {
		t.Fatalf("source id = %q", c.SourceID)
	}
}

func TestHighLevelBackfillMapsOptInOpportunityAppointmentAndConversationEvents(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/contacts/":
			_ = json.NewEncoder(w).Encode(map[string]any{"contacts": []map[string]any{}})
		case "/opportunities/search":
			if r.URL.Query().Get("locationId") != "loc-123" || r.URL.Query().Get("location_id") != "loc-123" {
				t.Fatalf("opportunity location query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"opportunities": []map[string]any{{
					"id": "opp-1", "name": "Expansion", "status": "won", "monetaryValue": 4200, "updatedAt": "2026-07-02T10:00:00Z",
					"contact": map[string]any{"id": "c1", "email": "Buyer@Example.com", "firstName": "Ada", "phone": "+15551234567"},
				}},
			})
		case "/calendars/":
			if r.URL.Query().Get("locationId") != "loc-123" {
				t.Fatalf("calendar location query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"calendars": []map[string]any{{"id": "cal-1", "name": "Sales"}}})
		case "/calendars/events":
			if r.URL.Query().Get("locationId") != "loc-123" || r.URL.Query().Get("startTime") == "" || r.URL.Query().Get("endTime") == "" {
				t.Fatalf("events query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"events": []map[string]any{{
					"id": "appt-1", "title": "Demo", "calendarId": "cal-1", "startTime": "2026-07-03T12:00:00Z",
					"contact": map[string]any{"id": "c1", "email": "Buyer@Example.com", "firstName": "Ada"},
				}},
			})
		case "/conversations/search":
			if r.URL.Query().Get("locationId") != "loc-123" {
				t.Fatalf("conversation location query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conversations": []map[string]any{{
					"id": "conv-1", "channel": "SMS", "lastMessageDate": "2026-07-04T09:00:00Z",
					"contact": map[string]any{"id": "c1", "email": "Buyer@Example.com", "firstName": "Ada"},
				}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := HighLevelRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: "ghl.at", LocationID: "loc-123"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	integration := Integration{Provider: ProviderHighLevel, CredentialsRef: "c", Settings: map[string]any{
		"sync_opportunities":  true,
		"sync_calendars":      true,
		"sync_appointments":   true,
		"sync_conversations":  true,
		"calendar_start_time": "2026-07-01T00:00:00Z",
		"calendar_end_time":   "2026-08-01T00:00:00Z",
	}}

	req, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	if state, _ := decodeHighLevelCursor(req.Cursor); state.Object != "opportunities" {
		t.Fatalf("contacts cursor state = %+v cursor=%q", state, req.Cursor)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("opportunities page: %v", err)
	}
	if len(req.Events) != 1 || req.Events[0].SourceID != "highlevel://opportunity/opp-1/contact/c1" || req.Events[0].EventName != "crm.deal.won" || req.Events[0].Email != "buyer@example.com" {
		t.Fatalf("opportunity events = %+v", req.Events)
	}
	if state, _ := decodeHighLevelCursor(req.Cursor); state.Object != "calendars" {
		t.Fatalf("opportunities cursor state = %+v cursor=%q", state, req.Cursor)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("calendars page: %v", err)
	}
	if len(req.Events) != 0 {
		t.Fatalf("calendar events = %+v", req.Events)
	}
	if state, _ := decodeHighLevelCursor(req.Cursor); state.Object != "appointments" {
		t.Fatalf("calendars cursor state = %+v cursor=%q", state, req.Cursor)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("appointments page: %v", err)
	}
	if len(req.Events) != 1 || req.Events[0].SourceID != "highlevel://appointment/appt-1/contact/c1" || req.Events[0].EventName != "crm.appointment.updated" || req.Events[0].Email != "buyer@example.com" {
		t.Fatalf("appointment events = %+v", req.Events)
	}
	if state, _ := decodeHighLevelCursor(req.Cursor); state.Object != "conversations" {
		t.Fatalf("appointments cursor state = %+v cursor=%q", state, req.Cursor)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("conversations page: %v", err)
	}
	if len(req.Events) != 1 || req.Events[0].SourceID != "highlevel://conversation/conv-1/contact/c1" || req.Events[0].EventName != "crm.conversation.updated" || req.Events[0].Email != "buyer@example.com" || req.Cursor != highLevelCursorComplete {
		t.Fatalf("conversation request = %+v", req)
	}
	if len(paths) != 5 {
		t.Fatalf("paths = %+v", paths)
	}
}

// ---- Static-token CRMs ----

type fakeCloseCredentialResolver struct{ creds CloseCredentials }

func (f fakeCloseCredentialResolver) ResolveClose(_ context.Context, _ string, _ Integration) (CloseCredentials, error) {
	return f.creds, nil
}

func TestCloseBackfillMapsContacts(t *testing.T) {
	var gotPath, gotAuth, gotSkip string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotSkip = r.URL.Query().Get("_skip")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "cont_1", "name": "Ada L", "title": "Buyer",
					"emails": []map[string]any{{"email": "Ada@Example.com"}}},
			},
			"has_more": true,
		})
	}))
	defer srv.Close()

	backfiller := CloseRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeCloseCredentialResolver{creds: CloseCredentials{APIKey: "ck"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderClose, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ck:"))
	if !strings.Contains(gotPath, "/api/v1/contact/") || gotAuth != wantAuth || gotSkip != "0" {
		t.Fatalf("path=%q auth=%q skip=%q", gotPath, gotAuth, gotSkip)
	}
	if len(req.Contacts) != 1 || req.Contacts[0].Email != "ada@example.com" || req.Contacts[0].SourceID != "close://contact/cont_1" {
		t.Fatalf("mapped = %+v", req.Contacts)
	}
	if req.Cursor != "close:1" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

type fakeCopperCredentialResolver struct{ creds CopperCredentials }

func (f fakeCopperCredentialResolver) ResolveCopper(_ context.Context, _ string, _ Integration) (CopperCredentials, error) {
	return f.creds, nil
}

func TestCopperBackfillMapsPeople(t *testing.T) {
	var gotMethod, gotPath, gotToken, gotEmail string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-PW-AccessToken")
		gotEmail = r.Header.Get("X-PW-UserEmail")
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 55, "name": "Bo R", "company_name": "Globex",
				"emails": []map[string]any{{"email": "Bo@Example.com"}}},
		})
	}))
	defer srv.Close()

	backfiller := CopperRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeCopperCredentialResolver{creds: CopperCredentials{APIKey: "ak", Email: "ops@acme.com"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderCopper, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotMethod != http.MethodPost || !strings.Contains(gotPath, "/people/search") || gotToken != "ak" || gotEmail != "ops@acme.com" {
		t.Fatalf("method=%q path=%q token=%q email=%q", gotMethod, gotPath, gotToken, gotEmail)
	}
	if len(req.Contacts) != 1 || req.Contacts[0].Email != "bo@example.com" || req.Contacts[0].SourceID != "copper://person/55" {
		t.Fatalf("mapped = %+v", req.Contacts)
	}
	if req.Cursor != "copper:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestCopperBackfillMapsCompanyOpportunityProjectAndActivityPhases(t *testing.T) {
	requested := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested[r.Method+" "+r.URL.Path]++
		switch r.Method + " " + r.URL.Path {
		case "POST /people/search":
			_ = json.NewEncoder(w).Encode([]map[string]any{})
		case "POST /companies/search":
			_ = json.NewEncoder(w).Encode([]map[string]any{{
				"id": 10, "name": "Globex", "primary_contact_id": 55, "date_modified": 1783022400,
			}})
		case "POST /opportunities/search":
			_ = json.NewEncoder(w).Encode([]map[string]any{{
				"id": 20, "name": "Expansion", "primary_contact_id": 55, "company_id": 10, "company_name": "Globex", "status": "Won", "monetary_value": 4200, "date_modified": 1783022460,
			}})
		case "POST /projects/search":
			_ = json.NewEncoder(w).Encode([]map[string]any{{
				"id": 30, "name": "Implementation", "status": "Active", "related_resource": map[string]any{"type": "person", "id": 55}, "date_modified": 1783022520,
			}})
		case "POST /activities/search":
			_ = json.NewEncoder(w).Encode([]map[string]any{{
				"id": 40, "details": "Intro call", "type": map[string]any{"name": "Phone Call"}, "parent": map[string]any{"type": "person", "id": 55}, "activity_date": 1783022580,
			}})
		case "GET /people/55":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 55, "name": "Bo R", "title": "Buyer", "company_name": "Globex",
				"emails":        []map[string]any{{"email": "Bo@Example.com"}},
				"phone_numbers": []map[string]any{{"number": "+15551234567"}},
			})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := CopperRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeCopperCredentialResolver{creds: CopperCredentials{APIKey: "ak", Email: "ops@acme.com"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	integration := Integration{Provider: ProviderCopper, CredentialsRef: "c"}

	req, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("people backfill: %v", err)
	}
	if req.Cursor != "copper:companies:1" || len(req.Contacts) != 0 {
		t.Fatalf("people phase req = %+v", req)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("companies backfill: %v", err)
	}
	if req.Cursor != "copper:opportunities:1" || len(req.Contacts) != 1 {
		t.Fatalf("companies phase req = %+v", req)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "copper://company/10/person/55" || contact.Email != "bo@example.com" || contact.Company != "Globex" {
		t.Fatalf("company contact = %+v", contact)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("opportunities backfill: %v", err)
	}
	if req.Cursor != "copper:projects:1" || len(req.Events) != 1 {
		t.Fatalf("opportunities phase req = %+v", req)
	}
	event := req.Events[0]
	if event.SourceID != "copper://opportunity/20/person/55" || event.Email != "bo@example.com" || event.EventName != "crm.deal.won" {
		t.Fatalf("opportunity event = %+v", event)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("projects backfill: %v", err)
	}
	if req.Cursor != "copper:activities:1" || len(req.Events) != 1 {
		t.Fatalf("projects phase req = %+v", req)
	}
	event = req.Events[0]
	if event.SourceID != "copper://project/30/person/55" || event.Email != "bo@example.com" || event.EventName != "crm.project.updated" {
		t.Fatalf("project event = %+v", event)
	}

	req, err = backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil {
		t.Fatalf("activities backfill: %v", err)
	}
	if req.Cursor != "copper:complete" || len(req.Events) != 1 {
		t.Fatalf("activities phase req = %+v", req)
	}
	event = req.Events[0]
	if event.SourceID != "copper://activity/40/person/55" || event.Email != "bo@example.com" || event.EventName != "crm.activity.completed" {
		t.Fatalf("activity event = %+v", event)
	}
	if requested["GET /people/55"] != 4 {
		t.Fatalf("people hydrate count = %d paths=%+v", requested["GET /people/55"], requested)
	}
}

type fakeFreshsalesCredentialResolver struct{ creds FreshsalesCredentials }

func (f fakeFreshsalesCredentialResolver) ResolveFreshsales(_ context.Context, _ string, _ Integration) (FreshsalesCredentials, error) {
	return f.creds, nil
}

func TestFreshsalesBackfillMapsContacts(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contacts": []map[string]any{
				{"id": 9, "email": "Cara@Example.com", "first_name": "Cara", "last_name": "K", "mobile_number": "555"},
			},
			"meta": map[string]any{"total_pages": 2},
		})
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{"view_id": "1001"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/crm/sales/api/contacts/view/1001") || gotAuth != "Token token=fk" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Contacts) != 1 || req.Contacts[0].Email != "cara@example.com" || req.Contacts[0].SourceID != "freshsales://contact/9" {
		t.Fatalf("mapped = %+v", req.Contacts)
	}
	if req.Cursor != "freshsales:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestFreshsalesBackfillMapsAccountContactsAfterContactPages(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_accounts/view/3003":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_accounts": []map[string]any{{
					"id":         55,
					"name":       "Analytical Engines",
					"updated_at": "2026-07-02T09:30:00Z",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_accounts/55":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_account": map[string]any{
					"id":       55,
					"name":     "Analytical Engines",
					"website":  "https://example.com",
					"contacts": []map[string]any{{"id": 9}},
					"owner":    map[string]any{"id": 2, "name": "Sales Agent"},
				},
			})
		case "/crm/sales/api/contacts/9":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{
					"id":         9,
					"email":      "Buyer@Example.com",
					"first_name": "Ada",
					"last_name":  "Lovelace",
					"job_title":  "Buyer",
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":         "1001",
		"account_view_id": "3003",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	if contactsReq.Cursor != "freshsales:accounts:1" || len(contactsReq.Contacts) != 0 {
		t.Fatalf("contacts request = %+v", contactsReq)
	}
	accountsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("accounts page: %v", err)
	}
	if accountsReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("account cursor = %q", accountsReq.Cursor)
	}
	if len(accountsReq.Contacts) != 1 {
		t.Fatalf("contacts = %+v", accountsReq.Contacts)
	}
	contact := accountsReq.Contacts[0]
	if contact.SourceID != "freshsales://contact/9" || contact.Email != "buyer@example.com" || contact.Company != "Analytical Engines" || contact.LifecycleStage != "Buyer" {
		t.Fatalf("mapped account contact = %+v", contact)
	}
	if contact.Properties["freshsales_sales_account_id"] != "55" || contact.Properties["freshsales_sales_account_name"] != "Analytical Engines" {
		t.Fatalf("contact properties = %+v", contact.Properties)
	}
	if len(paths) != 4 || !strings.Contains(paths[1], "/crm/sales/api/sales_accounts/view/3003") || !strings.Contains(paths[2], "include=contacts") || !strings.Contains(paths[3], "/crm/sales/api/contacts/9") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsDealEventsAfterContactPages(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/deals/view/2002":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deals": []map[string]any{{
					"id":                   77,
					"name":                 "Expansion",
					"amount":               "4200.00",
					"base_currency_amount": "4200.00",
					"updated_at":           "2026-07-02T09:30:00Z",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/deals/77":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":     77,
					"name":   "Expansion",
					"amount": "4200.00",
					"contacts": []map[string]any{{
						"id":         9,
						"email":      "Buyer@Example.com",
						"first_name": "Ada",
					}},
					"sales_account": map[string]any{"id": 5, "name": "Analytical Engines"},
					"deal_stage":    map[string]any{"id": 3, "name": "Won"},
					"updated_at":    "2026-07-02T09:30:00Z",
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":      "1001",
		"deal_view_id": "2002",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	if contactsReq.Cursor != "freshsales:deals:1" || len(contactsReq.Contacts) != 0 {
		t.Fatalf("contacts request = %+v", contactsReq)
	}
	dealsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("deals page: %v", err)
	}
	if dealsReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("deal cursor = %q", dealsReq.Cursor)
	}
	if len(dealsReq.Events) != 1 {
		t.Fatalf("events = %+v", dealsReq.Events)
	}
	event := dealsReq.Events[0]
	if event.SourceID != "freshsales://deal/77/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.deal.won" {
		t.Fatalf("event = %+v", event)
	}
	if event.Properties["freshsales_deal_name"] != "Expansion" || event.Properties["freshsales_amount"] != "4200.00" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 3 || !strings.Contains(paths[1], "/crm/sales/api/deals/view/2002") || !strings.Contains(paths[2], "include=contacts") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsSalesActivityEventsAfterContactPages(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_activities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_activities": []map[string]any{{
					"id":                     44,
					"title":                  "Discovery call",
					"sales_activity_type_id": 2,
					"conversation_time":      "2026-07-02T10:15:00Z",
					"targetable_id":          9,
					"targetable_type":        "Contact",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/contacts/9":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{
					"id":         9,
					"email":      "Buyer@Example.com",
					"first_name": "Ada",
					"last_name":  "Lovelace",
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":               "1001",
		"sync_sales_activities": "true",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	if contactsReq.Cursor != "freshsales:activities:1" || len(contactsReq.Contacts) != 0 {
		t.Fatalf("contacts request = %+v", contactsReq)
	}
	activityReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("activities page: %v", err)
	}
	if activityReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("activity cursor = %q", activityReq.Cursor)
	}
	if len(activityReq.Events) != 1 {
		t.Fatalf("events = %+v", activityReq.Events)
	}
	event := activityReq.Events[0]
	if event.SourceID != "freshsales://sales_activity/44/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.activity.completed" {
		t.Fatalf("event = %+v", event)
	}
	if event.Properties["freshsales_sales_activity_title"] != "Discovery call" || event.Properties["freshsales_targetable_id"] != "9" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 3 || !strings.Contains(paths[1], "/crm/sales/api/sales_activities") || !strings.Contains(paths[1], "page=1") || !strings.Contains(paths[2], "/crm/sales/api/contacts/9") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsDealTargetedSalesActivityEvents(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_activities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_activities": []map[string]any{{
					"id":                     44,
					"title":                  "Deal review",
					"sales_activity_type_id": 2,
					"conversation_time":      "2026-07-02T10:15:00Z",
					"targetable_id":          77,
					"targetable_type":        "Deal",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/deals/77":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":     77,
					"name":   "Expansion",
					"amount": "4200.00",
					"contacts": []map[string]any{{
						"id":    9,
						"email": "Buyer@Example.com",
					}},
					"sales_account": map[string]any{"id": 5, "name": "Analytical Engines"},
					"deal_stage":    map[string]any{"id": 3, "name": "Negotiation"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":               "1001",
		"sync_sales_activities": "true",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	activityReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("activities page: %v", err)
	}
	if activityReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("activity cursor = %q", activityReq.Cursor)
	}
	if len(activityReq.Events) != 1 {
		t.Fatalf("events = %+v", activityReq.Events)
	}
	event := activityReq.Events[0]
	if event.SourceID != "freshsales://sales_activity/44/deal/77/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.activity.completed" {
		t.Fatalf("event = %+v", event)
	}
	account, ok := event.Properties["freshsales_sales_account"].(map[string]any)
	if !ok || account["name"] != "Analytical Engines" || event.Properties["freshsales_sales_activity_title"] != "Deal review" || event.Properties["freshsales_deal_name"] != "Expansion" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 3 || !strings.Contains(paths[1], "/crm/sales/api/sales_activities") || !strings.Contains(paths[2], "/crm/sales/api/deals/77") || !strings.Contains(paths[2], "include=contacts") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsAccountTargetedSalesActivityEvents(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_activities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_activities": []map[string]any{{
					"id":                     44,
					"title":                  "Account review",
					"sales_activity_type_id": 2,
					"conversation_time":      "2026-07-02T10:15:00Z",
					"targetable_id":          55,
					"targetable_type":        "SalesAccount",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_accounts/55":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_account": map[string]any{
					"id":       55,
					"name":     "Analytical Engines",
					"contacts": []map[string]any{{"id": 9}},
					"owner":    map[string]any{"id": 2, "name": "Sales Agent"},
				},
			})
		case "/crm/sales/api/contacts/9":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{
					"id":         9,
					"email":      "Buyer@Example.com",
					"first_name": "Ada",
					"last_name":  "Lovelace",
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":               "1001",
		"sync_sales_activities": "true",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	activityReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("activities page: %v", err)
	}
	if activityReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("activity cursor = %q", activityReq.Cursor)
	}
	if len(activityReq.Events) != 1 {
		t.Fatalf("events = %+v", activityReq.Events)
	}
	event := activityReq.Events[0]
	if event.SourceID != "freshsales://sales_activity/44/sales_account/55/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.activity.completed" {
		t.Fatalf("event = %+v", event)
	}
	if event.Properties["freshsales_sales_activity_title"] != "Account review" || event.Properties["freshsales_sales_account_name"] != "Analytical Engines" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 4 || !strings.Contains(paths[1], "/crm/sales/api/sales_activities") || !strings.Contains(paths[2], "/crm/sales/api/sales_accounts/55") || !strings.Contains(paths[2], "include=contacts") || !strings.Contains(paths[3], "/crm/sales/api/contacts/9") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsTaskEventsAfterContactPages(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/tasks":
			if r.URL.Query().Get("filter") != "completed" || r.URL.Query().Get("include") != "targetable,owner" {
				t.Fatalf("task query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tasks": []map[string]any{{
					"id":              88,
					"title":           "Send proposal",
					"status":          1,
					"due_date":        "2026-07-03T10:00:00Z",
					"updated_at":      "2026-07-02T12:00:00Z",
					"targetable":      map[string]any{"type": "contact", "id": 9},
					"targetable_type": "Contact",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/contacts/9":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{
					"id":         9,
					"email":      "Buyer@Example.com",
					"first_name": "Ada",
					"last_name":  "Lovelace",
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":     "1001",
		"sync_tasks":  "true",
		"task_filter": "completed",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	if contactsReq.Cursor != "freshsales:tasks:completed:1" || len(contactsReq.Contacts) != 0 {
		t.Fatalf("contacts request = %+v", contactsReq)
	}
	taskReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("tasks page: %v", err)
	}
	if taskReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("task cursor = %q", taskReq.Cursor)
	}
	if len(taskReq.Events) != 1 {
		t.Fatalf("events = %+v", taskReq.Events)
	}
	event := taskReq.Events[0]
	if event.SourceID != "freshsales://task/88/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.task.updated" {
		t.Fatalf("event = %+v", event)
	}
	if event.Properties["freshsales_task_title"] != "Send proposal" || event.Properties["freshsales_task_filter"] != "completed" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 3 || !strings.Contains(paths[1], "/crm/sales/api/tasks") || !strings.Contains(paths[2], "/crm/sales/api/contacts/9") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsDealTargetedTaskEvents(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/tasks":
			if r.URL.Query().Get("filter") != "completed" || r.URL.Query().Get("include") != "targetable,owner" {
				t.Fatalf("task query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tasks": []map[string]any{{
					"id":              88,
					"title":           "Send revised proposal",
					"status":          1,
					"due_date":        "2026-07-03T10:00:00Z",
					"updated_at":      "2026-07-02T12:00:00Z",
					"targetable":      map[string]any{"type": "deal", "id": 77},
					"targetable_type": "Deal",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/deals/77":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":     77,
					"name":   "Expansion",
					"amount": "4200.00",
					"contacts": []map[string]any{{
						"id":    9,
						"email": "Buyer@Example.com",
					}},
					"sales_account": map[string]any{"id": 5, "name": "Analytical Engines"},
					"deal_stage":    map[string]any{"id": 3, "name": "Negotiation"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":     "1001",
		"sync_tasks":  "true",
		"task_filter": "completed",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	taskReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("tasks page: %v", err)
	}
	if taskReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("task cursor = %q", taskReq.Cursor)
	}
	if len(taskReq.Events) != 1 {
		t.Fatalf("events = %+v", taskReq.Events)
	}
	event := taskReq.Events[0]
	if event.SourceID != "freshsales://task/88/deal/77/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.task.updated" {
		t.Fatalf("event = %+v", event)
	}
	account, ok := event.Properties["freshsales_sales_account"].(map[string]any)
	if !ok || account["name"] != "Analytical Engines" || event.Properties["freshsales_task_title"] != "Send revised proposal" || event.Properties["freshsales_deal_name"] != "Expansion" || event.Properties["freshsales_task_filter"] != "completed" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 3 || !strings.Contains(paths[1], "/crm/sales/api/tasks") || !strings.Contains(paths[2], "/crm/sales/api/deals/77") || !strings.Contains(paths[2], "include=contacts") {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestFreshsalesBackfillMapsAccountTargetedTaskEvents(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/crm/sales/api/contacts/view/1001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contacts": []map[string]any{},
				"meta":     map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/tasks":
			if r.URL.Query().Get("filter") != "completed" || r.URL.Query().Get("include") != "targetable,owner" {
				t.Fatalf("task query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tasks": []map[string]any{{
					"id":              88,
					"title":           "Renewal prep",
					"status":          1,
					"due_date":        "2026-07-03T10:00:00Z",
					"updated_at":      "2026-07-02T12:00:00Z",
					"targetable":      map[string]any{"type": "sales_account", "id": 55},
					"targetable_type": "SalesAccount",
				}},
				"meta": map[string]any{"total_pages": 1},
			})
		case "/crm/sales/api/sales_accounts/55":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sales_account": map[string]any{
					"id":       55,
					"name":     "Analytical Engines",
					"contacts": []map[string]any{{"id": 9}},
					"owner":    map[string]any{"id": 2, "name": "Sales Agent"},
				},
			})
		case "/crm/sales/api/contacts/9":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{
					"id":         9,
					"email":      "Buyer@Example.com",
					"first_name": "Ada",
					"last_name":  "Lovelace",
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer srv.Close()

	backfiller := FreshsalesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{APIKey: "fk"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	integration := Integration{Provider: ProviderFreshsales, CredentialsRef: "c", Settings: map[string]any{
		"view_id":     "1001",
		"sync_tasks":  "true",
		"task_filter": "completed",
	}}
	contactsReq, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("contacts page: %v", err)
	}
	taskReq, err := backfiller.BackfillPage(context.Background(), "t", integration, contactsReq.Cursor)
	if err != nil {
		t.Fatalf("tasks page: %v", err)
	}
	if taskReq.Cursor != freshsalesCursorComplete {
		t.Fatalf("task cursor = %q", taskReq.Cursor)
	}
	if len(taskReq.Events) != 1 {
		t.Fatalf("events = %+v", taskReq.Events)
	}
	event := taskReq.Events[0]
	if event.SourceID != "freshsales://task/88/sales_account/55/contact/9" || event.Email != "buyer@example.com" || event.EventName != "crm.task.updated" {
		t.Fatalf("event = %+v", event)
	}
	if event.Properties["freshsales_task_title"] != "Renewal prep" || event.Properties["freshsales_sales_account_name"] != "Analytical Engines" || event.Properties["freshsales_task_filter"] != "completed" {
		t.Fatalf("event properties = %+v", event.Properties)
	}
	if len(paths) != 4 || !strings.Contains(paths[1], "/crm/sales/api/tasks") || !strings.Contains(paths[2], "/crm/sales/api/sales_accounts/55") || !strings.Contains(paths[2], "include=contacts") || !strings.Contains(paths[3], "/crm/sales/api/contacts/9") {
		t.Fatalf("paths = %+v", paths)
	}
}
