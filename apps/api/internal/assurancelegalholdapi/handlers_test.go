// SPDX-License-Identifier: AGPL-3.0-only

package assurancelegalholdapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/assurancelegalhold"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The store the handlers own. Legal holds are placed by people during an
// incident, so the surface has to be legible: the reason is mandatory, the
// scope is explicit, and a release is a distinct act with its own reason.

var (
	testTenantID   = "11111111-1111-4111-8111-111111111111"
	testCampaignID = "22222222-2222-4222-8222-222222222222"
	testActorID    = "33333333-3333-4333-8333-333333333333"
	testHoldID     = "44444444-4444-4444-8444-444444444444"
)

type fakeHoldStore struct {
	placed     assurancelegalhold.PlaceInput
	placeErr   error
	released   assurancelegalhold.ReleaseInput
	releaseErr error
	listed     []assurancelegalhold.Hold
	listErr    error

	placeCalls, releaseCalls, listCalls int
}

func (f *fakeHoldStore) Place(_ context.Context, input assurancelegalhold.PlaceInput) (assurancelegalhold.Hold, error) {
	f.placeCalls++
	f.placed = input
	if f.placeErr != nil {
		return assurancelegalhold.Hold{}, f.placeErr
	}
	return assurancelegalhold.Hold{
		ID: testHoldID, TenantID: input.TenantID, CampaignID: input.CampaignID,
		Reason: input.Reason, PlacedAt: time.Unix(0, 0).UTC(),
	}, nil
}

func (f *fakeHoldStore) Release(_ context.Context, input assurancelegalhold.ReleaseInput) error {
	f.releaseCalls++
	f.released = input
	return f.releaseErr
}

func (f *fakeHoldStore) List(_ context.Context, _ string) ([]assurancelegalhold.Hold, error) {
	f.listCalls++
	return f.listed, f.listErr
}

func routerWith(store HoldStore) http.Handler {
	router := chi.NewRouter()
	Mount(router, &Deps{Store: store})
	return router
}

func request(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: testTenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: testActorID, TenantID: testTenantID, Role: "admin"})
	return req.WithContext(ctx)
}

func TestPlacingAHoldRecordsScopeReasonAndActor(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds",
		`{"campaign_id":"`+testCampaignID+`","reason":"litigation hold ACME-1"}`))

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s, want 201", recorder.Code, recorder.Body.String())
	}
	if store.placed.TenantID != testTenantID {
		t.Errorf("tenant = %q, want %q", store.placed.TenantID, testTenantID)
	}
	if store.placed.CampaignID != testCampaignID {
		t.Errorf("campaign = %q, want %q", store.placed.CampaignID, testCampaignID)
	}
	if store.placed.Reason != "litigation hold ACME-1" {
		t.Errorf("reason = %q", store.placed.Reason)
	}
	// The actor comes from the authenticated principal, never the body: a hold
	// is an accountability record and a caller-supplied actor is not one.
	if store.placed.PlacedByUserID != testActorID {
		t.Errorf("actor = %q, want the authenticated principal %q", store.placed.PlacedByUserID, testActorID)
	}
}

// A tenant-wide hold is the blunt instrument used when nobody yet knows which
// campaign is implicated. Omitting the campaign has to mean that, not fail.
func TestOmittingTheCampaignPlacesATenantWideHold(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds", `{"reason":"regulator request"}`))

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s, want 201", recorder.Code, recorder.Body.String())
	}
	if store.placed.CampaignID != "" {
		t.Errorf("campaign = %q, want empty (tenant-wide)", store.placed.CampaignID)
	}
}

func TestABlankReasonIsRejectedBeforeTheStore(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds", `{"reason":"   "}`))

	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s, want 422", recorder.Code, recorder.Body.String())
	}
	if store.placeCalls != 0 {
		t.Errorf("store called %d times for an invalid request, want 0", store.placeCalls)
	}
}

// A duplicate is a conflict, not a server error: the operator's mental model is
// "it is already held", and 409 says exactly that.
func TestADuplicateHoldReportsConflict(t *testing.T) {
	store := &fakeHoldStore{placeErr: assurancelegalhold.ErrAlreadyHeld}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds",
		`{"campaign_id":"`+testCampaignID+`","reason":"second"}`))

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409", recorder.Code, recorder.Body.String())
	}
}

func TestReleasingAHoldRequiresItsOwnReason(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds/"+testHoldID+"/release", `{"reason":""}`))

	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s, want 422", recorder.Code, recorder.Body.String())
	}
	if store.releaseCalls != 0 {
		t.Errorf("store called %d times for an invalid release, want 0", store.releaseCalls)
	}
}

func TestReleasingAHoldRecordsTheActorAndReason(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds/"+testHoldID+"/release",
		`{"reason":"matter closed"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200", recorder.Code, recorder.Body.String())
	}
	if store.released.HoldID != testHoldID || store.released.TenantID != testTenantID {
		t.Errorf("release targeted %+v", store.released)
	}
	if store.released.Reason != "matter closed" {
		t.Errorf("release reason = %q", store.released.Reason)
	}
	if store.released.ReleasedByUserID != testActorID {
		t.Errorf("release actor = %q, want the authenticated principal", store.released.ReleasedByUserID)
	}
}

// Releasing something that is not held is the operator's answer to "did my
// release land?" — it must be 404, not a silent 200.
func TestReleasingAnAbsentHoldIsNotFound(t *testing.T) {
	store := &fakeHoldStore{releaseErr: assurancelegalhold.ErrNotHeld}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds/"+testHoldID+"/release", `{"reason":"matter closed"}`))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want 404", recorder.Code, recorder.Body.String())
	}
}

func TestListingReturnsScopeAndReasonForEachHold(t *testing.T) {
	store := &fakeHoldStore{listed: []assurancelegalhold.Hold{
		{ID: testHoldID, TenantID: testTenantID, CampaignID: testCampaignID,
			Reason: "litigation hold ACME-1", PlacedAt: time.Unix(0, 0).UTC()},
		{ID: uuid.NewString(), TenantID: testTenantID, Reason: "regulator request",
			PlacedAt: time.Unix(0, 0).UTC()},
	}}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodGet,
		"/api/v1/assurance/legal-holds", ""))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Holds []struct {
			ID         string `json:"id"`
			CampaignID string `json:"campaign_id"`
			Scope      string `json:"scope"`
			Reason     string `json:"reason"`
		} `json:"holds"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, recorder.Body.String())
	}
	if len(payload.Holds) != 2 {
		t.Fatalf("holds = %d, want 2", len(payload.Holds))
	}
	// `scope` is derived, not inferred by the reader: an empty campaign_id
	// meaning "everything" is exactly the kind of thing an operator misreads
	// during an incident.
	if payload.Holds[0].Scope != "campaign" {
		t.Errorf("scope[0] = %q, want campaign", payload.Holds[0].Scope)
	}
	if payload.Holds[1].Scope != "tenant" {
		t.Errorf("scope[1] = %q, want tenant", payload.Holds[1].Scope)
	}
}

func TestAnUnwiredStoreRefusesRatherThanPretending(t *testing.T) {
	recorder := httptest.NewRecorder()

	routerWith(nil).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds", `{"reason":"regulator request"}`))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503", recorder.Code)
	}
}

// Suspending evidence deletion across a tenant is a governance act, not an
// editing one. An editor who can change a campaign must not be able to freeze
// its retention.
func TestAnEditorCannotPlaceAHold(t *testing.T) {
	store := &fakeHoldStore{}
	req := request(http.MethodPost, "/api/v1/assurance/legal-holds",
		`{"reason":"litigation hold ACME-1"}`)
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID: testActorID, TenantID: testTenantID, Role: "editor",
	})
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, req.WithContext(ctx))

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s, want 403", recorder.Code, recorder.Body.String())
	}
	if store.placeCalls != 0 {
		t.Errorf("store called %d times for a forbidden request, want 0", store.placeCalls)
	}
}

func TestAnAPIKeyCannotActAsAHumanLegalHoldReviewer(t *testing.T) {
	tests := []struct {
		name, method, path, body string
	}{
		{"place", http.MethodPost, "/api/v1/assurance/legal-holds", `{"reason":"litigation hold ACME-1"}`},
		{"list", http.MethodGet, "/api/v1/assurance/legal-holds", ""},
		{"release", http.MethodPost, "/api/v1/assurance/legal-holds/" + testHoldID + "/release", `{"reason":"matter closed"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeHoldStore{}
			req := request(test.method, test.path, test.body)
			// Even a key carrying an admin-looking user context cannot prove the
			// current/effective dashboard role. The session-only boundary must run
			// before the role gate and before the store.
			req = req.WithContext(middleware.WithAPIKeyAuth(req.Context()))
			recorder := httptest.NewRecorder()

			routerWith(store).ServeHTTP(recorder, req)

			if recorder.Code != http.StatusForbidden {
				t.Fatalf("status=%d body=%s, want 403", recorder.Code, recorder.Body.String())
			}
			if store.placeCalls != 0 || store.listCalls != 0 || store.releaseCalls != 0 {
				t.Fatalf("store calls=(place=%d list=%d release=%d), want zero",
					store.placeCalls, store.listCalls, store.releaseCalls)
			}
		})
	}
}

func TestViewAsDowngradeCannotPlaceAHold(t *testing.T) {
	store := &fakeHoldStore{}
	req := request(http.MethodPost, "/api/v1/assurance/legal-holds",
		`{"reason":"litigation hold ACME-1"}`)
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID: testActorID, TenantID: testTenantID, Role: "owner", EffectiveRole: "viewer",
	})
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, req.WithContext(ctx))

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s, want 403", recorder.Code, recorder.Body.String())
	}
	if store.placeCalls != 0 {
		t.Errorf("store called %d times in viewer mode, want 0", store.placeCalls)
	}
}

func TestPlaceRejectsMalformedCampaignIDBeforeTheStore(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds",
		`{"campaign_id":"not-a-uuid","reason":"regulator request"}`))

	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s, want 422", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "invalid_campaign_id") {
		t.Fatalf("body=%s, want invalid_campaign_id", recorder.Body.String())
	}
	if store.placeCalls != 0 {
		t.Errorf("store called %d times for malformed campaign id, want 0", store.placeCalls)
	}
}

func TestReleaseRejectsMalformedHoldIDBeforeTheStore(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds/not-a-uuid/release",
		`{"reason":"matter closed"}`))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "invalid_hold_id") {
		t.Fatalf("body=%s, want invalid_hold_id", recorder.Body.String())
	}
	if store.releaseCalls != 0 {
		t.Errorf("store called %d times for malformed hold id, want 0", store.releaseCalls)
	}
}

func TestReasonsAreBoundedBeforeTheStore(t *testing.T) {
	tests := []struct {
		name string
		path string
		body string
	}{
		{
			name: "place",
			path: "/api/v1/assurance/legal-holds",
			body: `{"reason":"` + strings.Repeat("x", assurancelegalhold.MaxReasonCharacters+1) + `"}`,
		},
		{
			name: "release",
			path: "/api/v1/assurance/legal-holds/" + testHoldID + "/release",
			body: `{"reason":"` + strings.Repeat("x", assurancelegalhold.MaxReasonCharacters+1) + `"}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeHoldStore{}
			recorder := httptest.NewRecorder()
			routerWith(store).ServeHTTP(recorder, request(http.MethodPost, test.path, test.body))

			if recorder.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%s, want 422", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), "reason_too_long") {
				t.Fatalf("body=%s, want reason_too_long", recorder.Body.String())
			}
			if store.placeCalls != 0 || store.releaseCalls != 0 {
				t.Fatalf("store calls=(place=%d release=%d), want zero",
					store.placeCalls, store.releaseCalls)
			}
		})
	}
}

func TestReasonCharacterBoundaryMatchesTheDatabaseTextContract(t *testing.T) {
	store := &fakeHoldStore{}
	recorder := httptest.NewRecorder()
	reason := strings.Repeat("é", assurancelegalhold.MaxReasonCharacters)

	routerWith(store).ServeHTTP(recorder, request(http.MethodPost,
		"/api/v1/assurance/legal-holds", `{"reason":"`+reason+`"}`))

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s, want 201", recorder.Code, recorder.Body.String())
	}
	if store.placeCalls != 1 || store.placed.Reason != reason {
		t.Fatalf("store call=%d reason characters=%d, want one exact 2000-character reason",
			store.placeCalls, len([]rune(store.placed.Reason)))
	}
}

func TestOversizedBodiesPreserveTheFourKiB413Contract(t *testing.T) {
	tests := []string{
		"/api/v1/assurance/legal-holds",
		"/api/v1/assurance/legal-holds/" + testHoldID + "/release",
	}
	for _, path := range tests {
		t.Run(path, func(t *testing.T) {
			store := &fakeHoldStore{}
			recorder := httptest.NewRecorder()
			body := `{"reason":"` + strings.Repeat("x", int(holdBodyMaxBytes)) + `"}`
			routerWith(store).ServeHTTP(recorder, request(http.MethodPost, path, body))

			if recorder.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status=%d body=%s, want 413", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), "payload_too_large") {
				t.Fatalf("body=%s, want payload_too_large", recorder.Body.String())
			}
			if store.placeCalls != 0 || store.releaseCalls != 0 {
				t.Fatalf("store calls=(place=%d release=%d), want zero",
					store.placeCalls, store.releaseCalls)
			}
		})
	}
}
