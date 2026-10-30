package contact_ratings

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSanitizeHistoryEvents_AllowsOnlyTypedRating(t *testing.T) {
	items := []HistoryEvent{
		{
			ID:   "known",
			Kind: "rating.changed",
			Payload: map[string]any{
				"rating":       float64(4),
				"email":        "private@example.test",
				"access_token": "secret-token",
				"nested":       map[string]any{"password": "secret"},
			},
		},
		{
			ID:   "unknown",
			Kind: "provider.sync\u202e",
			Payload: map[string]any{
				"api_key": strings.Repeat("secret", 20_000),
			},
		},
	}

	safe := sanitizeHistoryEvents(items)
	if got := safe[0].Payload; len(got) != 1 || got["rating"] != 4 {
		t.Fatalf("known payload = %#v, want only rating=4", got)
	}
	if got := safe[1].Payload; len(got) != 0 {
		t.Fatalf("unknown payload = %#v, want empty allowlist", got)
	}
	if items[0].Payload["access_token"] != "secret-token" {
		t.Fatal("sanitizer mutated the repository result in place")
	}
}

func TestHistoryCursorRoundTripPreservesTimestampTieBreaker(t *testing.T) {
	event := HistoryEvent{
		ID: uuid.MustParse("0199a4b5-8b67-7f10-9f11-0123456789ab").String(),
		At: "2026-07-19T10:11:12.123456Z",
	}
	cursor := encodeHistoryCursor(event)
	at, id, err := decodeHistoryCursor(cursor)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if at == nil {
		t.Fatalf("at = nil, want %s", event.At)
	}
	if got := at.Format(time.RFC3339Nano); got != event.At {
		t.Fatalf("at = %s, want %s", got, event.At)
	}
	if id == nil || id.String() != event.ID {
		t.Fatalf("id = %v, want %s", id, event.ID)
	}
}

func TestHistoryCursorRetainsLegacyTimestampAndRejectsHostileInputs(t *testing.T) {
	legacy := "2026-07-19T10:11:12.123456Z"
	at, id, err := decodeHistoryCursor(legacy)
	if err != nil || at == nil || id != nil {
		t.Fatalf("legacy decode = (%v, %v, %v)", at, id, err)
	}
	for _, raw := range []string{
		"not-a-cursor",
		"%%%%",
		strings.Repeat("A", historyCursorMaxBytes+1),
		encodeHistoryCursor(HistoryEvent{At: legacy, ID: "not-a-uuid"}),
		encodeHistoryCursor(HistoryEvent{At: "not-a-time", ID: uuid.NewString()}),
	} {
		if _, _, err := decodeHistoryCursor(raw); err == nil {
			t.Errorf("cursor %q unexpectedly accepted", raw)
		}
	}
}

func TestSanitizeHistoryPayload_FailsClosedForMalformedRatings(t *testing.T) {
	tests := []any{-1, 6, 1.5, "5", nil, map[string]any{"value": 5}}
	for _, value := range tests {
		if got := sanitizeHistoryPayload("rating.changed", map[string]any{
			"rating": value,
			"token":  "secret",
		}); len(got) != 0 {
			t.Errorf("rating %#v produced %#v, want empty payload", value, got)
		}
	}
}

func TestSanitizeHistoryPayload_RepresentsRatingClear(t *testing.T) {
	got := sanitizeHistoryPayload("rating.changed", map[string]any{"rating": 0})
	if len(got) != 1 || got["rating"] != 0 {
		t.Fatalf("clear payload = %#v, want rating=0", got)
	}
}
