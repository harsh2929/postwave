// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCampaignPollCursorIsOpaqueAuthenticatedAndContextBound(t *testing.T) {
	now := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	ring := testTokenKeyring(now)
	// Dots are legal key-id characters but also cursor separators. The cursor
	// encodes the key id so every configured key can round-trip safely.
	ring.ActiveKeyID = "poll.test-2026"
	ring.Keys[0].ID = ring.ActiveKeyID
	repo := &Repo{Pool: new(db.Pool), TokenKeyring: ring, Now: func() time.Time { return now }}
	tenantID := uuid.NewString()
	campaignID := uuid.NewString()
	revisionID := uuid.NewString()
	pollID := uuid.NewString()
	createdAt := now.Add(-time.Hour).Add(123456 * time.Microsecond)

	cursor, err := repo.encodeCampaignPollCursor(
		tenantID, campaignID, revisionID, createdAt, pollID,
	)
	if err != nil {
		t.Fatalf("encodeCampaignPollCursor: %v", err)
	}
	if len(cursor) > MaxCampaignPollCursorBytes {
		t.Fatalf("cursor length=%d, max=%d", len(cursor), MaxCampaignPollCursorBytes)
	}
	for _, rawContext := range []string{tenantID, campaignID, revisionID} {
		if strings.Contains(cursor, rawContext) {
			t.Fatalf("cursor exposed raw context %q: %s", rawContext, cursor)
		}
	}
	boundary, err := repo.decodeCampaignPollCursor(cursor, tenantID, campaignID, revisionID)
	if err != nil {
		t.Fatalf("decodeCampaignPollCursor: %v", err)
	}
	if boundary.ID != pollID || !boundary.CreatedAt.Equal(createdAt) {
		t.Fatalf("boundary=%+v, want id=%s created_at=%s", boundary, pollID, createdAt)
	}

	contexts := [][3]string{
		{uuid.NewString(), campaignID, revisionID},
		{tenantID, uuid.NewString(), revisionID},
		{tenantID, campaignID, uuid.NewString()},
		{tenantID, campaignID, ""},
	}
	for _, context := range contexts {
		if _, err := repo.decodeCampaignPollCursor(cursor, context[0], context[1], context[2]); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("context-mismatched cursor err=%v, want invalid input", err)
		}
	}

	tampered := cursor[:len(cursor)-1] + "A"
	if tampered == cursor {
		tampered = cursor[:len(cursor)-1] + "B"
	}
	if _, err := repo.decodeCampaignPollCursor(tampered, tenantID, campaignID, revisionID); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("tampered cursor err=%v, want invalid input", err)
	}
}

func TestCampaignPollListQueryIsStrictAndBoundedBeforeDatabaseAccess(t *testing.T) {
	now := time.Now().UTC()
	tenantID := uuid.NewString()
	campaignID := uuid.NewString()
	repo := &Repo{Pool: new(db.Pool), TokenKeyring: testTokenKeyring(now)}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(middleware.WithTenant(
				r.Context(), &middleware.Tenant{ID: tenantID},
			)))
		})
	})
	if err := MountAdminRoutes(AdminRouters{
		ReadCampaigns: router, WriteCampaigns: router, ReadReports: router,
	}, &Deps{Repo: repo}); err != nil {
		t.Fatalf("MountAdminRoutes: %v", err)
	}
	staleContextCursor, err := repo.encodeCampaignPollCursor(
		tenantID, uuid.NewString(), "", now.Add(-time.Minute), uuid.NewString(),
	)
	if err != nil {
		t.Fatalf("encode stale-context cursor: %v", err)
	}

	targets := []string{
		"?limit=0", "?limit=101", "?limit=not-a-number", "?limit=1&limit=2",
		"?cursor=", "?cursor=not-a-cursor", "?cursor=" + strings.Repeat("a", 513),
		"?cursor=" + staleContextCursor,
	}
	for _, suffix := range targets {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
			"/api/v1/campaigns/"+campaignID+"/polls"+suffix, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d body=%s, want 400", suffix, recorder.Code, recorder.Body.String())
		}
	}
}

func TestCampaignPollListDefaultsAndTerminalCursorOmission(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/polls", nil)
	input, err := campaignPollListInput(request)
	if err != nil {
		t.Fatal(err)
	}
	if input.Limit != DefaultCampaignPollListLimit || input.Cursor != "" {
		t.Fatalf("default input=%+v", input)
	}
	encoded, err := json.Marshal(CampaignPollListPage{Items: []Definition{}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"items":[]}` {
		t.Fatalf("terminal page JSON=%s, want next_cursor omitted", encoded)
	}
}
