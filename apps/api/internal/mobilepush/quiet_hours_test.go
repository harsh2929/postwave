// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func at(t *testing.T, zone, stamp string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatalf("LoadLocation(%q): %v", zone, err)
	}
	parsed, err := time.ParseInLocation("2006-01-02 15:04", stamp, loc)
	if err != nil {
		t.Fatalf("ParseInLocation(%q): %v", stamp, err)
	}
	return parsed.UTC()
}

func TestQuietHoursActive_WindowSemantics(t *testing.T) {
	overnight := quietHoursSettings{Enabled: true, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: "Europe/Berlin"}
	sameDay := quietHoursSettings{Enabled: true, StartMinute: 9 * 60, EndMinute: 17 * 60, Timezone: "Europe/Berlin"}
	wholeDay := quietHoursSettings{Enabled: true, StartMinute: 0, EndMinute: 0, Timezone: "Europe/Berlin"}

	cases := []struct {
		name  string
		q     quietHoursSettings
		now   time.Time
		quiet bool
	}{
		{"overnight just after start", overnight, at(t, "Europe/Berlin", "2026-07-26 21:00"), true},
		{"overnight at midnight", overnight, at(t, "Europe/Berlin", "2026-07-27 00:30"), true},
		{"overnight just before end", overnight, at(t, "Europe/Berlin", "2026-07-27 08:59"), true},
		{"overnight at end is open", overnight, at(t, "Europe/Berlin", "2026-07-27 09:00"), false},
		{"overnight mid-afternoon", overnight, at(t, "Europe/Berlin", "2026-07-27 15:00"), false},
		{"overnight one minute before start", overnight, at(t, "Europe/Berlin", "2026-07-26 20:59"), false},
		{"same-day inside", sameDay, at(t, "Europe/Berlin", "2026-07-27 12:00"), true},
		{"same-day at start", sameDay, at(t, "Europe/Berlin", "2026-07-27 09:00"), true},
		{"same-day at end is open", sameDay, at(t, "Europe/Berlin", "2026-07-27 17:00"), false},
		{"same-day before start", sameDay, at(t, "Europe/Berlin", "2026-07-27 08:00"), false},
		{"whole day", wholeDay, at(t, "Europe/Berlin", "2026-07-27 13:37"), true},
	}
	for _, tc := range cases {
		if got := quietHoursActive(tc.now, tc.q); got != tc.quiet {
			t.Errorf("%s: quietHoursActive = %v, want %v", tc.name, got, tc.quiet)
		}
	}
}

// The window is evaluated in the DEVICE's zone, not the server's. The same
// instant is quiet in Berlin and not quiet in Los Angeles.
func TestQuietHoursActive_UsesTheDeviceTimezone(t *testing.T) {
	instant := at(t, "Europe/Berlin", "2026-07-27 23:30") // 14:30 in Los Angeles
	berlin := quietHoursSettings{Enabled: true, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: "Europe/Berlin"}
	losAngeles := berlin
	losAngeles.Timezone = "America/Los_Angeles"
	if !quietHoursActive(instant, berlin) {
		t.Fatal("23:30 Berlin should be inside a 21:00-09:00 Berlin window")
	}
	if quietHoursActive(instant, losAngeles) {
		t.Fatal("the same instant is 14:30 in Los Angeles and must not be quiet")
	}
}

// Fail OPEN. A misconfigured window must degrade to a delivered notification,
// never to a handset that silently stops receiving approval requests.
func TestQuietHoursActive_FailsOpenOnBadConfiguration(t *testing.T) {
	now := at(t, "UTC", "2026-07-27 02:00")
	cases := map[string]quietHoursSettings{
		"disabled":       {Enabled: false, StartMinute: 0, EndMinute: 1439, Timezone: "UTC"},
		"empty timezone": {Enabled: true, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: ""},
		"unknown zone":   {Enabled: true, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: "Mars/Olympus"},
		"start too big":  {Enabled: true, StartMinute: 5000, EndMinute: 9 * 60, Timezone: "UTC"},
		"negative end":   {Enabled: true, StartMinute: 60, EndMinute: -1, Timezone: "UTC"},
	}
	for name, q := range cases {
		if quietHoursActive(now, q) {
			t.Errorf("%s: window fired; a malformed/disabled window must fail open", name)
		}
	}
}

func TestQuietHoursBypassIsLimitedToNewDeviceSignIn(t *testing.T) {
	if !bypassesQuietHours("auth.new_device_sign_in") {
		t.Fatal("new-device security alert did not bypass quiet hours")
	}
	for event := range allowedDeviceEvents {
		if event == "auth.new_device_sign_in" {
			continue
		}
		if bypassesQuietHours(event) {
			t.Fatalf("routine event %q unexpectedly bypasses quiet hours", event)
		}
	}
	for _, unknown := range []string{"", "auth.new_device_sign_in.extra", "security.alert"} {
		if bypassesQuietHours(unknown) {
			t.Fatalf("unknown event %q unexpectedly bypasses quiet hours", unknown)
		}
	}
}

func TestApplyQuietHoursInput_PatchSemanticsAndValidation(t *testing.T) {
	current := quietHoursSettings{Enabled: false, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: "UTC"}

	enabled := true
	only, msg := applyQuietHoursInput(current, quietHoursRequest{Enabled: &enabled})
	if msg != "" {
		t.Fatalf("enabling alone was rejected: %s", msg)
	}
	if !only.Enabled || only.StartMinute != 21*60 || only.EndMinute != 9*60 || only.Timezone != "UTC" {
		t.Fatalf("enabling alone changed the window: %#v", only)
	}
	if only.StartLocal != "21:00" || only.EndLocal != "09:00" {
		t.Fatalf("HH:MM projections = %q/%q", only.StartLocal, only.EndLocal)
	}

	startLocal, endLocal, zone := "22:30", "07:15", "Asia/Tokyo"
	byLabel, msg := applyQuietHoursInput(current, quietHoursRequest{
		StartLocal: &startLocal, EndLocal: &endLocal, Timezone: &zone,
	})
	if msg != "" {
		t.Fatalf("HH:MM input rejected: %s", msg)
	}
	if byLabel.StartMinute != 22*60+30 || byLabel.EndMinute != 7*60+15 || byLabel.Timezone != "Asia/Tokyo" {
		t.Fatalf("HH:MM input = %#v", byLabel)
	}

	bad := -1
	tooBig := 1440
	badLabel := "9am"
	badZone := "Mars/Olympus"
	longZone := strings.Repeat("z", maxTimezoneLength+1)
	for name, in := range map[string]quietHoursRequest{
		"negative start": {StartMinute: &bad},
		"end past 1439":  {EndMinute: &tooBig},
		"bad start label": {
			StartLocal: &badLabel,
		},
		"unknown zone":   {Timezone: &badZone},
		"oversized zone": {Timezone: &longZone},
	} {
		if _, msg := applyQuietHoursInput(current, in); msg == "" {
			t.Errorf("%s: invalid input was accepted", name)
		}
	}
}

func TestMinuteOfDay(t *testing.T) {
	for raw, want := range map[string]int{"00:00": 0, "09:05": 545, "23:59": 1439} {
		got, ok := minuteOfDay(raw)
		if !ok || got != want {
			t.Errorf("minuteOfDay(%q) = (%d,%v), want (%d,true)", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "9:00", "24:00", "12:60", "12-00", "aa:bb"} {
		if _, ok := minuteOfDay(raw); ok {
			t.Errorf("minuteOfDay(%q) accepted an invalid label", raw)
		}
	}
}

func TestSetQuietHours_RequiresSessionAndValidKey(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	d.SetQuietHours(rec, httptest.NewRequest(http.MethodPost, "/api/v1/mobile/push/devices/quiet-hours",
		strings.NewReader(`{"device_key":"`+strings.Repeat("ab", 32)+`"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status without a session = %d, want 401", rec.Code)
	}

	// With a session but a malformed key the handler must 422 before it ever
	// reaches the pool (which is nil here — a DB call would panic).
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mobile/push/devices/quiet-hours",
		strings.NewReader(`{"device_key":"nope"}`))
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "22222222-2222-4222-8222-222222222222"})
	d = &Deps{Pool: nil}
	d.SetQuietHours(rec, req.WithContext(ctx))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status with no pool = %d, want 503", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code == "" {
		t.Fatalf("error envelope = %s (err %v)", rec.Body.String(), err)
	}
}
