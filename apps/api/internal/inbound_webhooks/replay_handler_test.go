// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type recordingReplayAdminRepository struct {
	replayIDs []string
	matches   []Match
	err       error
}

func (r *recordingReplayAdminRepository) QueueReplayWithID(
	_ context.Context,
	_, _ string,
	_ int64,
	replayID string,
) (string, []Match, error) {
	r.replayIDs = append(r.replayIDs, replayID)
	return replayID, r.matches, r.err
}

func replayHandlerRequestFor(
	webhookID string,
	eventID string,
	headerValues ...string,
) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant-a"})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", webhookID)
	routeCtx.URLParams.Add("event_id", eventID)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, routeCtx)
	req := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/api/v1/inbound-webhooks/"+webhookID+"/events/"+eventID+"/replay",
		nil,
	)
	if headerValues != nil {
		req.Header[idempotency.HeaderName] = headerValues
	}
	return req
}

func replayHandlerRequest(headerValues ...string) *http.Request {
	return replayHandlerRequestFor(
		"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		"42",
		headerValues...,
	)
}

func TestReplayHandlerRequiresOneBoundedIdempotencyKey(t *testing.T) {
	tests := []struct {
		name   string
		values []string
		code   string
	}{
		{name: "missing", code: "idempotency_key_required"},
		{name: "blank", values: []string{"   "}, code: "idempotency_key_required"},
		{name: "multiple", values: []string{"one", "two"}, code: "invalid_idempotency_key"},
		{
			name:   "oversized",
			values: []string{strings.Repeat("k", idempotency.MaxKeyLength+1)},
			code:   "invalid_idempotency_key",
		},
		{name: "control", values: []string{"bad\nkey"}, code: "invalid_idempotency_key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &recordingReplayAdminRepository{}
			deps := &Deps{replayAdminRepo: repo}
			rec := httptest.NewRecorder()

			deps.ReplayEvent(rec, replayHandlerRequest(tt.values...))

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if len(repo.replayIDs) != 0 {
				t.Fatalf("invalid request reached repository: %#v", repo.replayIDs)
			}
			if !strings.Contains(rec.Body.String(), `"`+tt.code+`"`) {
				t.Fatalf("body = %s, want code %q", rec.Body.String(), tt.code)
			}
		})
	}
}

func TestReplayHandlerDerivesStableResourceBoundReceipt(t *testing.T) {
	repo := &recordingReplayAdminRepository{matches: []Match{}}
	deps := &Deps{replayAdminRepo: repo}

	invoke := func(key string) (int, string, string) {
		t.Helper()
		req := replayHandlerRequest(key)
		rec := httptest.NewRecorder()
		deps.ReplayEvent(rec, req)
		var body struct {
			ReplayID string `json:"replay_id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
		}
		return rec.Code, rec.Body.String(), body.ReplayID
	}

	status1, body1, replayID1 := invoke("operator-click-1")
	status2, body2, replayID2 := invoke("operator-click-1")
	if status1 != http.StatusAccepted || status2 != http.StatusAccepted {
		t.Fatalf("statuses = %d/%d, want 202/202", status1, status2)
	}
	if replayID1 == "" || replayID1 != replayID2 {
		t.Fatalf("same-key replay ids = %q/%q", replayID1, replayID2)
	}
	if body1 != body2 {
		t.Fatalf("same-key response changed:\nfirst %s\nsecond %s", body1, body2)
	}

	var variantBody struct {
		ReplayID string `json:"replay_id"`
	}
	variantRecorder := httptest.NewRecorder()
	deps.ReplayEvent(
		variantRecorder,
		replayHandlerRequestFor(
			"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
			"00042",
			"operator-click-1",
		),
	)
	if err := json.Unmarshal(variantRecorder.Body.Bytes(), &variantBody); err != nil {
		t.Fatalf("decode canonical-source retry: %v", err)
	}
	if variantRecorder.Code != http.StatusAccepted ||
		variantBody.ReplayID != replayID1 {
		t.Fatalf(
			"alternate integer spelling changed replay identity: status=%d replay=%q want=%q",
			variantRecorder.Code,
			variantBody.ReplayID,
			replayID1,
		)
	}

	_, _, replayID3 := invoke("operator-click-2")
	if replayID3 == "" || replayID3 == replayID1 {
		t.Fatalf("different-key replay ids = %q/%q, want distinct", replayID1, replayID3)
	}
	if len(repo.replayIDs) != 4 ||
		repo.replayIDs[0] != repo.replayIDs[1] ||
		repo.replayIDs[2] != repo.replayIDs[0] ||
		repo.replayIDs[3] == repo.replayIDs[0] {
		t.Fatalf("repository replay ids = %#v", repo.replayIDs)
	}
}

func TestReplayHandlerRejectsUnverifiedEvent(t *testing.T) {
	t.Parallel()

	repo := &recordingReplayAdminRepository{err: ErrUnverifiedEvent}
	rec := httptest.NewRecorder()
	(&Deps{replayAdminRepo: repo}).ReplayEvent(rec, replayHandlerRequest("operator-click"))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"event_not_verified"`) {
		t.Fatalf("body = %s, want event_not_verified", rec.Body.String())
	}
	if len(repo.replayIDs) != 1 {
		t.Fatalf("repository calls = %d, want 1", len(repo.replayIDs))
	}
}
