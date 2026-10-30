// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type actorOwnershipStoreStub struct {
	DesignDraftStore
	owner        ReferenceReviewActor
	seenActor    ReferenceReviewActor
	archiveCalls int
}

func (store *actorOwnershipStoreStub) Get(
	_ context.Context,
	_ string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	store.seenActor = actor
	if actor.Type != store.owner.Type || actor.ID != store.owner.ID ||
		id != "design-private" {
		return nil, ErrDesignDraftNotFound
	}
	return &DesignDraft{
		ID:     id,
		Mode:   designDraftModeGenerate,
		Status: designDraftStatusQueued,
	}, nil
}

func (store *actorOwnershipStoreStub) Archive(
	_ context.Context,
	_ string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	store.seenActor = actor
	store.archiveCalls++
	if actor.Type != store.owner.Type || actor.ID != store.owner.ID ||
		id != "design-private" {
		return nil, ErrDesignDraftNotFound
	}
	return &DesignDraft{ID: id, Status: designDraftStatusArchived}, nil
}

func actorOwnershipRequest(
	method, target, actorID string,
) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: actorID, TenantID: "tenant-1", Role: "editor",
	})
	return request.WithContext(ctx)
}

func TestDesignDraftHandlersPassExactActorAndHideForeignIDs(t *testing.T) {
	store := &actorOwnershipStoreStub{
		owner: ReferenceReviewActor{Type: "user", ID: "owner-a"},
	}
	deps := &Deps{Designs: store}
	router := chi.NewRouter()
	router.Get(
		"/api/v1/campaign-template-designs/{id}",
		deps.GetDesignDraft,
	)
	router.Post(
		"/api/v1/campaign-template-designs/{id}/archive",
		deps.ArchiveDesignDraft,
	)

	foreignGet := httptest.NewRecorder()
	router.ServeHTTP(
		foreignGet,
		actorOwnershipRequest(
			http.MethodGet,
			"/api/v1/campaign-template-designs/design-private",
			"owner-b",
		),
	)
	if foreignGet.Code != http.StatusNotFound ||
		!strings.Contains(
			foreignGet.Body.String(),
			`"code":"design_draft_not_found"`,
		) {
		t.Fatalf(
			"foreign get status=%d body=%s",
			foreignGet.Code,
			foreignGet.Body.String(),
		)
	}
	if store.seenActor.Type != "user" || store.seenActor.ID != "owner-b" {
		t.Fatalf("get actor=%#v, want exact authenticated user", store.seenActor)
	}

	foreignArchiveRequest := actorOwnershipRequest(
		http.MethodPost,
		"/api/v1/campaign-template-designs/design-private/archive",
		"owner-b",
	)
	foreignArchiveRequest.Header.Set("Idempotency-Key", "foreign-archive")
	foreignArchive := httptest.NewRecorder()
	router.ServeHTTP(foreignArchive, foreignArchiveRequest)
	if foreignArchive.Code != http.StatusNotFound ||
		foreignArchive.Body.String() != foreignGet.Body.String() {
		t.Fatalf(
			"foreign archive=(%d,%s), want same nondisclosing 404 as get (%d,%s)",
			foreignArchive.Code,
			foreignArchive.Body.String(),
			foreignGet.Code,
			foreignGet.Body.String(),
		)
	}
	if store.archiveCalls != 1 ||
		store.seenActor.Type != "user" ||
		store.seenActor.ID != "owner-b" {
		t.Fatalf(
			"archive calls=%d actor=%#v",
			store.archiveCalls,
			store.seenActor,
		)
	}

	ownerGet := httptest.NewRecorder()
	router.ServeHTTP(
		ownerGet,
		actorOwnershipRequest(
			http.MethodGet,
			"/api/v1/campaign-template-designs/design-private",
			"owner-a",
		),
	)
	if ownerGet.Code != http.StatusOK ||
		!strings.Contains(ownerGet.Body.String(), `"id":"design-private"`) {
		t.Fatalf(
			"owner get status=%d body=%s",
			ownerGet.Code,
			ownerGet.Body.String(),
		)
	}
}
