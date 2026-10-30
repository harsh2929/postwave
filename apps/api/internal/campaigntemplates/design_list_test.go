// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type designDraftListStoreStub struct {
	DesignDraftStore
	items    []DesignDraftSummary
	tenantID string
	actor    ReferenceReviewActor
	limit    int
	cursor   designDraftCursorPosition
	returned error
}

type designDraftCreateReplayStoreStub struct {
	DesignDraftStore
}

func (*designDraftCreateReplayStoreStub) Create(
	_ context.Context,
	record designDraftCreateRecord,
) (*DesignDraft, bool, error) {
	now := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	return &DesignDraft{
		ID:   "11111111-1111-4111-8111-111111111111",
		Mode: record.Input.Mode, Status: designDraftStatusQueued,
		ExpiresAt: now.Add(30 * 24 * time.Hour),
		CreatedAt: now, UpdatedAt: now,
	}, true, nil
}

func (store *designDraftListStoreStub) ListRecoverable(
	_ context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	limit int,
	cursor designDraftCursorPosition,
) ([]DesignDraftSummary, error) {
	store.tenantID = tenantID
	store.actor = actor
	store.limit = limit
	store.cursor = cursor
	return append([]DesignDraftSummary(nil), store.items...), store.returned
}

func TestDesignDraftRecoveryCursorIsStrictAndActorBound(t *testing.T) {
	actor := ReferenceReviewActor{Type: "user", ID: "user-1"}
	last := DesignDraftSummary{
		ID: "11111111-1111-4111-8111-111111111111",
		UpdatedAt: time.Date(
			2026, time.July, 30, 12, 30, 45, 123456789, time.UTC,
		),
	}
	cursor := encodeDesignDraftCursor(last, "tenant-1", actor)
	position, err := decodeDesignDraftCursor(cursor, "tenant-1", actor)
	if err != nil {
		t.Fatalf("decode exact cursor: %v", err)
	}
	if position.DesignID != last.ID ||
		!position.UpdatedAt.Equal(last.UpdatedAt) {
		t.Fatalf("position=%#v, want id/time from %#v", position, last)
	}
	for name, decode := range map[string]func() error{
		"other tenant": func() error {
			_, err := decodeDesignDraftCursor(cursor, "tenant-2", actor)
			return err
		},
		"other actor": func() error {
			_, err := decodeDesignDraftCursor(
				cursor,
				"tenant-1",
				ReferenceReviewActor{Type: "user", ID: "user-2"},
			)
			return err
		},
		"malformed": func() error {
			_, err := decodeDesignDraftCursor("not-base64*", "tenant-1", actor)
			return err
		},
		"unknown field": func() error {
			raw := base64.RawURLEncoding.EncodeToString(
				[]byte(`{"v":1,"b":"x","u":"2026-07-30T12:00:00Z","i":"11111111-1111-4111-8111-111111111111","extra":true}`),
			)
			_, err := decodeDesignDraftCursor(raw, "tenant-1", actor)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := decode(); !errors.Is(err, ErrInvalidDesignDraftCursor) {
				t.Fatalf("error=%v, want ErrInvalidDesignDraftCursor", err)
			}
		})
	}
}

func TestListRecoverableDesignDraftsReturnsBoundedSummaryPage(t *testing.T) {
	updatedAt := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	store := &designDraftListStoreStub{
		items: []DesignDraftSummary{
			{
				ID:     "11111111-1111-4111-8111-111111111111",
				Status: "queued", UpdatedAt: updatedAt.Add(2 * time.Minute),
			},
			{
				ID:     "22222222-2222-4222-8222-222222222222",
				Status: "ready", UpdatedAt: updatedAt.Add(time.Minute),
			},
			{
				ID:     "33333333-3333-4333-8333-333333333333",
				Status: "failed", UpdatedAt: updatedAt,
			},
		},
	}
	actor := ReferenceReviewActor{Type: "user", ID: "user-1"}
	page, err := (&Deps{Designs: store}).ListRecoverableDesignDrafts(
		context.Background(),
		"tenant-1",
		actor,
		DesignDraftListFilter{Limit: 2},
	)
	if err != nil {
		t.Fatalf("ListRecoverableDesignDrafts: %v", err)
	}
	if store.tenantID != "tenant-1" || store.actor != actor ||
		store.limit != 3 || !store.cursor.UpdatedAt.IsZero() {
		t.Fatalf(
			"store call tenant=%q actor=%#v limit=%d cursor=%#v",
			store.tenantID,
			store.actor,
			store.limit,
			store.cursor,
		)
	}
	if len(page.Items) != 2 || page.NextCursor == "" {
		t.Fatalf("page=%#v, want two items and next cursor", page)
	}
	position, err := decodeDesignDraftCursor(
		page.NextCursor,
		"tenant-1",
		actor,
	)
	if err != nil {
		t.Fatalf("decode next cursor: %v", err)
	}
	if position.DesignID != page.Items[1].ID ||
		!position.UpdatedAt.Equal(page.Items[1].UpdatedAt) {
		t.Fatalf("next position=%#v, last item=%#v", position, page.Items[1])
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("marshal page: %v", err)
	}
	if strings.Contains(string(encoded), `"request"`) ||
		strings.Contains(string(encoded), `"revision"`) {
		t.Fatalf("recovery page contains an unbounded detail field: %s", encoded)
	}
}

func TestListDesignDraftsHandlerRequiresActorAndValidBounds(t *testing.T) {
	store := &designDraftListStoreStub{items: []DesignDraftSummary{}}
	deps := &Deps{Designs: store}
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/campaign-template-designs?limit=17",
		nil,
	)
	ctx := middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "user-1", TenantID: "tenant-1", Role: "editor",
	})
	response := httptest.NewRecorder()
	deps.ListDesignDrafts(response, request.WithContext(ctx))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q, want private, no-store", got)
	}
	if !strings.Contains(response.Body.String(), `"generation_available":false`) {
		t.Fatalf("missing fail-closed capability: %s", response.Body.String())
	}
	deps.Repo = &templateRepositoryStub{}
	deps.Generator = NewHTTPTemplateGenerator("http://voice.internal:8083", "")
	configured := httptest.NewRecorder()
	deps.ListDesignDrafts(configured, request.WithContext(ctx))
	if configured.Code != http.StatusOK ||
		!strings.Contains(configured.Body.String(), `"generation_available":true`) {
		t.Fatalf("configured capability status=%d body=%s", configured.Code, configured.Body.String())
	}
	if store.actor.Type != "user" || store.actor.ID != "user-1" ||
		store.limit != 18 {
		t.Fatalf("actor=%#v limit=%d", store.actor, store.limit)
	}

	missingActor := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/campaign-template-designs",
		nil,
	)
	missingActor = missingActor.WithContext(middleware.WithTenant(
		missingActor.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	))
	response = httptest.NewRecorder()
	deps.ListDesignDrafts(response, missingActor)
	if response.Code != http.StatusUnauthorized ||
		!strings.Contains(response.Body.String(), "design_actor_required") {
		t.Fatalf(
			"missing actor status=%d body=%s",
			response.Code,
			response.Body.String(),
		)
	}

	invalid := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/campaign-template-designs?limit=51",
		nil,
	)
	response = httptest.NewRecorder()
	deps.ListDesignDrafts(response, invalid.WithContext(ctx))
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "invalid_design_draft_limit") {
		t.Fatalf(
			"invalid limit status=%d body=%s",
			response.Code,
			response.Body.String(),
		)
	}
}

func TestCreateDesignDraftUsesCanonicalReplayHeader(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaign-template-designs",
		strings.NewReader(`{"mode":"generate","brief":"Weekly digest"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(idempotency.HeaderName, "create-design-1")
	ctx := middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "user-1", TenantID: "tenant-1", Role: "editor",
	})
	response := httptest.NewRecorder()
	(&Deps{
		Designs: &designDraftCreateReplayStoreStub{},
		Repo:    &Repo{},
	}).CreateDesignDraft(response, request.WithContext(ctx))
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get(idempotency.ReplayedHeaderName); got != "true" {
		t.Fatalf("%s=%q, want true", idempotency.ReplayedHeaderName, got)
	}
	if got := response.Header().Get(idempotency.LegacyReplayedHeaderName); got != "" {
		t.Fatalf("design handler emitted legacy replay header %q", got)
	}
}
