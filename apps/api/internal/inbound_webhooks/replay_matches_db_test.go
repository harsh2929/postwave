// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestReplayHandlerAnswersMatchesAsArrayOnZeroMatchRetry drives the replay
// handler over the real repository.
//
// A replay that matched no trigger is frozen as the empty set, and a retry
// with the same Idempotency-Key reads that set back from the database — where
// a zero-row scan left `var matches []Match` nil, so the retry answered
// `"matches": null`. The web client rejects that ("Inbound replay response was
// malformed") because the contract is an array, and the retry no longer
// matched the first answer byte for byte.
func TestReplayHandlerAnswersMatchesAsArrayOnZeroMatchRetry(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping inbound replay handler database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	name := "replay-matches-" + randHex4IW(t)
	created, err := repo.Create(ctx, tenantID, name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupEndpoints(pool, tenantID, name) })
	key, _ := inboundWebhookReplayKey(http.Header{
		"X-Postwave-Event-Id": []string{"replay-matches-" + randHex4IW(t)},
	})
	eventID, _, _, err := repo.RecordEventWithActions(
		ctx, tenantID, created.Endpoint.ID,
		[]byte(`{}`), []byte(`{"status":"paid"}`), true, key, RecordEventOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}

	deps := &Deps{Repo: repo}
	replay := func() string {
		t.Helper()
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", created.Endpoint.ID)
		routeCtx.URLParams.Add("event_id", strconv.FormatInt(eventID, 10))
		reqCtx := middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
		reqCtx = context.WithValue(reqCtx, chi.RouteCtxKey, routeCtx)
		req := httptest.NewRequestWithContext(reqCtx, http.MethodPost,
			"/api/v1/inbound-webhooks/"+created.Endpoint.ID+"/events/"+strconv.FormatInt(eventID, 10)+"/replay", nil)
		req.Header.Set(idempotency.HeaderName, "zero-match-retry")
		rec := httptest.NewRecorder()
		deps.ReplayEvent(rec, req)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v body=%s", err, rec.Body.String())
		}
		if got := string(body["matches"]); got != "[]" {
			t.Fatalf("matches=%s, want [] (body=%s)", got, rec.Body.String())
		}
		return rec.Body.String()
	}

	first := replay()
	retry := replay()
	if first != retry {
		t.Fatalf("same-key retry changed the answer:\nfirst %s\nretry %s", first, retry)
	}
}
