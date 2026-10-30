// SPDX-License-Identifier: MIT

package activecampaign

import (
	"strings"
	"testing"
	"time"

	adapter "github.com/postwave/migrate/adapter"
)

func TestFixedWindowDeltaCursorIsBoundToAccountAndDurableWatermark(t *testing.T) {
	ad := New()
	ad.now = func() time.Time { return mustParseTime(t, "2026-05-12T12:00:00Z") }
	since := mustParseTime(t, "2026-05-12T10:00:00Z")
	first := adapter.Session{Extra: map[string]string{"api_url": "http://127.0.0.1:41001/api/3"}}

	window, err := ad.newOrResumeDeltaCursor(first, since, "")
	if err != nil {
		t.Fatal(err)
	}
	window.LastContactID = 42
	raw, err := formatActiveCampaignDeltaCursor(window)
	if err != nil {
		t.Fatal(err)
	}

	resumed, err := ad.newOrResumeDeltaCursor(first, since, raw)
	if err != nil {
		t.Fatalf("resume same account/window: %v", err)
	}
	if resumed.LastContactID != 42 || !resumed.UpperBound.Equal(window.UpperBound) {
		t.Fatalf("resumed cursor changed fixed window: %+v", resumed)
	}

	second := adapter.Session{Extra: map[string]string{"api_url": "http://127.0.0.1:41002/api/3"}}
	if _, err := ad.newOrResumeDeltaCursor(second, since, raw); err == nil || !strings.Contains(err.Error(), "different ActiveCampaign account") {
		t.Fatalf("cross-account cursor error = %v", err)
	}
	if _, err := ad.newOrResumeDeltaCursor(first, since.Add(time.Minute), raw); err == nil || !strings.Contains(err.Error(), "durable replay watermark") {
		t.Fatalf("changed-watermark cursor error = %v", err)
	}
}
