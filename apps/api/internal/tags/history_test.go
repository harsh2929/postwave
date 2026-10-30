package tags

import (
	"testing"
	"time"
)

func TestHistoryCursorRoundTripPreservesTieBreaker(t *testing.T) {
	t.Parallel()
	want := HistoryRow{
		ID:         "5c981ba0-8591-4c4e-b21a-88f4e4a0dd9b",
		OccurredAt: time.Date(2026, 7, 19, 6, 0, 0, 123, time.UTC),
	}
	encoded := encodeHistoryCursor(want)
	got, err := decodeHistoryCursor(encoded)
	if err != nil {
		t.Fatalf("decodeHistoryCursor: %v", err)
	}
	if got.ID != want.ID || !got.OccurredAt.Equal(want.OccurredAt) {
		t.Fatalf("decoded cursor = %#v, want id=%s occurred_at=%s", got, want.ID, want.OccurredAt)
	}
}

func TestHistoryCursorAcceptsLegacyTimestampWithoutDroppingTieCohort(t *testing.T) {
	t.Parallel()
	want := time.Date(2026, 7, 19, 6, 0, 0, 123, time.UTC)
	got, err := decodeHistoryCursor(want.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatalf("decodeHistoryCursor legacy: %v", err)
	}
	if got.ID != maxUUID || !got.OccurredAt.Equal(want) {
		t.Fatalf("legacy cursor = %#v, want max UUID tie breaker at %s", got, want)
	}
}

func TestHistoryCursorRejectsMalformedValues(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"not-a-cursor", "e30", "eyJvY2N1cnJlZF9hdCI6IjIwMjYtMDctMTlUMDY6MDA6MDBaIiwiaWQiOiJub3QtYS11dWlkIn0"} {
		if _, err := decodeHistoryCursor(value); err == nil {
			t.Errorf("decodeHistoryCursor(%q) unexpectedly succeeded", value)
		}
	}
}
