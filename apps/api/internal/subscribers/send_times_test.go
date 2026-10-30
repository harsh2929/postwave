// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// SUB-066: the send-times handler requires tenant context → 401, without
// touching the DB.
func TestGetSendTimes_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.GetSendTimes(rec, httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/abc/send-times", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without tenant", rec.Code)
	}
}

// SUB-066: deriveDowHod splits a 0-167 hour-of-week into (dow, hod) and
// returns (nil, nil) for a nil/un-computed value.
func TestDeriveDowHod(t *testing.T) {
	if dow, hod := deriveDowHod(nil); dow != nil || hod != nil {
		t.Fatalf("nil input should yield (nil,nil), got (%v,%v)", dow, hod)
	}
	cases := []struct {
		h       int
		wantDow int
		wantHod int
	}{
		{0, 0, 0},    // Sunday 00:00
		{9, 0, 9},    // Sunday 09:00
		{24, 1, 0},   // Monday 00:00
		{33, 1, 9},   // Monday 09:00
		{167, 6, 23}, // Saturday 23:00
	}
	for _, c := range cases {
		h := c.h
		dow, hod := deriveDowHod(&h)
		if dow == nil || hod == nil {
			t.Fatalf("deriveDowHod(%d) returned nil", c.h)
		}
		if *dow != c.wantDow || *hod != c.wantHod {
			t.Errorf("deriveDowHod(%d) = (%d,%d), want (%d,%d)", c.h, *dow, *hod, c.wantDow, c.wantHod)
		}
	}
}

// SUB-066: deriveDowHod clamps out-of-range values defensively instead of
// producing a nonsensical day index.
func TestDeriveDowHodClamps(t *testing.T) {
	neg := -5
	dow, hod := deriveDowHod(&neg)
	if *dow != 0 || *hod != 0 {
		t.Errorf("negative clamp = (%d,%d), want (0,0)", *dow, *hod)
	}
	big := 500
	dow, hod = deriveDowHod(&big)
	if *dow != 6 || *hod != 23 {
		t.Errorf("over-range clamp = (%d,%d), want (6,23)", *dow, *hod)
	}
}
