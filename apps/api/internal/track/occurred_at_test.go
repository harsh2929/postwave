// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestNormalizeTrackOccurredAtUsesOneFrozenNowAndAllowsHistoricalBackfill(t *testing.T) {
	t.Parallel()

	serverNow := time.Date(2026, time.July, 24, 12, 30, 0, 987654321, time.FixedZone("IST", 5*60*60+30*60))
	wantNow := serverNow.UTC()

	got, err := normalizeTrackOccurredAt(nil, serverNow)
	if err != nil {
		t.Fatalf("default occurred_at: %v", err)
	}
	if !got.Equal(wantNow) || got.Location() != time.UTC {
		t.Fatalf("default occurred_at = %s (%s), want frozen UTC %s", got, got.Location(), wantNow)
	}

	historical := serverNow.AddDate(-5, 0, 0)
	got, err = normalizeTrackOccurredAt(&historical, serverNow)
	if err != nil {
		t.Fatalf("historical backfill rejected: %v", err)
	}
	if !got.Equal(historical.UTC()) || got.Location() != time.UTC {
		t.Fatalf("historical occurred_at = %s (%s), want %s UTC", got, got.Location(), historical.UTC())
	}
}

func TestNormalizeTrackOccurredAtEnforcesFiveMinuteFutureSkewBoundary(t *testing.T) {
	t.Parallel()

	if trackOccurredAtFutureSkewAllowance != 5*time.Minute {
		t.Fatalf(
			"future skew allowance = %s, want documented 5m",
			trackOccurredAtFutureSkewAllowance,
		)
	}
	serverNow := time.Date(2026, time.July, 24, 12, 0, 0, 0, time.UTC)
	atBoundary := serverNow.Add(trackOccurredAtFutureSkewAllowance)
	got, err := normalizeTrackOccurredAt(&atBoundary, serverNow)
	if err != nil {
		t.Fatalf("timestamp at allowance boundary rejected: %v", err)
	}
	if !got.Equal(atBoundary) {
		t.Fatalf("boundary occurred_at = %s, want %s", got, atBoundary)
	}

	tooFar := atBoundary.Add(time.Nanosecond)
	if _, err := normalizeTrackOccurredAt(&tooFar, serverNow); err == nil {
		t.Fatal("timestamp beyond allowance boundary was accepted")
	}
}

func TestTrackRejectsExcessiveFutureOccurredAtBeforeRepositoryOrFanout(t *testing.T) {
	t.Parallel()

	future := time.Now().UTC().Add(10 * time.Minute)
	body, err := json.Marshal(TrackInput{
		Email:      "subscriber@example.test",
		EventName:  "checkout.completed",
		OccurredAt: &future,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Repo and all fan-out dependencies are deliberately nil. A stable 400
	// response proves the future timestamp is rejected before identity lookup,
	// persistence, or any downstream automation path.
	deps := &Deps{}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/track", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: "tenant-1"},
	))
	recorder := httptest.NewRecorder()

	deps.Track(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%q", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"occurred_at_too_far_future"`) {
		t.Fatalf("body = %q, want stable occurred_at_too_far_future code", recorder.Body.String())
	}
}
