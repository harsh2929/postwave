// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"errors"
	"testing"
	"time"
)

func TestTypeformRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := typeformBackfillRetryCursor("", "BACKFILL_FAILED", errors.New("boom"), now)
	retry, ok, err := decodeTypeformRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.After != "" {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
}

func TestFilloutRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := filloutBackfillRetryCursor("", "BACKFILL_FAILED", errors.New("boom"), now)
	retry, ok, err := decodeFilloutRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.Offset != 0 {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
}

func TestJotformRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := jotformBackfillRetryCursor("", "BACKFILL_FAILED", errors.New("boom"), now)
	retry, ok, err := decodeJotformRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.Offset != 0 {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
}

func TestWebflowRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := webflowBackfillRetryCursor("", "BACKFILL_FAILED", errors.New("boom"), now)
	retry, ok, err := decodeWebflowRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.Offset != 0 {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
}

func TestWixRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := wixBackfillRetryCursor("", "BACKFILL_FAILED", errors.New("boom"), now)
	retry, ok, err := decodeWixRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.Object != "" || retry.ProviderCursor != "" {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
}
