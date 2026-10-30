// SPDX-License-Identifier: AGPL-3.0-only

package notification_feed

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEncodeDecodeCursor_RoundTrips(t *testing.T) {
	at := time.Date(2026, 7, 26, 10, 30, 0, 123456000, time.UTC)
	id := "6f1b6d5a-6a3f-4a0f-9f6a-2b1d4c5e6f70"
	token := EncodeCursor(at, id)
	if token == "" {
		t.Fatal("EncodeCursor returned an empty token for a real row")
	}
	gotAt, gotID, err := decodeCursor(token)
	if err != nil {
		t.Fatalf("decodeCursor(%q): %v", token, err)
	}
	if !gotAt.Equal(at) || gotID != id {
		t.Fatalf("round trip = (%s,%q), want (%s,%q)", gotAt, gotID, at, id)
	}
}

func TestEncodeCursor_EmptyForMissingID(t *testing.T) {
	if got := EncodeCursor(time.Now(), ""); got != "" {
		t.Fatalf("EncodeCursor with no id = %q, want empty", got)
	}
}

func TestDecodeCursor_RejectsGarbage(t *testing.T) {
	cases := map[string]string{
		"not base64":      "!!!!not-base64!!!!",
		"no separator":    base64.RawURLEncoding.EncodeToString([]byte("1234567890")),
		"bad epoch":       base64.RawURLEncoding.EncodeToString([]byte("notanumber.6f1b6d5a-6a3f-4a0f-9f6a-2b1d4c5e6f70")),
		"non-uuid id":     base64.RawURLEncoding.EncodeToString([]byte("1750000000000000.'; DROP TABLE notification_feed --")),
		"short uuid":      base64.RawURLEncoding.EncodeToString([]byte("1750000000000000.6f1b6d5a")),
		"oversized token": string(make([]byte, 300)),
	}
	for name, raw := range cases {
		if _, _, err := decodeCursor(raw); !errors.Is(err, ErrInvalidCursor) {
			t.Errorf("%s: decodeCursor(%q) err = %v, want ErrInvalidCursor", name, raw, err)
		}
	}
}

func TestDecodeCursor_EmptyMeansFirstPage(t *testing.T) {
	at, id, err := decodeCursor("   ")
	if err != nil || !at.IsZero() || id != "" {
		t.Fatalf("decodeCursor(blank) = (%s,%q,%v), want zero values and no error", at, id, err)
	}
}

// A bad cursor is a CLIENT error. Before this change the only failure mode the
// handler had was httperror.WriteInternal, which is exactly the "500 with a
// bare message" the audit keeps finding.
func TestList_InvalidCursorIs422(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	rec := httptest.NewRecorder()
	d.List(rec, withSession(http.MethodGet, "/api/v1/notifications?cursor=%21%21%21"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if body.Error.Code != "invalid_cursor" || body.Error.Message == "" {
		t.Fatalf("error envelope = %+v, want code invalid_cursor with a message", body.Error)
	}
}

// The handler must reject the cursor BEFORE it reaches the pool, so a nil pool
// proves the rejection happens in the request-validation phase.
func TestList_InvalidCursorNeverTouchesThePool(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("invalid cursor reached the database layer: %v", r)
		}
	}()
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.List(rec, withSession(http.MethodGet, "/api/v1/notifications?cursor=zzzz~~~"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
}
