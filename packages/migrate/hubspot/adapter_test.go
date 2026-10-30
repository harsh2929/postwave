// SPDX-License-Identifier: MIT

package hubspot

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

type hubSpotAPIFixture struct {
	t *testing.T

	mu sync.Mutex

	Contacts        []hsObject
	Properties      []hsProperty
	Lists           []hsList
	ListDefinitions []hsList
	Memberships     map[string][]hsMembership
	Definitions     []hsSubscriptionDefinition
	Statuses        map[string][]hsSubscriptionStatus
	WideStatuses    map[string][]hsWideSubscriptionStatus
	SearchResults   []hsObject
	SearchTotal     int
	SearchNext      string
	DailyLimit      int64
	DailyUsage      int64
	FailStatus      map[string]int
	RawResponse     map[string]string
	Paths           []string
	SearchBodies    []map[string]any
	PropertyChunks  [][]string
	ExpectedToken   string
}

func newHubSpotAPIFixture(t *testing.T) *hubSpotAPIFixture {
	t.Helper()
	active, inactive := true, false
	return &hubSpotAPIFixture{
		t: t,
		Properties: []hsProperty{
			{Name: "email", Label: "Email", Type: "string"},
			{Name: "hs_additional_emails", Label: "Additional email addresses", Type: "string"},
			{Name: "firstname", Label: "First name", Type: "string"},
			{Name: "lastname", Label: "Last name", Type: "string"},
			{Name: "lifecyclestage", Label: "Lifecycle stage", Type: "enumeration"},
			{Name: "hs_email_optout", Label: "Opted out", Type: "bool"},
			{Name: "hs_email_bounce", Label: "Bounced", Type: "bool"},
		},
		Lists: []hsList{{
			ID:               "77",
			ListVersion:      1,
			Name:             "Customers",
			ObjectTypeID:     "0-1",
			ProcessingType:   "DYNAMIC",
			ProcessingStatus: "COMPLETE",
			FilterBranch:     map[string]any{"filterBranchType": "OR", "filters": []any{}},
		}},
		Memberships: map[string][]hsMembership{},
		Definitions: []hsSubscriptionDefinition{{
			BusinessUnitID:      0,
			ID:                  10,
			Name:                "Marketing email",
			CommunicationMethod: "EMAIL",
			IsActive:            &active,
			IsDefault:           &active,
			IsInternal:          &inactive,
		}},
		Statuses:     map[string][]hsSubscriptionStatus{},
		WideStatuses: map[string][]hsWideSubscriptionStatus{},
		DailyLimit:   1_000_000,
		DailyUsage:   100,
		FailStatus:   map[string]int{},
		RawResponse:  map[string]string{},
	}
}

func (f *hubSpotAPIFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.Paths = append(f.Paths, r.URL.Path)
	raw, hasRaw := f.RawResponse[r.URL.Path]
	status := f.FailStatus[r.URL.Path]
	f.mu.Unlock()
	if status != 0 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	if hasRaw {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(raw))
		return
	}
	if got := r.Header.Get("Authorization"); (f.ExpectedToken != "" && got != "Bearer "+f.ExpectedToken) || (f.ExpectedToken == "" && got != "Bearer token" && got != "Bearer pat-secret") {
		f.t.Fatalf("Authorization = %q", got)
	}

	switch r.URL.Path {
	case "/crm/objects/2026-03/contacts":
		f.serveContacts(w, r)
	case "/account-info/2026-03/details":
		writeJSON(f.t, w, map[string]any{"portalId": 12345, "dataHostingLocation": "na1"})
	case "/crm/properties/2026-03/contacts":
		if r.URL.Query().Get("dataSensitivity") != "non_sensitive" {
			f.t.Fatalf("dataSensitivity = %q", r.URL.Query().Get("dataSensitivity"))
		}
		writeJSON(f.t, w, map[string]any{"results": f.Properties})
	case "/communication-preferences/2026-03/definitions":
		definitions := f.Definitions
		if definitions == nil {
			definitions = []hsSubscriptionDefinition{}
		}
		writeJSON(f.t, w, map[string]any{"status": "COMPLETE", "results": definitions})
	case "/crm/lists/2026-03/search":
		f.serveLists(w, r)
	case "/crm/lists/2026-03":
		f.serveListDefinitions(w, r)
	case "/crm/objects/2026-03/contacts/batch/read":
		f.serveContactBatch(w, r)
	case "/crm/lists/2026-03/records/memberships/batch/read":
		f.serveMembershipBatch(w, r)
	case "/crm/objects/2026-03/contacts/search":
		f.serveContactSearch(w, r)
	case "/account-info/2026-03/api-usage/daily/private-apps":
		writeJSON(f.t, w, map[string]any{
			"results": []any{map[string]any{
				"name":         "private-apps-api-calls-daily",
				"usageLimit":   f.DailyLimit,
				"currentUsage": f.DailyUsage,
				"collectedAt":  "2026-07-28T00:00:00Z",
				"fetchStatus":  "SUCCESS",
				"resetsAt":     "2099-07-29T00:00:00Z",
			}},
		})
	default:
		if strings.HasPrefix(r.URL.Path, "/communication-preferences/2026-03/statuses/") {
			f.servePreferences(w, r)
			return
		}
		f.t.Fatalf("unexpected %s path %s", r.Method, r.URL.Path)
	}
}

func (f *hubSpotAPIFixture) serveContacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		f.t.Fatalf("contacts method = %s", r.Method)
	}
	limit := hubSpotSnapshotPageSize
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			f.t.Fatalf("contacts limit = %q", raw)
		}
		limit = parsed
	}
	start := 0
	if raw := r.URL.Query().Get("after"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			f.t.Fatalf("contacts after = %q", raw)
		}
		start = parsed
	}
	if start > len(f.Contacts) {
		f.t.Fatalf("contacts after %d exceeds %d", start, len(f.Contacts))
	}
	end := start + limit
	if end > len(f.Contacts) {
		end = len(f.Contacts)
	}
	contacts := append([]hsObject(nil), f.Contacts[start:end]...)
	if contacts == nil {
		contacts = []hsObject{}
	}
	response := map[string]any{"results": contacts}
	if end < len(f.Contacts) {
		response["paging"] = map[string]any{"next": map[string]any{"after": strconv.Itoa(end)}}
	}
	writeJSON(f.t, w, response)
}

func (f *hubSpotAPIFixture) serveLists(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		f.t.Fatalf("list search method = %s", r.Method)
	}
	var body struct {
		Count        int    `json:"count"`
		Offset       int    `json:"offset"`
		ObjectTypeID string `json:"objectTypeId"`
	}
	decodeRequestJSON(f.t, r, &body)
	if body.Count <= 0 || body.Count > hubSpotListSearchPageSize || body.ObjectTypeID != "0-1" {
		f.t.Fatalf("list search body = %#v", body)
	}
	if body.Offset < 0 || body.Offset > len(f.Lists) {
		f.t.Fatalf("list offset = %d", body.Offset)
	}
	end := body.Offset + body.Count
	if end > len(f.Lists) {
		end = len(f.Lists)
	}
	lists := append([]hsList(nil), f.Lists[body.Offset:end]...)
	if lists == nil {
		lists = []hsList{}
	}
	writeJSON(f.t, w, map[string]any{
		"hasMore": end < len(f.Lists),
		"lists":   lists,
		"offset":  end,
		"total":   len(f.Lists),
	})
}

func (f *hubSpotAPIFixture) serveListDefinitions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Query().Get("includeFilters") != "true" {
		f.t.Fatalf("list definition request = %s %s", r.Method, r.URL.String())
	}
	requested := r.URL.Query()["listIds"]
	if len(requested) == 0 || len(requested) > 100 {
		f.t.Fatalf("listIds = %#v", requested)
	}
	definitions := f.ListDefinitions
	if definitions == nil {
		definitions = f.Lists
	}
	byID := make(map[string]hsList, len(definitions))
	for _, list := range definitions {
		byID[list.sourceID()] = list
	}
	lists := make([]hsList, 0, len(requested))
	for _, id := range requested {
		list, ok := byID[id]
		if !ok {
			f.t.Fatalf("unknown list definition %q", id)
		}
		lists = append(lists, list)
	}
	writeJSON(f.t, w, map[string]any{"lists": lists})
}

func (f *hubSpotAPIFixture) serveContactBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		f.t.Fatalf("contact batch method = %s", r.Method)
	}
	var body struct {
		Inputs []struct {
			ID string `json:"id"`
		} `json:"inputs"`
		Properties []string `json:"properties"`
	}
	decodeRequestJSON(f.t, r, &body)
	if len(body.Inputs) == 0 || len(body.Inputs) > 100 || len(body.Properties) == 0 || len(body.Properties) > 100 {
		f.t.Fatalf("contact batch body = %#v", body)
	}
	f.mu.Lock()
	f.PropertyChunks = append(f.PropertyChunks, append([]string(nil), body.Properties...))
	f.mu.Unlock()
	byID := make(map[string]hsObject, len(f.Contacts))
	for _, contact := range f.Contacts {
		byID[contact.ID] = contact
	}
	results := make([]hsObject, 0, len(body.Inputs))
	for _, input := range body.Inputs {
		contact, ok := byID[input.ID]
		if !ok {
			f.t.Fatalf("unknown batch contact %q", input.ID)
		}
		properties := map[string]string{}
		for _, name := range body.Properties {
			if value, present := contact.Properties[name]; present {
				properties[name] = value
			}
		}
		contact.Properties = properties
		results = append(results, contact)
	}
	writeJSON(f.t, w, map[string]any{"status": "COMPLETE", "results": results})
}

func (f *hubSpotAPIFixture) serveMembershipBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Inputs []struct {
			ObjectTypeID string `json:"objectTypeId"`
			RecordID     string `json:"recordId"`
		} `json:"inputs"`
	}
	decodeRequestJSON(f.t, r, &body)
	results := make([]hsRecordMemberships, 0, len(body.Inputs))
	for _, input := range body.Inputs {
		if input.ObjectTypeID != "0-1" {
			f.t.Fatalf("membership object type = %q", input.ObjectTypeID)
		}
		results = append(results, hsRecordMemberships{
			ObjectTypeID:          "0-1",
			RecordID:              input.RecordID,
			RecordListMemberships: append([]hsMembership(nil), f.Memberships[input.RecordID]...),
		})
	}
	writeJSON(f.t, w, map[string]any{"status": "COMPLETE", "results": results})
}

func (f *hubSpotAPIFixture) serveContactSearch(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	decodeRequestJSON(f.t, r, &body)
	f.mu.Lock()
	f.SearchBodies = append(f.SearchBodies, body)
	f.mu.Unlock()
	results := f.SearchResults
	if results == nil {
		results = []hsObject{}
	}
	response := map[string]any{"results": results, "total": f.SearchTotal}
	if f.SearchNext != "" {
		response["paging"] = map[string]any{"next": map[string]any{"after": f.SearchNext}}
	}
	writeJSON(f.t, w, response)
}

func (f *hubSpotAPIFixture) servePreferences(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/communication-preferences/2026-03/statuses/")
	wide := strings.HasSuffix(suffix, "/unsubscribe-all")
	suffix = strings.TrimSuffix(suffix, "/unsubscribe-all")
	email, err := url.PathUnescape(suffix)
	if err != nil {
		f.t.Fatal(err)
	}
	email = strings.ToLower(email)
	if r.URL.Query().Get("channel") != "EMAIL" {
		f.t.Fatalf("preference channel = %q", r.URL.Query().Get("channel"))
	}
	if wide {
		statuses := f.WideStatuses[email]
		if statuses == nil {
			statuses = []hsWideSubscriptionStatus{}
		}
		writeJSON(f.t, w, map[string]any{"status": "COMPLETE", "results": statuses})
		return
	}
	statuses, configured := f.Statuses[email]
	if !configured {
		for _, definition := range f.Definitions {
			if definition.IsActive != nil && *definition.IsActive && strings.EqualFold(definition.CommunicationMethod, "EMAIL") {
				statuses = append(statuses, hsSubscriptionStatus{
					BusinessUnitID: definition.BusinessUnitID,
					Channel:        "EMAIL",
					SubscriberID:   email,
					SubscriptionID: definition.ID,
					Status:         "SUBSCRIBED",
					Source:         "FORM",
					LegalBasis:     "CONSENT_WITH_NOTICE",
					Timestamp:      "2026-05-12T10:00:00Z",
				})
			}
		}
	}
	if statuses == nil {
		statuses = []hsSubscriptionStatus{}
	}
	writeJSON(f.t, w, map[string]any{"status": "COMPLETE", "results": statuses})
}

func (f *hubSpotAPIFixture) sawPath(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, got := range f.Paths {
		if got == path {
			return true
		}
	}
	return false
}

func testHubSpotSession() adapter.Session {
	const hubID = "12345"
	return adapter.Session{
		AccessToken: "token",
		AccountID:   hubID,
		Source:      canonical.SourceHubSpot,
		Extra: map[string]string{
			HubIDExtraKey:               hubID,
			DataHostingLocationExtraKey: "na1",
			AccountFingerprintExtraKey:  accountFingerprintForHubID(hubID),
		},
	}
}

func newTestHubSpotAdapter(baseURL string) *Adapter {
	result := New()
	result.BaseURL = baseURL
	result.limiter = adapter.NewTokenBucket(10_000, time.Second, 10_000)
	return result
}

func TestAuthenticateUsesCurrentAPIsAndBindsVerifiedPortal(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	sess, err := ad.Authenticate(context.Background(), adapter.Credentials{APIKey: "pat-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if sess.Source != canonical.SourceHubSpot || sess.AccountID != "12345" {
		t.Fatalf("session = %#v", sess)
	}
	if sess.Extra[HubIDExtraKey] != "12345" || sess.Extra[DataHostingLocationExtraKey] != "na1" {
		t.Fatalf("verified identity = %#v", sess.Extra)
	}
	if fingerprint := AccountFingerprint(sess); fingerprint == "" || strings.Contains(fingerprint, "12345") {
		t.Fatalf("opaque account fingerprint = %q", fingerprint)
	}
	if !fixture.sawPath("/crm/objects/2026-03/contacts") || !fixture.sawPath("/account-info/2026-03/details") {
		t.Fatalf("paths = %#v", fixture.Paths)
	}
}

func TestAuthenticateFailsClosedWithoutVerifiedHubID(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.RawResponse["/account-info/2026-03/details"] = `{}`
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	_, err := ad.Authenticate(context.Background(), adapter.Credentials{
		APIKey:    "pat-secret",
		AccountID: "11111",
	})
	if err == nil || !strings.Contains(err.Error(), "stable portal id") {
		t.Fatalf("Authenticate error = %v, want missing verified portal identity", err)
	}
}

func TestAuthenticateRejectsExpectedPortalSelectorMismatchWithoutLeakingIDs(t *testing.T) {
	tests := []struct {
		name  string
		creds adapter.Credentials
	}{
		{
			name: "selectors disagree",
			creds: adapter.Credentials{
				APIKey:    "pat-secret",
				AccountID: "11111",
				Extra:     map[string]string{HubIDExtraKey: "22222"},
			},
		},
		{
			name: "provider differs",
			creds: adapter.Credentials{
				APIKey:    "pat-secret",
				AccountID: "11111",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newHubSpotAPIFixture(t)
			server := httptest.NewServer(fixture)
			defer server.Close()
			ad := newTestHubSpotAdapter(server.URL)
			_, err := ad.Authenticate(context.Background(), test.creds)
			if err == nil || !errors.Is(err, adapter.ErrAuth) {
				t.Fatalf("error = %v, want auth failure", err)
			}
			message := err.Error()
			for _, forbidden := range []string{"11111", "22222", "12345"} {
				if strings.Contains(message, forbidden) {
					t.Fatalf("portal identifier leaked in %q", message)
				}
			}
		})
	}
}

func TestAccountFingerprintRejectsForgedOrInconsistentMetadata(t *testing.T) {
	valid := testHubSpotSession()
	if AccountFingerprint(valid) == "" {
		t.Fatal("valid portal binding was rejected")
	}
	for _, sess := range []adapter.Session{
		{AccessToken: "token", AccountID: "54321", Source: canonical.SourceHubSpot, Extra: valid.Extra},
		{AccessToken: "token", AccountID: "12345", Source: canonical.SourceHubSpot, Extra: map[string]string{HubIDExtraKey: "12345"}},
		{AccessToken: "token", AccountID: "12345", Source: canonical.SourceHubSpot, Extra: map[string]string{
			HubIDExtraKey:               "12345",
			DataHostingLocationExtraKey: "na1",
			AccountFingerprintExtraKey:  strings.Repeat("e", sha256.Size*2),
		}},
	} {
		if got := AccountFingerprint(sess); got != "" {
			t.Fatalf("forged/inconsistent session fingerprint = %q, want empty", got)
		}
	}
}

func TestSnapshotMapsPropertiesAliasesMembershipsAndConsentConservatively(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Properties = append(fixture.Properties, hsProperty{Name: "favorite_plan", Label: "Plan", Type: "string"})
	fixture.Lists = append(fixture.Lists, hsList{
		ID:               "88",
		ListVersion:      1,
		Name:             "VIPs",
		ObjectTypeID:     "0-1",
		ProcessingType:   "MANUAL",
		ProcessingStatus: "COMPLETE",
	})
	fixture.Contacts = []hsObject{{
		ID:        "42",
		CreatedAt: "2026-05-01T12:00:00Z",
		UpdatedAt: "2026-05-02T12:00:00Z",
		Properties: map[string]string{
			"email":                "Ada@Example.com",
			"hs_additional_emails": "ADA.ALIAS@example.com;ada@example.com;second@example.com;ADA.ALIAS@example.com",
			"firstname":            "Ada",
			"lastname":             "Lovelace",
			"phone":                "+15551234567",
			"favorite_plan":        "Growth",
			"lifecyclestage":       "customer",
			"hs_email_optout":      "true",
			"lastmodifieddate":     "2026-05-02T12:00:00Z",
			"createdate":           "2026-05-01T12:00:00Z",
			"hs_object_id":         "42",
		},
	}}
	fixture.Memberships["42"] = []hsMembership{
		{ListID: "77", ListVersion: 1},
		{ListID: 88, ListVersion: 1},
	}
	fixture.Statuses["ada@example.com"] = []hsSubscriptionStatus{{
		BusinessUnitID: 0,
		Channel:        "EMAIL",
		SubscriberID:   "ada@example.com",
		SubscriptionID: 10,
		Status:         "UNSUBSCRIBED",
		Source:         "PREFERENCE_CENTER",
		Timestamp:      "2026-05-02T10:00:00Z",
	}}
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	subscribers, next, err := ad.ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err != nil {
		t.Fatal(err)
	}
	if next != "" || len(subscribers) != 1 {
		t.Fatalf("subscriber page = %d next=%q", len(subscribers), next)
	}
	sub := subscribers[0]
	if sub.Email != "ada@example.com" || sub.SourceID != "42" || sub.Status != canonical.StatusDisabled {
		t.Fatalf("subscriber identity/status = %#v", sub)
	}
	if sub.CustomFields["hubspot_property_favorite_plan"] != "Growth" ||
		sub.CustomFields["first_name"] != "Ada" ||
		sub.CustomFields["phone"] != "+15551234567" {
		t.Fatalf("custom fields = %#v", sub.CustomFields)
	}
	aliases, ok := sub.CustomFields["hubspot_additional_emails"].([]string)
	if !ok || fmt.Sprint(aliases) != "[ADA.ALIAS@example.com second@example.com]" {
		t.Fatalf("additional emails = %#v", sub.CustomFields["hubspot_additional_emails"])
	}
	normalized, ok := sub.CustomFields["hubspot_additional_emails_normalized"].([]string)
	if !ok || fmt.Sprint(normalized) != "[ada.alias@example.com second@example.com]" {
		t.Fatalf("normalized aliases = %#v", sub.CustomFields["hubspot_additional_emails_normalized"])
	}
	assertContains(t, sub.Tags, "hubspot:lifecycle:customer")
	assertContains(t, sub.Tags, "hubspot:list:77")
	assertContains(t, sub.Tags, "hubspot:list:88")
	if sub.ConsentTimestamp != nil || sub.ConsentSource != canonical.ConsentUnknown {
		t.Fatalf("consent = %#v/%s", sub.ConsentTimestamp, sub.ConsentSource)
	}

	discovery, err := ad.Discover(context.Background(), testHubSpotSession())
	if err != nil {
		t.Fatal(err)
	}
	if discovery.SubscribersTotal != 1 || discovery.ProfilesWithoutEmailTotal != 0 ||
		discovery.AdditionalEmailIdentitiesTotal != 2 || discovery.CRMTotal != 1 ||
		discovery.SegmentsTotal != 3 || discovery.SubscriptionChannelsTotal != 1 {
		t.Fatalf("discovery = %#v", discovery)
	}
	if discovery.SnapshotMembershipCounts["hubspot:list:77"] != 1 ||
		discovery.SnapshotMembershipCounts["hubspot:list:88"] != 1 ||
		discovery.SnapshotMembershipCounts["hubspot:subscription:0:10"] != 0 {
		t.Fatalf("membership counts = %#v", discovery.SnapshotMembershipCounts)
	}
	if len(discovery.Warnings) != 0 {
		t.Fatalf("warnings = %#v", discovery.Warnings)
	}
}

func TestHubSpotContactWithoutAffirmativePreferenceIsUnconfirmed(t *testing.T) {
	sub := mapContactToCanonical(hsObject{
		ID: "42",
		Properties: map[string]string{
			"email": "ada@example.com",
		},
	}, nil)
	if sub.Status != canonical.StatusUnconfirmed {
		t.Fatalf("status = %s, want unconfirmed without Communication Preferences proof", sub.Status)
	}
}

func TestContactCustomFieldKeysAreInjectiveDespiteCollidingLabels(t *testing.T) {
	properties := map[string]hsProperty{
		"plan_alpha":               {Name: "plan_alpha", Label: "Plan"},
		"plan_beta":                {Name: "plan_beta", Label: "Plan"},
		"subscription_preferences": {Name: "subscription_preferences", Label: "Preferences"},
		"additional_emails":        {Name: "additional_emails", Label: "Aliases"},
		"lifecycle_stage":          {Name: "lifecycle_stage", Label: "Lifecycle"},
	}
	sub := mapContactToCanonical(hsObject{
		ID: "42",
		Properties: map[string]string{
			"email":                    "ada@example.com",
			"plan_alpha":               "Growth",
			"plan_beta":                "Enterprise",
			"subscription_preferences": "raw-preferences",
			"additional_emails":        "raw-aliases",
			"lifecycle_stage":          "raw-stage",
		},
	}, properties)
	if sub.CustomFields["hubspot_property_plan_alpha"] != "Growth" || sub.CustomFields["hubspot_property_plan_beta"] != "Enterprise" {
		t.Fatalf("colliding source properties were not preserved: %#v", sub.CustomFields)
	}
	if sub.CustomFields["hubspot_property_subscription_preferences"] != "raw-preferences" ||
		sub.CustomFields["hubspot_property_additional_emails"] != "raw-aliases" ||
		sub.CustomFields["hubspot_property_lifecycle_stage"] != "raw-stage" {
		t.Fatalf("synthetic-field collisions were not isolated: %#v", sub.CustomFields)
	}
}

func TestConsentProjectionRequiresCompleteAffirmativeEvidence(t *testing.T) {
	active, inactive := true, false
	definitions := []hsSubscriptionDefinition{
		{BusinessUnitID: 0, ID: 10, Name: "News", CommunicationMethod: "EMAIL", IsActive: &active, IsDefault: &active, IsInternal: &inactive},
		{BusinessUnitID: 1, ID: 20, Name: "Events", CommunicationMethod: "EMAIL", IsActive: &active, IsDefault: &inactive, IsInternal: &inactive},
	}
	base := canonical.Subscriber{
		Email:         "ada@example.com",
		Status:        canonical.StatusUnconfirmed,
		CustomFields:  map[string]any{},
		ConsentSource: canonical.ConsentUnknown,
	}
	status := func(businessUnit int64, subscriptionID int, state, timestamp string) hsSubscriptionStatus {
		return hsSubscriptionStatus{
			BusinessUnitID: businessUnit,
			Channel:        "EMAIL",
			SubscriberID:   "ada@example.com",
			SubscriptionID: subscriptionID,
			Status:         state,
			Source:         "FORM",
			LegalBasis:     "CONSENT_WITH_NOTICE",
			Timestamp:      timestamp,
		}
	}
	tests := []struct {
		name     string
		initial  canonical.SubscriberStatus
		statuses []hsSubscriptionStatus
		wide     []hsWideSubscriptionStatus
		want     canonical.SubscriberStatus
		wantTime string
	}{
		{
			name: "all definitions subscribed",
			statuses: []hsSubscriptionStatus{
				status(0, 10, "SUBSCRIBED", "2026-05-01T10:00:00Z"),
				status(1, 20, "SUBSCRIBED", "2026-05-02T10:00:00Z"),
			},
			want:     canonical.StatusEnabled,
			wantTime: "2026-05-02T10:00:00Z",
		},
		{
			name: "subscribed without defensible consent basis keeps timestamp as raw evidence only",
			statuses: []hsSubscriptionStatus{
				{BusinessUnitID: 0, Channel: "EMAIL", SubscriberID: "ada@example.com", SubscriptionID: 10, Status: "SUBSCRIBED", Source: "INTEGRATION", Timestamp: "2026-05-01T10:00:00Z"},
				{BusinessUnitID: 1, Channel: "EMAIL", SubscriberID: "ada@example.com", SubscriptionID: 20, Status: "SUBSCRIBED", Source: "INTEGRATION", Timestamp: "2026-05-02T10:00:00Z"},
			},
			want: canonical.StatusEnabled,
		},
		{
			name: "scoped unsubscribe dominates",
			statuses: []hsSubscriptionStatus{
				status(0, 10, "SUBSCRIBED", "2026-05-01T10:00:00Z"),
				status(1, 20, "UNSUBSCRIBED", "2026-05-02T10:00:00Z"),
			},
			want: canonical.StatusDisabled,
		},
		{
			name: "not specified remains unconfirmed",
			statuses: []hsSubscriptionStatus{
				status(0, 10, "SUBSCRIBED", "2026-05-01T10:00:00Z"),
				status(1, 20, "NOT_SPECIFIED", "2026-05-02T10:00:00Z"),
			},
			want: canonical.StatusUnconfirmed,
		},
		{
			name: "portal wide unsubscribe dominates",
			statuses: []hsSubscriptionStatus{
				status(0, 10, "SUBSCRIBED", "2026-05-01T10:00:00Z"),
				status(1, 20, "SUBSCRIBED", "2026-05-02T10:00:00Z"),
			},
			wide: []hsWideSubscriptionStatus{{
				BusinessUnitID: 0,
				WideStatusType: "PORTAL_WIDE",
				SubscriberID:   "ada@example.com",
				Status:         "UNSUBSCRIBED",
				Channel:        "EMAIL",
				Timestamp:      "2026-05-03T10:00:00Z",
			}},
			want: canonical.StatusDisabled,
		},
		{
			name: "wide not specified holds unconfirmed",
			statuses: []hsSubscriptionStatus{
				status(0, 10, "SUBSCRIBED", "2026-05-01T10:00:00Z"),
				status(1, 20, "SUBSCRIBED", "2026-05-02T10:00:00Z"),
			},
			wide: []hsWideSubscriptionStatus{{
				BusinessUnitID: 0,
				WideStatusType: "PORTAL_WIDE",
				Status:         "NOT_SPECIFIED",
			}},
			want: canonical.StatusUnconfirmed,
		},
		{
			name: "wide subscribed is evidence but cannot promote by itself",
			wide: []hsWideSubscriptionStatus{{
				BusinessUnitID: 0,
				WideStatusType: "PORTAL_WIDE",
				Status:         "SUBSCRIBED",
			}},
			want: canonical.StatusUnconfirmed,
		},
		{
			name:    "bounce remains blocklisted",
			initial: canonical.StatusBlocklisted,
			statuses: []hsSubscriptionStatus{
				status(0, 10, "SUBSCRIBED", "2026-05-01T10:00:00Z"),
				status(1, 20, "SUBSCRIBED", "2026-05-02T10:00:00Z"),
			},
			want: canonical.StatusBlocklisted,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := base
			input.CustomFields = map[string]any{}
			if test.initial != "" {
				input.Status = test.initial
			}
			got, err := applyHubSpotPreferences(input, test.statuses, test.wide, definitions)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != test.want {
				t.Fatalf("status = %s, want %s", got.Status, test.want)
			}
			if test.wantTime == "" {
				if got.ConsentTimestamp != nil {
					t.Fatalf("consent timestamp = %s, want nil", got.ConsentTimestamp)
				}
			} else if got.ConsentTimestamp == nil || got.ConsentTimestamp.Format(time.RFC3339) != test.wantTime {
				t.Fatalf("consent timestamp = %v, want %s", got.ConsentTimestamp, test.wantTime)
			}
			if _, ok := got.CustomFields["hubspot_subscription_preferences"]; !ok {
				t.Fatalf("preference evidence = %#v", got.CustomFields)
			}
		})
	}
	_, err := applyHubSpotPreferences(base, nil, []hsWideSubscriptionStatus{{Status: "FUTURE_STATE"}}, definitions)
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) {
		t.Fatalf("unknown unsubscribe-all state error = %v", err)
	}
}

func TestEmailEligibilityRestrictionsCannotBePromotedByPreferences(t *testing.T) {
	active, inactive := true, false
	definitions := []hsSubscriptionDefinition{{
		BusinessUnitID:      0,
		ID:                  10,
		Name:                "News",
		CommunicationMethod: "EMAIL",
		IsActive:            &active,
		IsDefault:           &active,
		IsInternal:          &inactive,
	}}
	properties := map[string]hsProperty{
		"hs_marketable_status": {
			Name: "hs_marketable_status",
			Options: []hsPropertyOption{
				{Value: "true", Label: "Marketing contact"},
				{Value: "false", Label: "Non-marketing contact"},
			},
		},
		"hs_emailconfirmationstatus": {
			Name: "hs_emailconfirmationstatus",
			Options: []hsPropertyOption{
				{Value: "CONFIRMATION_PENDING", Label: "Confirmation pending"},
				{Value: "CONFIRMED", Label: "Confirmed"},
			},
		},
	}
	subscribed := []hsSubscriptionStatus{{
		BusinessUnitID: 0,
		Channel:        "EMAIL",
		SubscriberID:   "ada@example.com",
		SubscriptionID: 10,
		Status:         "SUBSCRIBED",
		Source:         "FORM",
		Timestamp:      "2026-05-01T10:00:00Z",
	}}
	tests := []struct {
		name       string
		properties map[string]string
		want       canonical.SubscriberStatus
		wantReason string
	}{
		{name: "soft bounce count alone remains evidence only", properties: map[string]string{"hs_email_bounce": "2"}, want: canonical.StatusEnabled},
		{name: "quarantined", properties: map[string]string{"hs_email_quarantined": "true"}, want: canonical.StatusBlocklisted, wantReason: "quarantined"},
		{name: "invalid address", properties: map[string]string{"hs_email_bad_address": "true"}, want: canonical.StatusBlocklisted, wantReason: "invalid_address"},
		{name: "current hard bounce enum", properties: map[string]string{"hs_email_hard_bounce_reason_enum": "UNKNOWN_USER"}, want: canonical.StatusBlocklisted, wantReason: "hard_bounce"},
		{name: "hard bounce reason", properties: map[string]string{"hs_email_bounce_reason": "MAILBOX_NOT_FOUND"}, want: canonical.StatusBlocklisted, wantReason: "hard_bounce"},
		{name: "non marketing", properties: map[string]string{"hs_marketable_status": "false"}, want: canonical.StatusUnconfirmed, wantReason: "non_marketing_contact"},
		{name: "double opt in pending", properties: map[string]string{"hs_emailconfirmationstatus": "CONFIRMATION_PENDING"}, want: canonical.StatusUnconfirmed, wantReason: "double_opt_in_pending_or_unconfirmed"},
		{name: "confirmed and marketing", properties: map[string]string{"hs_marketable_status": "true", "hs_emailconfirmationstatus": "CONFIRMED"}, want: canonical.StatusEnabled},
		{name: "defined eligibility properties are blank", properties: map[string]string{"hs_marketable_status": "", "hs_emailconfirmationstatus": ""}, want: canonical.StatusUnconfirmed, wantReason: "unknown_marketing_contact_status"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := map[string]string{
				"email":                      "ada@example.com",
				"hs_marketable_status":       "true",
				"hs_emailconfirmationstatus": "CONFIRMED",
			}
			for key, value := range test.properties {
				values[key] = value
			}
			sub := mapContactToCanonical(hsObject{ID: "42", Properties: values}, properties)
			got, err := applyHubSpotPreferences(sub, subscribed, nil, definitions)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != test.want {
				t.Fatalf("status = %s, want %s; subscriber=%#v", got.Status, test.want, got)
			}
			if test.wantReason != "" {
				reasons, ok := got.CustomFields["hubspot_email_eligibility_restrictions"].([]string)
				if !ok {
					t.Fatalf("restrictions = %#v", got.CustomFields["hubspot_email_eligibility_restrictions"])
				}
				assertContains(t, reasons, test.wantReason)
			}
			for key, value := range test.properties {
				if value == "" {
					continue
				}
				if got.CustomFields["hubspot_property_"+key] != value {
					t.Fatalf("raw evidence %s = %#v, want %q", key, got.CustomFields["hubspot_property_"+key], value)
				}
			}
		})
	}
}

func TestSourceEventPrimaryEmailTransitionUsesCurrentEligibilityEvidence(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{
		ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":                  "old@example.com",
			"hs_object_id":           "42",
			"lastmodifieddate":       "2026-05-12T11:00:00Z",
			"hs_email_bounce":        "2",
			"hs_email_bounce_reason": "MAILBOX_NOT_FOUND",
		},
	}}
	fixture.SearchResults = []hsObject{{
		ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{"email": "old@example.com", "hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
	}}
	fixture.SearchTotal = 1
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	first, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), time.Time{}, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 1 || first.Events[0].Subscriber == nil ||
		first.Events[0].Subscriber.Email != "old@example.com" ||
		first.Events[0].Subscriber.Status != canonical.StatusBlocklisted {
		t.Fatalf("old-primary event = %#v", first.Events)
	}

	fixture.Contacts[0].UpdatedAt = "2026-05-12T12:00:00Z"
	fixture.Contacts[0].Properties = map[string]string{
		"email":            "new@example.com",
		"hs_object_id":     "42",
		"lastmodifieddate": "2026-05-12T12:00:00Z",
		"hs_email_bounce":  "0",
	}
	fixture.SearchResults[0].UpdatedAt = "2026-05-12T12:00:00Z"
	fixture.SearchResults[0].Properties = map[string]string{
		"email":            "new@example.com",
		"hs_object_id":     "42",
		"lastmodifieddate": "2026-05-12T12:00:00Z",
	}
	second, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), time.Time{}, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Events) != 1 || second.Events[0].Subscriber == nil ||
		second.Events[0].Subscriber.Email != "new@example.com" ||
		second.Events[0].Subscriber.Status != canonical.StatusEnabled {
		t.Fatalf("new-primary event = %#v", second.Events)
	}
}

func TestInactiveDefinitionsArePreservedWithoutDrivingPositiveConsent(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	active, inactive := true, false
	fixture.Definitions = append(fixture.Definitions, hsSubscriptionDefinition{
		BusinessUnitID:      0,
		ID:                  20,
		Name:                "Archived announcements",
		CommunicationMethod: "",
		IsActive:            &inactive,
		IsDefault:           &inactive,
		IsInternal:          &active,
	})
	fixture.Contacts = []hsObject{{
		ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
	}}
	fixture.Statuses["ada@example.com"] = []hsSubscriptionStatus{
		{BusinessUnitID: 0, Channel: "EMAIL", SubscriberID: "ada@example.com", SubscriptionID: 10, Status: "SUBSCRIBED", Source: "FORM", Timestamp: "2026-05-01T10:00:00Z"},
		{BusinessUnitID: 0, Channel: "EMAIL", SubscriberID: "ada@example.com", SubscriptionID: 20, Status: "UNSUBSCRIBED", Source: "ARCHIVED", Timestamp: "2026-05-02T10:00:00Z"},
	}
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	subscribers, _, err := ad.ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subscribers) != 1 || subscribers[0].Status != canonical.StatusDisabled {
		t.Fatalf("subscribers = %#v", subscribers)
	}
	rows, ok := subscribers[0].CustomFields["hubspot_subscription_preferences"].([]map[string]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("inactive preference evidence = %#v", subscribers[0].CustomFields["hubspot_subscription_preferences"])
	}
	assertContains(t, subscribers[0].Tags, "hubspot:subscription:0:10")
	for _, tag := range subscribers[0].Tags {
		if tag == "hubspot:subscription:0:20" {
			t.Fatalf("inactive subscription became a targeting tag: %#v", subscribers[0].Tags)
		}
	}
}

func TestDocumentedUnsubscribeAllRowWithoutOptionalStateFieldsDisablesContact(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{
		ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
	}}
	fixture.WideStatuses["ada@example.com"] = []hsWideSubscriptionStatus{{
		BusinessUnitID: 0,
		SubscriberID:   "ada@example.com",
		Channel:        "EMAIL",
		Timestamp:      "2026-05-03T10:00:00Z",
	}}
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	subscribers, _, err := ad.ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(subscribers) != 1 || subscribers[0].Status != canonical.StatusDisabled {
		t.Fatalf("subscribers = %#v", subscribers)
	}
}

func TestUnsubscribeAllKnownStatesAreProjectedConservatively(t *testing.T) {
	tests := []struct {
		state   string
		want    canonical.SubscriberStatus
		wantErr bool
	}{
		{state: "UNSUBSCRIBED", want: canonical.StatusDisabled},
		{state: "NOT_SPECIFIED", want: canonical.StatusUnconfirmed},
		// The active topic definition remains the affirmative evidence here;
		// the wide SUBSCRIBED row neither blocks nor independently promotes it.
		{state: "SUBSCRIBED", want: canonical.StatusEnabled},
		{state: "FUTURE_STATE", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.state, func(t *testing.T) {
			fixture := newHubSpotAPIFixture(t)
			fixture.Contacts = []hsObject{{
				ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
				Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
			}}
			fixture.WideStatuses["ada@example.com"] = []hsWideSubscriptionStatus{{
				BusinessUnitID: 0,
				WideStatusType: "PORTAL_WIDE",
				SubscriberID:   "ada@example.com",
				Status:         test.state,
				Channel:        "EMAIL",
				Timestamp:      "2026-05-03T10:00:00Z",
			}}
			server := httptest.NewServer(fixture)
			defer server.Close()

			subscribers, _, err := newTestHubSpotAdapter(server.URL).ListSubscribers(context.Background(), testHubSpotSession(), "")
			if test.wantErr {
				if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) {
					t.Fatalf("error = %v, want fail-closed unknown state", err)
				}
				if strings.Contains(err.Error(), test.state) {
					t.Fatalf("provider-controlled state leaked in error %q", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(subscribers) != 1 || subscribers[0].Status != test.want {
				t.Fatalf("subscribers = %#v, want status %s", subscribers, test.want)
			}
		})
	}
}

func TestListSegmentsDoNotRequestOrPersistFilterDefinitions(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Lists[0].FilterBranch = map[string]any{
		"filterBranchType": "OR",
		"filters": []any{map[string]any{
			"filterType": "PROPERTY",
			"property":   "passport_number",
			"operation": map[string]any{
				"operationType": "MULTISTRING",
				"operator":      "IS_EQUAL_TO",
				"values":        []any{"P1234567", "private.person@example.com"},
				"futureLiteral": "unknown-predicate-secret",
			},
		}},
	}
	fixture.Lists[0].AdditionalProperties = map[string]any{"futureMetadata": "unknown-metadata-secret"}
	fixture.Lists[0].ListPermissions = map[string]any{"usersWithEditAccess": []any{"private-user-id"}}
	fixture.Lists[0].MembershipSettings = map[string]any{"membershipTeamId": "private-team-id"}
	fixture.Lists[0].CreatedByID = "private-creator-id"
	fixture.Lists[0].UpdatedByID = "private-updater-id"
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	snapshot, err := ad.ensureSnapshot(context.Background(), testHubSpotSession())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Lists) != 1 || snapshot.Lists[0].FilterBranch != nil ||
		snapshot.Lists[0].AdditionalProperties != nil || snapshot.Lists[0].ListPermissions != nil ||
		snapshot.Lists[0].MembershipSettings != nil || snapshot.Lists[0].CreatedByID != "" ||
		snapshot.Lists[0].UpdatedByID != "" {
		t.Fatalf("unsafe list metadata survived snapshot normalization: %#v", snapshot.Lists)
	}
	segments := snapshot.Segments
	if len(segments) != 2 {
		t.Fatalf("segments = %#v", segments)
	}
	var listSegment canonical.Segment
	for _, segment := range segments {
		if segment.QueryAST.Value == "hubspot:list:77" {
			listSegment = segment
		}
	}
	if listSegment.Name != "HubSpot: Customers" ||
		!strings.Contains(listSegment.SourceDefinition, `"predicate_fidelity":"not_accessed_or_persisted"`) ||
		!strings.Contains(listSegment.SourceDefinition, `"source_id":"hubspot:list:77"`) {
		t.Fatalf("list segment = %#v", listSegment)
	}
	for _, forbidden := range []string{
		"filterBranch", "passport_number", "P1234567", "private.person@example.com",
		"unknown-predicate-secret", "unknown-metadata-secret", "private-user-id",
		"private-team-id", "private-creator-id", "private-updater-id",
	} {
		if strings.Contains(listSegment.SourceDefinition, forbidden) {
			t.Fatalf("sensitive list metadata %q survived in source definition: %s", forbidden, listSegment.SourceDefinition)
		}
	}
	if fixture.sawPath("/crm/lists/2026-03") {
		t.Fatalf("filter definition hydration was unexpectedly requested: %#v", fixture.Paths)
	}
}

func TestListSegmentSourceIdentitySurvivesMutableDefinitionChanges(t *testing.T) {
	first := mapListToSegment(hsList{
		ID:               "77",
		Name:             "Customers",
		ObjectTypeID:     "0-1",
		ProcessingType:   "DYNAMIC",
		ProcessingStatus: "COMPLETE",
		FilterBranch:     map[string]any{"filterBranchType": "OR", "filters": []any{}},
	})
	changed := mapListToSegment(hsList{
		ID:               "77",
		Name:             "Renamed customers",
		ObjectTypeID:     "0-1",
		ProcessingType:   "DYNAMIC",
		ProcessingStatus: "COMPLETE",
		FilterBranch: map[string]any{
			"filterBranchType": "OR",
			"filters":          []any{map[string]any{"property": "country", "filterType": "PROPERTY"}},
		},
	})
	decodeIdentity := func(raw string) string {
		t.Helper()
		var definition struct {
			MigrationMode string `json:"migration_mode"`
			SourceID      string `json:"source_id"`
			Source        hsList `json:"source"`
		}
		if err := json.Unmarshal([]byte(raw), &definition); err != nil {
			t.Fatal(err)
		}
		if definition.MigrationMode != "static_membership_snapshot" || definition.Source.sourceID() != "77" {
			t.Fatalf("source definition = %#v", definition)
		}
		return definition.SourceID
	}
	firstID := decodeIdentity(first.SourceDefinition)
	changedID := decodeIdentity(changed.SourceDefinition)
	if firstID != "hubspot:list:77" || changedID != firstID {
		t.Fatalf("mutable list identity = %q/%q", firstID, changedID)
	}
}

func TestMapListToSegmentRedactsUnknownPredicateValuesAndMetadata(t *testing.T) {
	list := hsList{
		ID:               "77",
		ListVersion:      3,
		Name:             "Customers",
		ObjectTypeID:     "0-1",
		ProcessingType:   "DYNAMIC",
		ProcessingStatus: "COMPLETE",
		FilterBranch: map[string]any{
			"filterBranchType": "OR",
			"filters": []any{map[string]any{
				"filterType": "PROPERTY",
				"property":   "highly_sensitive_property",
				"operation": map[string]any{
					"operator": "EQ",
					"value":    json.Number("9007199254740993"),
				},
			}},
		},
		AdditionalProperties: map[string]any{"futureMetadata": "metadata-secret"},
		ListPermissions:      map[string]any{"usersWithEditAccess": []any{"private-user-id"}},
		MembershipSettings:   map[string]any{"membershipTeamId": "private-team-id"},
		CreatedByID:          "private-creator-id",
		UpdatedByID:          "private-updater-id",
	}
	definition := mapListToSegment(list).SourceDefinition
	for _, forbidden := range []string{
		"filterBranch", "highly_sensitive_property", "9007199254740993",
		"metadata-secret", "private-user-id", "private-team-id",
		"private-creator-id", "private-updater-id",
	} {
		if strings.Contains(definition, forbidden) {
			t.Fatalf("unsafe value %q survived in source definition: %s", forbidden, definition)
		}
	}
	if !strings.Contains(definition, `"listId":"77"`) ||
		!strings.Contains(definition, `"listVersion":3`) ||
		!strings.Contains(definition, `"predicate_fidelity":"not_accessed_or_persisted"`) {
		t.Fatalf("safe structural evidence missing: %s", definition)
	}
}

func TestSnapshotFailsClosedWhenMembershipListVersionDoesNotMatchInventory(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Lists[0].ListVersion = 7
	fixture.Contacts = []hsObject{{
		ID:        "42",
		UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "ada@example.com",
			"hs_object_id":     "42",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
		},
	}}
	fixture.Memberships["42"] = []hsMembership{{ListID: "77", ListVersion: 8}}
	server := httptest.NewServer(fixture)
	defer server.Close()

	_, _, err := newTestHubSpotAdapter(server.URL).ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), "memberships were captured") {
		t.Fatalf("error = %v, want fail-closed membership/list-version mutation", err)
	}
}

func TestSnapshotFailsClosedWhenMembershipListIsMissingFromInventory(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{
		ID:        "42",
		UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "ada@example.com",
			"hs_object_id":     "42",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
		},
	}}
	fixture.Memberships["42"] = []hsMembership{{ListID: "88", ListVersion: 1}}
	server := httptest.NewServer(fixture)
	defer server.Close()

	_, _, err := newTestHubSpotAdapter(server.URL).ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), "missing from the exact list inventory") {
		t.Fatalf("error = %v, want fail-closed membership-only list", err)
	}
}

func TestSnapshotFailsClosedWhenMembershipObjectTypeDoesNotMatchContact(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{
		ID:        "42",
		UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "ada@example.com",
			"hs_object_id":     "42",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
		},
	}}
	fixture.RawResponse["/crm/lists/2026-03/records/memberships/batch/read"] =
		`{"status":"COMPLETE","results":[{"objectTypeId":"0-2","recordId":"42","recordListMemberships":[]}]}`
	server := httptest.NewServer(fixture)
	defer server.Close()

	_, _, err := newTestHubSpotAdapter(server.URL).ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) ||
		!strings.Contains(err.Error(), "non-contact object type") {
		t.Fatalf("error = %v, want fail-closed membership object type", err)
	}
}

func TestListSegmentsDoNotRequireUnsupportedDynamicFilterDefinition(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Lists[0].FilterBranch = nil
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	segments, err := ad.ListSegments(context.Background(), testHubSpotSession())
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 2 || fixture.sawPath("/crm/lists/2026-03") {
		t.Fatalf("segments=%#v paths=%#v", segments, fixture.Paths)
	}
}

func TestListSourceEventsUsesCurrentSearchContractAndAuthoritativeProjection(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Properties = append(fixture.Properties, hsProperty{Name: "favorite_plan", Label: "Plan", Type: "string"})
	fixture.Contacts = []hsObject{{
		ID:        "42",
		CreatedAt: "2026-05-01T12:00:00Z",
		UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "Ada@Example.com",
			"favorite_plan":    "Growth",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
			"createdate":       "2026-05-01T12:00:00Z",
			"hs_object_id":     "42",
		},
	}}
	fixture.SearchResults = []hsObject{{
		ID:        "42",
		UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "Ada@Example.com",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
			"hs_object_id":     "42",
		},
	}}
	fixture.SearchTotal = 2
	fixture.SearchNext = "1"
	fixture.Memberships["42"] = []hsMembership{{ListID: "77", ListVersion: 1}}
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	since := mustParseTime(t, "2026-05-12T10:00:00Z")
	batch, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), since, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 1 || batch.Events[0].Subscriber == nil || batch.NextCursor != "1" {
		t.Fatalf("batch = %#v", batch)
	}
	sub := batch.Events[0].Subscriber
	if sub.SourceID != "42" || sub.Status != canonical.StatusEnabled || sub.ConsentTimestamp == nil ||
		sub.CustomFields["hubspot_property_favorite_plan"] != "Growth" {
		t.Fatalf("authoritative subscriber = %#v", sub)
	}
	assertContains(t, sub.Tags, "hubspot:list:77")
	assertContains(t, sub.Tags, "hubspot:subscription:0:10")
	if !strings.HasPrefix(batch.Events[0].SourceID, "hubspot:contact:42:2026-05-12T11:00:00Z:") ||
		batch.Events[0].Payload["projection_hash"] == "" {
		t.Fatalf("event = %#v", batch.Events[0])
	}
	if batch.HighWatermark.Format(time.RFC3339) != "2026-05-12T11:00:00Z" {
		t.Fatalf("high watermark = %s", batch.HighWatermark)
	}
	if len(fixture.SearchBodies) != 1 {
		t.Fatalf("search bodies = %#v", fixture.SearchBodies)
	}
	body := fixture.SearchBodies[0]
	sorts, ok := body["sorts"].([]any)
	if !ok || len(sorts) != 1 {
		t.Fatalf("sorts = %#v", body["sorts"])
	}
	sortObject, ok := sorts[0].(map[string]any)
	if !ok || sortObject["propertyName"] != "lastmodifieddate" || sortObject["direction"] != "ASCENDING" {
		t.Fatalf("sort = %#v", sorts[0])
	}
	filterGroups := body["filterGroups"].([]any)
	filters := filterGroups[0].(map[string]any)["filters"].([]any)
	gotCutoff := filters[0].(map[string]any)["value"]
	wantCutoff := strconv.FormatInt(since.Add(-time.Second).UnixMilli(), 10)
	if gotCutoff != wantCutoff {
		t.Fatalf("search cutoff = %#v, want epoch millis %q", gotCutoff, wantCutoff)
	}
}

func TestListSourceEventsUsesProjectionHashForSameTimestampUpdates(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Properties = append(fixture.Properties, hsProperty{Name: "favorite_plan", Label: "Plan", Type: "string"})
	fixture.Contacts = []hsObject{{
		ID:        "42",
		UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "ada@example.com",
			"favorite_plan":    "Growth",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
			"hs_object_id":     "42",
		},
	}}
	fixture.SearchResults = []hsObject{{
		ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{"email": "ada@example.com", "lastmodifieddate": "2026-05-12T11:00:00Z", "hs_object_id": "42"},
	}}
	fixture.SearchTotal = 1
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	first, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), time.Time{}, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	fixture.Contacts[0].Properties["favorite_plan"] = "Enterprise"
	second, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), time.Time{}, "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 1 || len(second.Events) != 1 ||
		first.Events[0].SourceID == second.Events[0].SourceID ||
		first.Events[0].Payload["projection_hash"] == second.Events[0].Payload["projection_hash"] {
		t.Fatalf("same-timestamp projections = %#v / %#v", first.Events, second.Events)
	}
}

func TestListSourceEventsRejectsProviderSearchBoundsAndCursors(t *testing.T) {
	tests := []struct {
		name       string
		total      int
		results    []hsObject
		next       string
		cursor     string
		wantPhrase string
	}{
		{name: "over ten thousand", total: 10_001, wantPhrase: "10,000-result"},
		{name: "non numeric input cursor", cursor: "opaque", wantPhrase: "positive numeric"},
		{name: "next cursor on empty page", total: 1, next: "1", wantPhrase: "non-contiguous"},
		{name: "non progressing next cursor", total: 2, results: []hsObject{{ID: "42"}}, cursor: "1", next: "1", wantPhrase: "non-contiguous"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newHubSpotAPIFixture(t)
			fixture.SearchTotal = test.total
			fixture.SearchResults = test.results
			fixture.SearchNext = test.next
			if len(test.results) > 0 {
				fixture.Contacts = []hsObject{{
					ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
					Properties: map[string]string{"hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
				}}
			}
			server := httptest.NewServer(fixture)
			defer server.Close()
			ad := newTestHubSpotAdapter(server.URL)
			_, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), time.Time{}, test.cursor, 25)
			if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), test.wantPhrase) {
				t.Fatalf("error = %v, want %q", err, test.wantPhrase)
			}
		})
	}
}

func TestListSourceEventsFailsWhenTimestampMissing(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{ID: "42", Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42"}}}
	fixture.SearchResults = []hsObject{{ID: "42", Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42"}}}
	fixture.SearchTotal = 1
	server := httptest.NewServer(fixture)
	defer server.Close()

	ad := newTestHubSpotAdapter(server.URL)
	_, err := ad.ListSourceEvents(context.Background(), testHubSpotSession(), time.Time{}, "", 25)
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), "missing a stable timestamp") {
		t.Fatalf("error = %v, want missing timestamp failure", err)
	}
}

func TestAliasAndNonEmailEvidenceCoversProfilesWithoutValidPrimaryEmail(t *testing.T) {
	build := func(contactID, aliases string) (*hubSpotSnapshot, adapter.DiscoveryReport, SourceFingerprintEvidence) {
		fixture := newHubSpotAPIFixture(t)
		fixture.Contacts = []hsObject{{
			ID:        contactID,
			UpdatedAt: "2026-05-12T11:00:00Z",
			Properties: map[string]string{
				"email":                "not-an-email",
				"hs_additional_emails": aliases,
				"hs_object_id":         contactID,
			},
		}}
		server := httptest.NewServer(fixture)
		defer server.Close()
		ad := newTestHubSpotAdapter(server.URL)
		snapshot, err := ad.ensureSnapshot(context.Background(), testHubSpotSession())
		if err != nil {
			t.Fatal(err)
		}
		discovery, err := ad.Discover(context.Background(), testHubSpotSession())
		if err != nil {
			t.Fatal(err)
		}
		evidence, err := ad.SourceFingerprintEvidence(context.Background(), testHubSpotSession())
		if err != nil {
			t.Fatal(err)
		}
		return snapshot, discovery, evidence
	}

	firstSnapshot, firstDiscovery, firstEvidence := build("42", "Alias@Example.com;SECOND@example.com;alias@example.com")
	if firstDiscovery.SubscribersTotal != 0 || firstDiscovery.ProfilesWithoutEmailTotal != 1 ||
		firstDiscovery.AdditionalEmailIdentitiesTotal != 2 {
		t.Fatalf("discovery = %#v", firstDiscovery)
	}
	if firstEvidence.ProfilesWithoutEmailCount != 1 || firstEvidence.AdditionalEmailCount != 2 ||
		firstEvidence.ProfilesWithoutEmailDigest == "" || firstEvidence.AdditionalEmailDigest == "" {
		t.Fatalf("evidence = %#v", firstEvidence)
	}

	aliasMutation, _, aliasEvidence := build("42", "replacement@example.com;SECOND@example.com")
	if aliasEvidence.AdditionalEmailCount != firstEvidence.AdditionalEmailCount ||
		aliasEvidence.AdditionalEmailDigest == firstEvidence.AdditionalEmailDigest ||
		aliasMutation.Fingerprint == firstSnapshot.Fingerprint {
		t.Fatalf("same-count alias mutation was not fingerprinted: %#v / %#v", firstEvidence, aliasEvidence)
	}
	identityMutation, _, identityEvidence := build("43", "Alias@Example.com;SECOND@example.com")
	if identityEvidence.ProfilesWithoutEmailCount != firstEvidence.ProfilesWithoutEmailCount ||
		identityEvidence.ProfilesWithoutEmailDigest == firstEvidence.ProfilesWithoutEmailDigest ||
		identityMutation.Fingerprint == firstSnapshot.Fingerprint {
		t.Fatalf("same-count non-email identity replacement was not fingerprinted: %#v / %#v", firstEvidence, identityEvidence)
	}
}

func TestSameCountMembershipMutationChangesSnapshot(t *testing.T) {
	build := func(listID string) (*hubSpotSnapshot, adapter.DiscoveryReport) {
		fixture := newHubSpotAPIFixture(t)
		fixture.Lists = []hsList{
			{ID: "77", ListVersion: 1, Name: "One", ObjectTypeID: "0-1", ProcessingType: "MANUAL", ProcessingStatus: "COMPLETE"},
			{ID: "88", ListVersion: 1, Name: "Two", ObjectTypeID: "0-1", ProcessingType: "MANUAL", ProcessingStatus: "COMPLETE"},
		}
		fixture.Contacts = []hsObject{{
			ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
			Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
		}}
		fixture.Memberships["42"] = []hsMembership{{ListID: listID, ListVersion: 1}}
		server := httptest.NewServer(fixture)
		defer server.Close()
		ad := newTestHubSpotAdapter(server.URL)
		snapshot, err := ad.ensureSnapshot(context.Background(), testHubSpotSession())
		if err != nil {
			t.Fatal(err)
		}
		discovery, err := ad.Discover(context.Background(), testHubSpotSession())
		if err != nil {
			t.Fatal(err)
		}
		return snapshot, discovery
	}
	first, firstDiscovery := build("77")
	second, secondDiscovery := build("88")
	if first.Fingerprint == second.Fingerprint {
		t.Fatal("same-count membership move did not alter the source fingerprint")
	}
	if firstDiscovery.SnapshotMembershipCounts["hubspot:list:77"] != 1 ||
		firstDiscovery.SnapshotMembershipCounts["hubspot:list:88"] != 0 ||
		secondDiscovery.SnapshotMembershipCounts["hubspot:list:77"] != 0 ||
		secondDiscovery.SnapshotMembershipCounts["hubspot:list:88"] != 1 {
		t.Fatalf("membership vectors = %#v / %#v", firstDiscovery.SnapshotMembershipCounts, secondDiscovery.SnapshotMembershipCounts)
	}
}

func TestAllContactPropertiesBeyondLegacyCapAreHydratedAndFingerprinted(t *testing.T) {
	build := func(mutateLabel bool) (*hubSpotSnapshot, *hubSpotAPIFixture) {
		fixture := newHubSpotAPIFixture(t)
		properties := append([]hsProperty(nil), fixture.Properties...)
		values := map[string]string{
			"email":            "ada@example.com",
			"hs_object_id":     "42",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
		}
		for index := 0; index < 130; index++ {
			name := fmt.Sprintf("custom_%03d", index)
			label := "Colliding label"
			if mutateLabel && index == 129 {
				label = "Mutated definition"
			}
			properties = append(properties, hsProperty{Name: name, Label: label, Type: "string"})
			values[name] = fmt.Sprintf("value-%03d", index)
		}
		fixture.Properties = properties
		fixture.Contacts = []hsObject{{ID: "42", UpdatedAt: "2026-05-12T11:00:00Z", Properties: values}}
		server := httptest.NewServer(fixture)
		defer server.Close()
		ad := newTestHubSpotAdapter(server.URL)
		snapshot, err := ad.ensureSnapshot(context.Background(), testHubSpotSession())
		if err != nil {
			t.Fatal(err)
		}
		return snapshot, fixture
	}
	first, fixture := build(false)
	if len(first.Subscribers) != 1 {
		t.Fatalf("subscribers = %d", len(first.Subscribers))
	}
	for index := 0; index < 130; index++ {
		name := fmt.Sprintf("hubspot_property_custom_%03d", index)
		if first.Subscribers[0].CustomFields[name] != fmt.Sprintf("value-%03d", index) {
			t.Fatalf("missing %s from %#v", name, first.Subscribers[0].CustomFields)
		}
	}
	if len(fixture.PropertyChunks) < 2 {
		t.Fatalf("property chunks = %d, want multiple complete chunks", len(fixture.PropertyChunks))
	}
	second, _ := build(true)
	if len(first.ContactProperties) != len(second.ContactProperties) ||
		first.ContactPropertiesDigest == second.ContactPropertiesDigest ||
		first.Fingerprint == second.Fingerprint {
		t.Fatalf("same-count property-definition mutation was not fingerprinted")
	}
}

func TestSnapshotAggregateByteBudgetFailsClosed(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{
		ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
		Properties: map[string]string{
			"email":            "ada@example.com",
			"hs_object_id":     "42",
			"lastmodifieddate": "2026-05-12T11:00:00Z",
			"large_value":      strings.Repeat("x", 16_000),
		},
	}}
	fixture.Properties = append(fixture.Properties, hsProperty{Name: "large_value", Label: "Large", Type: "string"})
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)
	ad.snapshotByteLimit = 8 << 10

	_, err := ad.Discover(context.Background(), testHubSpotSession())
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), "aggregate memory-safety bound") {
		t.Fatalf("error = %v, want bounded snapshot failure", err)
	}
}

func TestDailyPreferenceBudgetIncludesRaceSafetyReserve(t *testing.T) {
	tests := []struct {
		name      string
		usage     int64
		wantError bool
	}{
		{name: "reserve remains", usage: 94_900},
		{name: "exact preference calls but no reserve", usage: 99_997, wantError: true},
		{name: "reserve boundary short by one", usage: 94_998, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newHubSpotAPIFixture(t)
			fixture.DailyLimit = 100_000
			fixture.DailyUsage = test.usage
			server := httptest.NewServer(fixture)
			defer server.Close()
			ad := newTestHubSpotAdapter(server.URL)
			err := ad.ensureDailyRequestBudget(context.Background(), testHubSpotSession(), 2)
			if test.wantError {
				var rateLimited *adapter.ErrRateLimited
				if err == nil || !errors.As(err, &rateLimited) {
					t.Fatalf("error = %v, want rate limited", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPreferenceScopeAndRequiredEnvelopesFailClosed(t *testing.T) {
	t.Run("missing preference scope", func(t *testing.T) {
		fixture := newHubSpotAPIFixture(t)
		fixture.Contacts = []hsObject{{
			ID: "42", UpdatedAt: "2026-05-12T11:00:00Z",
			Properties: map[string]string{"email": "ada@example.com", "hs_object_id": "42", "lastmodifieddate": "2026-05-12T11:00:00Z"},
		}}
		fixture.FailStatus["/communication-preferences/2026-03/statuses/ada@example.com"] = http.StatusForbidden
		server := httptest.NewServer(fixture)
		defer server.Close()
		ad := newTestHubSpotAdapter(server.URL)
		_, err := ad.Discover(context.Background(), testHubSpotSession())
		if err == nil || !errors.Is(err, adapter.ErrAuth) {
			t.Fatalf("error = %v, want missing-scope auth failure", err)
		}
	})
	t.Run("null property results", func(t *testing.T) {
		fixture := newHubSpotAPIFixture(t)
		fixture.RawResponse["/crm/properties/2026-03/contacts"] = `{"results":null}`
		server := httptest.NewServer(fixture)
		defer server.Close()
		ad := newTestHubSpotAdapter(server.URL)
		_, err := ad.Discover(context.Background(), testHubSpotSession())
		if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), "required results") {
			t.Fatalf("error = %v, want null envelope failure", err)
		}
	})
	t.Run("duplicate JSON key", func(t *testing.T) {
		fixture := newHubSpotAPIFixture(t)
		fixture.RawResponse["/crm/properties/2026-03/contacts"] = `{"results":[],"results":[]}`
		server := httptest.NewServer(fixture)
		defer server.Close()
		ad := newTestHubSpotAdapter(server.URL)
		_, err := ad.Discover(context.Background(), testHubSpotSession())
		if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) || !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("error = %v, want duplicate-key failure", err)
		}
	})
}

func TestProviderFourHundredsAreClassifiedAsSourceUnavailable(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.FailStatus["/crm/properties/2026-03/contacts"] = http.StatusBadRequest
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	_, err := ad.Discover(context.Background(), testHubSpotSession())
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) {
		t.Fatalf("error = %v, want source-unavailable classification", err)
	}
}

func TestProviderErrorsDoNotExposeResponseBodiesOrEmailPaths(t *testing.T) {
	const sensitiveEmail = "private.person@example.com"
	const sensitiveToken = "pat-secret-material"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "failed for "+sensitiveEmail+" with "+sensitiveToken, http.StatusBadRequest)
	}))
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	var out map[string]any
	err := ad.do(
		context.Background(),
		testHubSpotSession(),
		http.MethodGet,
		"/communication-preferences/2026-03/statuses/"+url.PathEscape(sensitiveEmail)+"?channel=EMAIL",
		nil,
		&out,
	)
	if err == nil || !errors.Is(err, adapter.ErrSourceUnavailable) {
		t.Fatalf("error = %v, want source unavailable", err)
	}
	message := err.Error()
	for _, sensitive := range []string{sensitiveEmail, sensitiveToken, "communication-preferences", "failed for"} {
		if strings.Contains(message, sensitive) {
			t.Fatalf("provider PII leaked in error %q", message)
		}
	}
}

func TestSnapshotPaginationUsesBoundFingerprintCursor(t *testing.T) {
	fixture := newHubSpotAPIFixture(t)
	fixture.Lists = nil
	fixture.Definitions = nil
	for index := 1; index <= 101; index++ {
		id := strconv.Itoa(index)
		fixture.Contacts = append(fixture.Contacts, hsObject{
			ID: id, UpdatedAt: "2026-05-12T11:00:00Z",
			Properties: map[string]string{
				"email":            fmt.Sprintf("contact-%03d@example.com", index),
				"hs_object_id":     id,
				"lastmodifieddate": "2026-05-12T11:00:00Z",
			},
		})
	}
	server := httptest.NewServer(fixture)
	defer server.Close()
	ad := newTestHubSpotAdapter(server.URL)

	first, cursor, err := ad.ListSubscribers(context.Background(), testHubSpotSession(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 100 || cursor == "" {
		t.Fatalf("first page = %d cursor=%q", len(first), cursor)
	}
	second, next, err := ad.ListSubscribers(context.Background(), testHubSpotSession(), cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || next != "" {
		t.Fatalf("second page = %d next=%q", len(second), next)
	}
	decoded, err := decodeHubSpotSnapshotCursor(cursor, "wrong-fingerprint", "subscribers", 101)
	if err == nil || decoded != 0 || !errors.Is(err, adapter.ErrSourceUnavailable) {
		t.Fatalf("stale cursor result = %d/%v", decoded, err)
	}
}

func assertContains(t *testing.T, values []string, want string) {
	t.Helper()
	for _, value := range values {
		if value == want {
			return
		}
	}
	t.Fatalf("%q not found in %#v", want, values)
}

func mustParseTime(t *testing.T, raw string) time.Time {
	t.Helper()
	value, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func decodeRequestJSON(t *testing.T, r *http.Request, out any) {
	t.Helper()
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(out); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
